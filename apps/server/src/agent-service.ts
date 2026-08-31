import { randomUUID } from "node:crypto";
import path from "node:path";
import type { AppConfig } from "./config.js";
import { isArkConfigured, readPinnedCodexVersion } from "./config.js";
import { ContainerRemovalUnverifiedError } from "./container-codex-runner.js";
import { DelegatedCodexHomeManager } from "./delegated-codex-home.js";
import { HttpError, RunCancelledError } from "./errors.js";
import type { RuntimeActionFirewall } from "./runtime-action-firewall.js";
import { JsonStore } from "./store.js";
import {
  DEPARTMENTS,
  type Agent,
  type AgentRun,
  type AgentRunner,
  type CreateAgentInput,
  type Database,
  type DelegationContract,
  type Department,
  type Message,
  type RuntimeAuthorizationContext,
  type RuntimeBlocker,
  type SystemInfo,
  type UpdateAgentInput,
} from "./types.js";
import { runtimeWorkspaceStateId, WorkspaceManager } from "./workspace.js";
import type { DelegatedWorkspaceInput } from "./workspace.js";

const now = () => new Date().toISOString();

export class AgentService {
  private readonly activeExecutions = new Map<string, Promise<void>>();
  private readonly cancellationRequests = new Set<string>();
  private readonly delegatedCodexHomes: DelegatedCodexHomeManager;

  constructor(
    private readonly config: AppConfig,
    private readonly store: JsonStore,
    private readonly workspaces: WorkspaceManager,
    private readonly runner: AgentRunner,
    private readonly runtimeFirewall?: RuntimeActionFirewall,
  ) {
    this.delegatedCodexHomes = new DelegatedCodexHomeManager(
      config.dataDirectory,
      config.codexHome,
    );
  }

  async initialize(): Promise<void> {
    await this.store.initialize();
    await this.workspaces.initialize();
    await this.delegatedCodexHomes.initialize();
    if (
      this.config.runtimeProvider === "container" &&
      this.runner.removeStaleContainers
    ) {
      await this.runner.removeStaleContainers();
      const cleanupOutcomes = await Promise.allSettled([
        this.workspaces.cleanupStaleDelegatedRunWorkspaces(),
        this.delegatedCodexHomes.cleanupStale(),
      ]);
      const cleanupFailures = cleanupOutcomes
        .filter(
          (outcome): outcome is PromiseRejectedResult =>
            outcome.status === "rejected",
        )
        .map((outcome) => outcome.reason);
      if (cleanupFailures.length > 0) {
        throw new AggregateError(
          cleanupFailures,
          "Stale delegated data could not be safely removed after Runtime recovery",
        );
      }
    }
    const agentsBeforeProfileMigration = this.store.snapshot().agents;
    for (const department of DEPARTMENTS) {
      await this.workspaces.ensureProfile(this.workspaces.profile(department));
    }
    const ownersByLegacyWorkspace = new Map<string, Set<string>>();
    for (const agent of agentsBeforeProfileMigration) {
      const workspaceKey = normalizedWorkspaceKey(agent.workspacePath);
      const owners = ownersByLegacyWorkspace.get(workspaceKey) ?? new Set<string>();
      owners.add(agent.ownerId);
      ownersByLegacyWorkspace.set(workspaceKey, owners);
    }
    const importedLegacyWorkspaces = new Set<string>();
    for (const agent of agentsBeforeProfileMigration) {
      await this.workspaces.ensureOwnerWorkspace(
        this.workspaces.profile(agent.department),
        agent.ownerId,
      );
      const workspaceKey = normalizedWorkspaceKey(agent.workspacePath);
      const owners = ownersByLegacyWorkspace.get(workspaceKey);
      if (owners?.size === 1 && !importedLegacyWorkspaces.has(workspaceKey)) {
        await this.workspaces.importLegacyWorkspace(
          agent,
          this.workspaces.profile(agent.department),
        );
        importedLegacyWorkspaces.add(workspaceKey);
      }
    }
    await this.store.mutate((database) => {
      const timestamp = now();
      for (const department of DEPARTMENTS) {
        const profile = this.workspaces.profile(department);
        const existingProfile = database.workspaceProfiles.find(
          (item) => item.id === profile.id,
        );
        if (existingProfile) {
          existingProfile.department = department;
          existingProfile.workspacePath = profile.workspacePath;
          existingProfile.updatedAt = timestamp;
        } else {
          database.workspaceProfiles.push(profile);
        }
      }
      for (const run of database.runs) {
        if (run.status === "queued" || run.status === "running") {
          run.status = "cancelled";
          run.error = "Server restarted while this run was active";
          run.completedAt = now();
        }
      }
      for (const agent of database.agents) {
        // The role profile remains shared metadata, while writable files are
        // isolated by exact owner within that role.
        agent.workspacePath = this.workspaces.ownerWorkspacePath(
          agent.department,
          agent.ownerId,
        );
        agent.updatedAt = timestamp;
        if (agent.status === "busy") {
          agent.status = "ready";
          agent.updatedAt = now();
        }
      }
    });
  }

  async shutdown(): Promise<void> {
    const activeAgentIds = [...this.activeExecutions.keys()];
    if (activeAgentIds.length === 0) return;
    await this.store.mutate((database) => {
      const timestamp = now();
      for (const agent of database.agents) {
        if (!activeAgentIds.includes(agent.id)) continue;
        agent.status = "stopped";
        agent.updatedAt = timestamp;
      }
    });
    const outcomes = await Promise.allSettled(
      activeAgentIds.map((agentId) => this.cancelExecution(agentId)),
    );
    const failures = outcomes
      .filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected")
      .map((outcome) => outcome.reason);
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "One or more Runtime containers could not be proven stopped",
      );
    }
  }

  listAgents(ownerId?: string): Agent[] {
    const agents = this.store.snapshot().agents;
    return agents
      .filter((agent) => ownerId === undefined || agent.ownerId === ownerId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  listAgentsByOwner(ownerId: string): Agent[] {
    return this.store
      .snapshot()
      .agents.filter((agent) => agent.ownerId === ownerId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  getAgent(id: string): Agent {
    const agent = this.store.snapshot().agents.find((item) => item.id === id);
    if (!agent) {
      throw new HttpError(404, "Agent not found");
    }
    return agent;
  }

  async createAgent(
    ownerId: string,
    department: Department,
    input: CreateAgentInput,
  ): Promise<Agent> {
    const timestamp = now();
    const id = randomUUID();
    const profile = this.workspaces.profile(department);
    await this.workspaces.ensureProfile(profile);
    const ownerWorkspacePath = await this.workspaces.ensureOwnerWorkspace(
      profile,
      ownerId,
    );
    const agent: Agent = {
      id,
      department,
      workspaceProfileId: profile.id,
      ownerId,
      name: input.name.trim(),
      description: input.description?.trim() ?? "",
      instructions: input.instructions?.trim() ?? "",
      status: "ready",
      revokedAt: null,
      workspacePath: ownerWorkspacePath,
      codexThreadId: null,
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.store.mutate((database) => {
      if (!database.workspaceProfiles.some((item) => item.id === profile.id)) {
        database.workspaceProfiles.push(profile);
      }
      database.agents.push(agent);
    });
    return agent;
  }

  async updateAgent(id: string, input: UpdateAgentInput): Promise<Agent> {
    const current = this.getAgent(id);
    if (current.status === "busy") {
      throw new HttpError(409, "Stop the active run before editing this Agent");
    }
    const updated = await this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) {
        throw new HttpError(404, "Agent not found");
      }
      if (agent.status === "busy") {
        throw new HttpError(409, "Stop the active run before editing this Agent");
      }
      if (input.name !== undefined) agent.name = input.name.trim();
      if (input.description !== undefined) agent.description = input.description.trim();
      if (input.instructions !== undefined) agent.instructions = input.instructions.trim();
      agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
    await this.workspaces.writeInstructions(updated);
    return updated;
  }

  async deleteAgent(id: string): Promise<{ archivedWorkspace: string }> {
    const agent = this.getAgent(id);
    await this.setStatus(id, "stopped");
    await this.cancelExecution(id);
    const archivedWorkspace = agent.workspacePath;
    await this.store.mutate((database) => {
      database.agents = database.agents.filter((item) => item.id !== id);
      database.messages = database.messages.filter((item) => item.agentId !== id);
      const delegatedRunIds = new Set(
        database.delegationContracts
          .filter((contract) => contract.agentId === id && contract.runId !== null)
          .map((contract) => contract.runId!),
      );
      database.runs = database.runs.filter(
        (item) => item.agentId !== id || delegatedRunIds.has(item.id),
      );
    });
    return { archivedWorkspace };
  }

  async startAgent(id: string): Promise<Agent> {
    this.assertNotRevoked(this.getAgent(id));
    return this.setStatus(id, "ready");
  }

  async stopAgent(id: string): Promise<Agent> {
    this.getAgent(id);
    await this.setStatus(id, "stopped");
    await this.cancelExecution(id);
    return this.getAgent(id);
  }

  async revokeAgent(id: string): Promise<Agent> {
    const agent = this.getAgent(id);
    if (agent.revokedAt) return agent;
    await this.store.mutate((database) => {
      const storedAgent = database.agents.find((item) => item.id === id);
      if (!storedAgent) throw new HttpError(404, "Agent not found");
      if (storedAgent.revokedAt) return structuredClone(storedAgent);
      const timestamp = now();
      storedAgent.revokedAt = timestamp;
      storedAgent.status = "stopped";
      storedAgent.lastError = null;
      storedAgent.updatedAt = timestamp;
      return structuredClone(storedAgent);
    });
    await this.cancelExecution(id);
    return this.getAgent(id);
  }

  getMessages(agentId: string): Message[] {
    this.getAgent(agentId);
    return this.store
      .snapshot()
      .messages.filter((message) => message.agentId === agentId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  getRun(runId: string): AgentRun {
    const run = this.store.snapshot().runs.find((item) => item.id === runId);
    if (!run) {
      throw new HttpError(404, "Run not found");
    }
    return run;
  }

  getRuns(agentId: string): AgentRun[] {
    this.getAgent(agentId);
    return this.store
      .snapshot()
      .runs.filter((run) => run.agentId === agentId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async sendMessage(
    agentId: string,
    prompt: string,
    runtimeAuthorization?: RuntimeAuthorizationContext,
  ): Promise<{ run: AgentRun; message: Message }> {
    await this.assertExecutionReady();
    const agent = this.getAgent(agentId);
    this.assertNotRevoked(agent);
    if (this.runtimeFirewall) {
      if (!runtimeAuthorization) {
        throw new HttpError(
          503,
          "Runtime authorization context is required before Agent execution",
          { code: "RUNTIME_AUTHORIZATION_CONTEXT_REQUIRED" },
        );
      }
      await this.runtimeFirewall.authorize(agent, prompt, runtimeAuthorization);
    }
    const timestamp = now();
    const runId = randomUUID();
    const run: AgentRun = {
      id: runId,
      agentId,
      status: "queued",
      prompt,
      output: null,
      error: null,
      usage: null,
      startedAt: null,
      completedAt: null,
      createdAt: timestamp,
    };
    const message: Message = {
      id: randomUUID(),
      agentId,
      runId,
      role: "user",
      content: prompt,
      createdAt: timestamp,
    };
    const agentAtStart = await this.store.mutate((database) => {
      const storedAgent = database.agents.find((item) => item.id === agentId);
      if (!storedAgent) {
        throw new HttpError(404, "Agent not found");
      }
      this.assertNotRevoked(storedAgent);
      if (storedAgent.status === "stopped") {
        throw new HttpError(409, "Start the Agent before sending a message");
      }
      if (storedAgent.status === "busy") {
        throw new HttpError(409, "This Agent is already running");
      }
      const profileBusy = database.runs.some((candidate) => {
        if (candidate.status !== "queued" && candidate.status !== "running") return false;
        const candidateAgent = database.agents.find((item) => item.id === candidate.agentId);
        return candidateAgent?.workspaceProfileId === storedAgent.workspaceProfileId &&
          candidateAgent.ownerId === storedAgent.ownerId;
      });
      if (profileBusy) {
        throw new HttpError(
          409,
          "Another Agent is using this owner's role workspace",
        );
      }
      database.runs.push(run);
      database.messages.push(message);
      const snapshot = structuredClone(storedAgent);
      storedAgent.status = "busy";
      storedAgent.lastError = null;
      storedAgent.updatedAt = timestamp;
      return snapshot;
    });
    const execution = this.executeRun(agentAtStart, run);
    this.activeExecutions.set(agentId, execution);
    void execution
      .finally(() => {
        if (this.activeExecutions.get(agentId) === execution) {
          this.activeExecutions.delete(agentId);
        }
      })
      .catch(() => undefined);
    return { run, message };
  }

  async sendDelegatedMessage(input: {
    contractId: string;
    granteeHumanId: string;
    prompt: string;
    promptDigest: string;
    loadApprovedInputs: () => Promise<DelegatedWorkspaceInput[]>;
    runtimeAuthorization: RuntimeAuthorizationContext;
    onAuthorized: (
      contract: DelegationContract,
      run: AgentRun,
      agent: Agent,
    ) => Promise<void>;
    commitAuthorizationEvidence?: (
      database: Database,
      contract: DelegationContract,
      run: AgentRun,
      agent: Agent,
    ) => boolean;
  }): Promise<{ run: AgentRun; contract: DelegationContract }> {
    if (this.config.runtimeProvider !== "container") {
      throw new HttpError(
        503,
        "Delegated Runs require the isolated container Runtime",
        { code: "DELEGATED_RUNTIME_ISOLATION_REQUIRED" },
      );
    }
    await this.assertExecutionReady();
    const initialContract = this.store
      .snapshot()
      .delegationContracts.find((candidate) => candidate.id === input.contractId);
    if (!initialContract || initialContract.granteeHumanId !== input.granteeHumanId) {
      throw new HttpError(404, "Approved task not found");
    }
    const agent = this.getAgent(initialContract.agentId);
    this.assertNotRevoked(agent);
    if (agent.status === "stopped") {
      throw new HttpError(409, "The approved task is temporarily unavailable");
    }
    if (agent.status === "busy") {
      throw new HttpError(409, "The approved capability is currently busy");
    }

    const timestamp = now();
    const runId = randomUUID();
    let workspacePath: string | null = null;
    let delegatedCodexHome: string | null = null;
    let launchStarted = false;
    let reservationMade = false;
    let queuedRun: AgentRun | null = null;
    try {
      const run: AgentRun = {
        id: runId,
        agentId: agent.id,
        status: "queued",
        prompt: initialContract.sanitizedTaskSummary,
        output: null,
        error: null,
        usage: null,
        startedAt: null,
        completedAt: null,
        createdAt: timestamp,
      };
      queuedRun = run;
      const approvedInputs = await input.loadApprovedInputs();
      if (this.runtimeFirewall) {
        await this.runtimeFirewall.authorize(
          agent,
          input.prompt,
          input.runtimeAuthorization,
        );
      }
      workspacePath = await this.workspaces.createDelegatedRunWorkspace(
        runId,
        {
          id: initialContract.requiredCapability,
          label: "Approved delegated capability",
        },
        approvedInputs,
      );
      delegatedCodexHome = await this.delegatedCodexHomes.create(runId);
      const reservation = await this.store.mutate((database) => {
        const contract = database.delegationContracts.find(
          (candidate) => candidate.id === input.contractId,
        );
        if (!contract || contract.granteeHumanId !== input.granteeHumanId) {
          throw new HttpError(404, "Approved task not found");
        }
        if (contract.status !== "active" || contract.usesConsumed >= contract.maximumUses) {
          throw new HttpError(403, "This Trust Pass can no longer be used", {
            code:
              contract.status === "revoked"
                ? "DELEGATION_REVOKED"
                : contract.status === "expired"
                  ? "DELEGATION_EXPIRED"
                  : "DELEGATION_CONSUMED",
          });
        }
        if (new Date(contract.expiresAt).getTime() <= Date.now()) {
          contract.status = "expired";
          throw new HttpError(403, "This Trust Pass has expired", {
            code: "DELEGATION_EXPIRED",
          });
        }
        if (
          contract.exactPromptDigest !== input.promptDigest ||
          contract.allowedActions.length !== 1 ||
          contract.allowedActions[0] !== "agent.invoke"
        ) {
          throw new HttpError(403, "The requested task does not match the approved scope", {
            code: "DELEGATION_PROMPT_MISMATCH",
          });
        }
        const storedAgent = database.agents.find(
          (candidate) => candidate.id === contract.agentId,
        );
        if (!storedAgent) {
          throw new HttpError(404, "Approved task not found");
        }
        this.assertNotRevoked(storedAgent);
        if (storedAgent.status === "stopped") {
          throw new HttpError(409, "The approved task is temporarily unavailable");
        }
        if (storedAgent.status === "busy") {
          throw new HttpError(409, "The approved capability is currently busy");
        }
        contract.status = "consumed";
        contract.usesConsumed = 1;
        contract.runId = run.id;
        contract.consumedAt = timestamp;
        database.runs.push(run);
        storedAgent.status = "busy";
        storedAgent.lastError = null;
        storedAgent.updatedAt = timestamp;
        const auditPersistedLocally =
          input.commitAuthorizationEvidence?.(
            database,
            contract,
            run,
            storedAgent,
          ) ?? false;
        return {
          contract: structuredClone(contract),
          agent: structuredClone(storedAgent),
          auditPersistedLocally,
        };
      });
      reservationMade = true;
      if (!reservation.auditPersistedLocally) {
        await input.onAuthorized(reservation.contract, run, reservation.agent);
      }
      const execution = this.executeRun(reservation.agent, run, {
        prompt: input.prompt,
        workspacePath,
        threadId: null,
        delegated: true,
        contractId: reservation.contract.id,
        codexHome: delegatedCodexHome,
      });
      launchStarted = true;
      this.activeExecutions.set(agent.id, execution);
      void execution
        .finally(() => {
          if (this.activeExecutions.get(agent.id) === execution) {
            this.activeExecutions.delete(agent.id);
          }
        })
        .catch(() => undefined);
      return { run, contract: reservation.contract };
    } catch (error) {
      const recoveryOperations: Array<{ label: string; operation: Promise<void> }> = [];
      if (!launchStarted && reservationMade) {
        recoveryOperations.push({
          label: "reservation rollback",
          operation: this.rollbackDelegatedReservation(input.contractId, runId, agent.id),
        });
      }
      if (workspacePath) {
        recoveryOperations.push({
          label: "workspace cleanup",
          operation: this.workspaces.cleanupDelegatedRunWorkspace(workspacePath),
        });
      }
      if (delegatedCodexHome) {
        recoveryOperations.push({
          label: "Codex home cleanup",
          operation: this.delegatedCodexHomes.cleanup(delegatedCodexHome),
        });
      }

      const recoveryOutcomes = await Promise.allSettled(
        recoveryOperations.map(({ operation }) => operation),
      );
      const recoveryFailures = recoveryOutcomes.flatMap((outcome, index) =>
        outcome.status === "rejected"
          ? [
              new Error(recoveryOperations[index]!.label + " failed", {
                cause: outcome.reason,
              }),
            ]
          : [],
      );
      if (recoveryFailures.length > 0) {
        const failedLabels = recoveryOutcomes.flatMap((outcome, index) =>
          outcome.status === "rejected" ? [recoveryOperations[index]!.label] : [],
        );
        if (queuedRun) {
          try {
            await this.recordDelegatedPrelaunchRecoveryFailure(queuedRun);
          } catch (recordingError) {
            recoveryFailures.push(
              new Error("recovery failure recording failed", { cause: recordingError }),
            );
          }
        }
        throw new AggregateError(
          [error, ...recoveryFailures],
          "Delegated pre-launch recovery failed: " + failedLabels.join(", "),
          { cause: error },
        );
      }
      throw error;
    }
  }

  async evaluateRuntimeShellAction(
    agentId: string,
    command: string,
    runtimeAuthorization: RuntimeAuthorizationContext,
  ) {
    const agent = this.getAgent(agentId);
    this.assertNotRevoked(agent);
    if (!this.runtimeFirewall) {
      throw new HttpError(
        503,
        "Runtime Action Firewall is not configured for this Agent Runtime",
        { code: "RUNTIME_ACTION_FIREWALL_UNAVAILABLE" },
      );
    }
    return this.runtimeFirewall.evaluateShell(agent, command, runtimeAuthorization);
  }

  async systemInfo(): Promise<SystemInfo> {
    const isOfflineDemoRuntime = this.config.runtimeProvider === "offline-demo";
    const isContainerRuntime = this.config.runtimeProvider === "container";
    const isApplicationContainer =
      this.config.runtimeProvider === "application-container";
    const inspection = this.runner.inspect
      ? await this.runner.inspect()
      : {
          available: await this.runner.isAvailable(),
          codexVersion: null,
        };
    const codexExpectedVersion = await readPinnedCodexVersion();
    const arkConfigured = isArkConfigured(this.config);
    const blockers: RuntimeBlocker[] = [];

    if (!isOfflineDemoRuntime && !arkConfigured) {
      blockers.push({
        code: "ARK_NOT_CONFIGURED",
        message: "Set ARK_API_KEY and ARK_MODEL before running an Agent.",
      });
    }
    if (!inspection.available) {
      blockers.push({
        code: isContainerRuntime
          ? "CONTAINER_RUNTIME_UNAVAILABLE"
          : "CODEX_CLI_UNAVAILABLE",
        message: isContainerRuntime
          ? "The container engine, Runtime image, or Codex executable in that image could not be verified."
          : "The configured Codex CLI executable could not be started.",
      });
    }
    if (
      !isOfflineDemoRuntime &&
      inspection.available &&
      this.runner.inspect &&
      !inspection.codexVersion
    ) {
      blockers.push({
        code: "CODEX_VERSION_UNVERIFIED",
        message: "The Codex CLI started, but its version could not be verified.",
      });
    }
    if (
      !isOfflineDemoRuntime &&
      inspection.codexVersion &&
      inspection.codexVersion !== codexExpectedVersion
    ) {
      blockers.push({
        code: "CODEX_VERSION_MISMATCH",
        message:
          "Codex CLI " +
          inspection.codexVersion +
          " is active, but this project pins " +
          codexExpectedVersion +
          ".",
      });
    }
    if (isContainerRuntime && !this.config.localInsecureRuntimeKeyPassthrough) {
      blockers.push({
        code: "RUNTIME_CREDENTIALS_NOT_FORWARDED",
        message:
          "The disposable Runtime does not receive Ark credentials. Enable the local-only passthrough or use a trusted model proxy.",
      });
    }
    if (isContainerRuntime && !this.config.localInsecureRuntimeNetwork) {
      blockers.push({
        code: "RUNTIME_NETWORK_BLOCKED",
        message:
          "The disposable Runtime has no outbound network. Enable the local-only network opt-in or use a trusted model proxy.",
      });
    }

    const executionReady = blockers.length === 0;
    return {
      arkConfigured,
      arkBaseUrl: this.config.arkBaseUrl,
      arkModel: this.config.arkModel || null,
      codexExecutable: isOfflineDemoRuntime
        ? "offline-demo"
        : isContainerRuntime
          ? this.config.containerCodexBin
          : this.config.codexBin,
      codexExecutableSource: isContainerRuntime
        ? this.config.containerCodexBinSource
        : this.config.codexBinSource,
      codexAvailable: inspection.available,
      codexVersion: inspection.codexVersion,
      codexExpectedVersion,
      codexSandboxMode: this.config.codexSandboxMode,
      runtimeProvider: this.config.runtimeProvider,
      containerEngine:
        isContainerRuntime
          ? this.config.containerEngine
          : null,
      containerRuntimeImage: isContainerRuntime
        ? this.config.containerRuntimeImage
        : null,
      runtime:
        isOfflineDemoRuntime
          ? "Offline demo simulator"
          : isContainerRuntime
          ? this.config.containerEngine + " per-Run container · Codex CLI"
          : isApplicationContainer
            ? "Application container profile · Codex CLI"
            : "Host process · Codex CLI",
      executionReady,
      delegatedRunsAvailable: isContainerRuntime && executionReady,
      blockers,
      capabilities: {
        executionBoundary: isOfflineDemoRuntime
          ? "offline-demo"
          : isContainerRuntime
          ? "disposable-container"
          : isApplicationContainer
            ? "application-container"
            : "host-process",
        workspaceIsolation: isContainerRuntime
          ? "filtered-owner-projection"
          : "logical-owner-directory",
        networkPolicy: isOfflineDemoRuntime
          ? "offline-demo-network-disabled"
          : isContainerRuntime
          ? this.config.localInsecureRuntimeNetwork
            ? "local-debug-network"
            : "container-network-blocked"
          : isApplicationContainer
            ? "application-container-network"
            : "middleware-and-codex-policy",
        credentialPolicy: isOfflineDemoRuntime
          ? "offline-demo-no-credentials"
          : isContainerRuntime
          ? this.config.localInsecureRuntimeKeyPassthrough
            ? "local-debug-forwarded"
            : "not-forwarded"
          : isApplicationContainer
            ? "application-container-environment"
            : "server-process-environment",
        readOnlyRoot: isContainerRuntime,
        // The server constructs and can therefore attest these controls only
        // for disposable Runs. Docker Compose requests equivalent controls for
        // the application container, but an environment label cannot prove how
        // the current process was launched.
        capabilitiesDropped: isContainerRuntime,
        noNewPrivileges: isContainerRuntime,
        resourceLimits: isContainerRuntime,
        protectedFileProjection: isContainerRuntime,
      },
    };
  }

  private async assertExecutionReady(): Promise<void> {
    const system = await this.systemInfo();
    if (system.executionReady) return;
    const summary = system.blockers.map((blocker) => blocker.message).join(" ");
    throw new HttpError(
      503,
      summary || "The selected Agent Runtime is not ready for execution.",
      {
        code: "RUNTIME_NOT_READY",
        details: { blockers: system.blockers },
      },
    );
  }

  private async executeRun(
    agentAtStart: Agent,
    run: AgentRun,
    options: {
      prompt: string;
      workspacePath: string;
      threadId: string | null;
      delegated: boolean;
      contractId?: string;
      codexHome?: string;
    } = {
      prompt: run.prompt,
      workspacePath: agentAtStart.workspacePath,
      threadId: agentAtStart.codexThreadId,
      delegated: false,
    },
  ): Promise<void> {
    let delegatedMountCleanupAllowed = true;
    try {
      const admitted = await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        const contract = options.contractId
          ? database.delegationContracts.find(
              (candidate) => candidate.id === options.contractId,
            )
          : null;
        const invalidDelegation =
          options.delegated &&
          (!contract ||
            contract.status !== "consumed" ||
            contract.runId !== run.id ||
            contract.agentId !== agentAtStart.id);
        if (
          !storedRun ||
          !agent ||
          storedRun.status !== "queued" ||
          agent.status !== "busy" ||
          agent.revokedAt !== null ||
          invalidDelegation ||
          this.cancellationRequests.has(agentAtStart.id)
        ) {
          if (storedRun?.status === "queued") {
            storedRun.status = "cancelled";
            storedRun.error = "The Run was cancelled before execution started";
            storedRun.completedAt = now();
          }
          if (agent?.status === "busy") {
            agent.status = agent.revokedAt ? "stopped" : "ready";
            agent.updatedAt = now();
          }
          return false;
        }
        storedRun.status = "running";
        storedRun.startedAt = now();
        return true;
      });
      if (!admitted) return;
      if (this.cancellationRequests.has(agentAtStart.id)) {
        throw new RunCancelledError();
      }
      const result = await this.runner.run({
        agentId: agentAtStart.id,
        workspaceProfileId: options.delegated
          ? "delegated-" + run.id
          : runtimeWorkspaceStateId(
              agentAtStart.department,
              agentAtStart.ownerId,
            ),
        workspacePath: options.workspacePath,
        prompt: options.delegated
          ? options.prompt
          : runtimePrompt(agentAtStart, options.prompt),
        threadId: options.threadId,
        ...(options.codexHome ? { codexHome: options.codexHome } : {}),
      });
      const output = options.delegated
        ? redactDelegatedOutput(result.output, [
            this.config.arkApiKey,
            this.config.supabaseSecretKey,
            this.config.authSessionSecret,
            this.config.authToken,
          ])
        : result.output;
      const completedAt = now();
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (!storedRun || !agent) return;
        storedRun.status = "completed";
        storedRun.output = output;
        storedRun.usage = result.usage;
        storedRun.completedAt = completedAt;
        if (!options.delegated) {
          database.messages.push({
            id: randomUUID(),
            agentId: agent.id,
            runId: run.id,
            role: "assistant",
            content: output,
            createdAt: completedAt,
          });
        }
        if (agent.status !== "stopped") {
          agent.status = agent.revokedAt ? "stopped" : "ready";
        }
        if (!options.delegated) agent.codexThreadId = result.threadId;
        agent.lastError = null;
        agent.updatedAt = completedAt;
      });
    } catch (error) {
      if (error instanceof ContainerRemovalUnverifiedError) {
        delegatedMountCleanupAllowed = false;
      }
      const completedAt = now();
      const cancelled = error instanceof RunCancelledError;
      const message = error instanceof Error ? error.message : String(error);
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (storedRun) {
          storedRun.status = cancelled ? "cancelled" : "failed";
          storedRun.error = message;
          storedRun.completedAt = completedAt;
        }
        if (agent) {
          if (agent.status !== "stopped") {
            agent.status = options.delegated || cancelled ? "ready" : "error";
          }
          agent.lastError = options.delegated || cancelled ? null : message;
          agent.updatedAt = completedAt;
        }
      });
    } finally {
      if (options.delegated && delegatedMountCleanupAllowed) {
        let cleanupFailed = false;
        try {
          await this.workspaces.cleanupDelegatedRunWorkspace(options.workspacePath);
        } catch {
          cleanupFailed = true;
        }
        if (options.codexHome) {
          try {
            await this.delegatedCodexHomes.cleanup(options.codexHome);
          } catch {
            cleanupFailed = true;
          }
        }
        if (cleanupFailed) {
          await this.store.mutate((database) => {
            const storedRun = database.runs.find((item) => item.id === run.id);
            if (!storedRun) return;
            storedRun.status = "failed";
            storedRun.output = null;
            storedRun.usage = null;
            storedRun.error = "Delegated input cleanup failed";
            storedRun.completedAt = now();
          });
        }
      }
    }
  }

  private async rollbackDelegatedReservation(
    contractId: string,
    runId: string,
    agentId: string,
  ): Promise<void> {
    await this.store.mutate((database) => {
      const contract = database.delegationContracts.find(
        (candidate) => candidate.id === contractId,
      );
      const ownsReservation =
        contract?.runId === runId && contract.status === "consumed";
      if (ownsReservation) {
        contract.status = "active";
        contract.usesConsumed = 0;
        contract.runId = null;
        contract.consumedAt = null;
        database.runs = database.runs.filter((candidate) => candidate.id !== runId);
        const agent = database.agents.find((candidate) => candidate.id === agentId);
        if (agent?.status === "busy") {
          agent.status = "ready";
          agent.lastError = null;
          agent.updatedAt = now();
        }
      }
    });
  }

  private async recordDelegatedPrelaunchRecoveryFailure(run: AgentRun): Promise<void> {
    await this.store.mutate((database) => {
      let storedRun = database.runs.find((candidate) => candidate.id === run.id);
      if (!storedRun) {
        storedRun = structuredClone(run);
        database.runs.push(storedRun);
      }
      storedRun.status = "failed";
      storedRun.output = null;
      storedRun.usage = null;
      storedRun.error = "Delegated pre-launch rollback or cleanup failed";
      storedRun.completedAt = now();
    });
  }

  private async setStatus(id: string, status: Agent["status"]): Promise<Agent> {
    return this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) {
        throw new HttpError(404, "Agent not found");
      }
      if (status === "ready") this.assertNotRevoked(agent);
      if (status === "ready" && agent.status === "busy") {
        throw new HttpError(409, "Stop the active run before starting this Agent");
      }
      agent.status = status;
      if (status === "ready") agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
  }

  private async cancelExecution(agentId: string): Promise<void> {
    this.cancellationRequests.add(agentId);
    try {
      await this.runner.cancel(agentId);
      const execution = this.activeExecutions.get(agentId);
      if (execution) {
        await execution;
      }
    } finally {
      this.cancellationRequests.delete(agentId);
    }
  }

  private assertNotRevoked(agent: Agent): void {
    if (agent.revokedAt) {
      throw new HttpError(403, "This Agent has been revoked and cannot perform actions", {
        code: "AGENT_REVOKED",
      });
    }
  }
}

export function redactDelegatedOutput(
  output: string,
  secrets: readonly string[],
): string {
  let redacted = output;
  for (const secret of secrets) {
    if (secret.length < 8) continue;
    const encodedVariants = [
      [...secret].reverse().join(""),
      Buffer.from(secret, "utf8").toString("base64"),
      Buffer.from(secret, "utf8").toString("base64url"),
      Buffer.from(secret, "utf8").toString("hex"),
      encodeURIComponent(secret),
    ].filter((variant) => variant !== secret);
    const normalizedSecret = secret.replace(/[^a-z0-9]/gi, "").toLowerCase();
    const normalizedOutput = output.replace(/[^a-z0-9]/gi, "").toLowerCase();
    if (
      encodedVariants.some(
        (variant) => variant.length >= 8 && output.includes(variant),
      ) ||
      (secret.length >= 16 &&
        !output.includes(secret) &&
        normalizedSecret.length >= 12 &&
        normalizedOutput.includes(normalizedSecret))
    ) {
      return "[delegated output withheld: possible secret disclosure]";
    }
    redacted = redacted.split(secret).join("[secret redacted]");
  }
  return redacted.replace(
    /\b(?:api[_ -]?key|access[_ -]?token|password|secret)\s*[:=]\s*[^\s,;]+/gi,
    "[secret redacted]",
  );
}

function runtimePrompt(agent: Agent, userPrompt: string): string {
  const instructions = agent.instructions.trim() ||
    "Help the user complete coding tasks in this workspace. Explain material results concisely.";
  return [
    "You are the coding Agent named " + agent.name + ".",
    agent.description ? "Purpose: " + agent.description : "",
    "",
    "Agent-specific instructions:",
    instructions,
    "",
    "User request:",
    userPrompt,
  ]
    .filter((line, index, lines) => !(line === "" && lines[index - 1] === ""))
    .join("\n");
}

function normalizedWorkspaceKey(workspacePath: string): string {
  const resolved = path.resolve(workspacePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
