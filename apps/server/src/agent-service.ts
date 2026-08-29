import { randomUUID } from "node:crypto";
import type { AppConfig } from "./config.js";
import { isArkConfigured } from "./config.js";
import { HttpError, RunCancelledError } from "./errors.js";
import type { RuntimeActionFirewall } from "./runtime-action-firewall.js";
import { JsonStore } from "./store.js";
import type {
  Agent,
  AgentRun,
  AgentRunner,
  CreateAgentInput,
  DelegationContract,
  Message,
  RuntimeAuthorizationContext,
  UpdateAgentInput,
} from "./types.js";
import { WorkspaceManager } from "./workspace.js";
import type { DelegatedWorkspaceInput } from "./workspace.js";

const now = () => new Date().toISOString();

export class AgentService {
  private readonly activeExecutions = new Map<string, Promise<void>>();
  private readonly cancellationRequests = new Set<string>();

  constructor(
    private readonly config: AppConfig,
    private readonly store: JsonStore,
    private readonly workspaces: WorkspaceManager,
    private readonly runner: AgentRunner,
    private readonly runtimeFirewall?: RuntimeActionFirewall,
  ) {}

  async initialize(): Promise<void> {
    await this.store.initialize();
    await this.workspaces.initialize();
    await this.store.mutate((database) => {
      for (const run of database.runs) {
        if (run.status === "queued" || run.status === "running") {
          run.status = "cancelled";
          run.error = "Server restarted while this run was active";
          run.completedAt = now();
        }
      }
      for (const agent of database.agents) {
        if (agent.status === "busy") {
          agent.status = "ready";
          agent.updatedAt = now();
        }
      }
    });
  }

  listAgents(ownerId?: string): Agent[] {
    const agents = this.store.snapshot().agents;
    return agents
      .filter((agent) => ownerId === undefined || agent.ownerId === ownerId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  getAgent(id: string): Agent {
    const agent = this.store.snapshot().agents.find((item) => item.id === id);
    if (!agent) {
      throw new HttpError(404, "Agent not found");
    }
    return agent;
  }

  async createAgent(ownerId: string, input: CreateAgentInput): Promise<Agent> {
    const timestamp = now();
    const id = randomUUID();
    const agent: Agent = {
      id,
      ownerId,
      name: input.name.trim(),
      description: input.description?.trim() ?? "",
      instructions: input.instructions?.trim() ?? "",
      status: "ready",
      revokedAt: null,
      workspacePath: this.workspaces.workspacePath(id),
      codexThreadId: null,
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.workspaces.create(agent);
    await this.store.mutate((database) => database.agents.push(agent));
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
    await this.cancelExecution(id);
    const archivedWorkspace = await this.workspaces.archive(agent);
    await this.store.mutate((database) => {
      database.agents = database.agents.filter((item) => item.id !== id);
      database.messages = database.messages.filter((item) => item.agentId !== id);
      database.runs = database.runs.filter((item) => item.agentId !== id);
    });
    return { archivedWorkspace };
  }

  async startAgent(id: string): Promise<Agent> {
    this.assertNotRevoked(this.getAgent(id));
    return this.setStatus(id, "ready");
  }

  async stopAgent(id: string): Promise<Agent> {
    this.getAgent(id);
    await this.cancelExecution(id);
    return this.setStatus(id, "stopped");
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
    if (!isArkConfigured(this.config)) {
      throw new HttpError(
        503,
        "Ark is not configured. Set ARK_API_KEY and ARK_MODEL, then restart.",
      );
    }
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
    approvedInputs: DelegatedWorkspaceInput[];
    runtimeAuthorization: RuntimeAuthorizationContext;
    onAuthorized: (
      contract: DelegationContract,
      run: AgentRun,
      agent: Agent,
    ) => Promise<void>;
  }): Promise<{ run: AgentRun; contract: DelegationContract }> {
    if (!isArkConfigured(this.config)) {
      throw new HttpError(
        503,
        "Ark is not configured. Set ARK_API_KEY and ARK_MODEL, then restart.",
      );
    }
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
    const workspacePath = await this.workspaces.createDelegatedRunWorkspace(
      agent,
      runId,
      input.approvedInputs,
    );
    const delegatedAgent = { ...agent, workspacePath };
    try {
      if (this.runtimeFirewall) {
        await this.runtimeFirewall.authorize(
          delegatedAgent,
          input.prompt,
          input.runtimeAuthorization,
        );
      }
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
        return {
          contract: structuredClone(contract),
          agent: structuredClone(storedAgent),
        };
      });
      try {
        await input.onAuthorized(reservation.contract, run, reservation.agent);
      } catch (error) {
        await this.rollbackDelegatedReservation(
          reservation.contract.id,
          run.id,
          reservation.agent.id,
        );
        throw error;
      }
      const execution = this.executeRun(reservation.agent, run, {
        prompt: input.prompt,
        workspacePath,
        threadId: null,
        delegated: true,
      });
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
      const reserved = this.store
        .snapshot()
        .delegationContracts.find(
          (candidate) => candidate.id === input.contractId && candidate.runId === runId,
        );
      if (!reserved) {
        await this.workspaces.cleanupDelegatedRunWorkspace(workspacePath);
      }
      throw error;
    }
  }

  async systemInfo(): Promise<Record<string, unknown>> {
    return {
      arkConfigured: isArkConfigured(this.config),
      arkBaseUrl: this.config.arkBaseUrl,
      arkModel: this.config.arkModel || null,
      codexAvailable: await this.runner.isAvailable(),
      codexSandboxMode: this.config.codexSandboxMode,
      runtimeProvider: this.config.runtimeProvider,
      containerEngine:
        this.config.runtimeProvider === "container"
          ? this.config.containerEngine
          : null,
      runtime:
        this.config.runtimeProvider === "container"
          ? "Codex CLI in " + this.config.containerEngine + " Runtime"
          : "Codex CLI in application container",
    };
  }

  private async executeRun(
    agentAtStart: Agent,
    run: AgentRun,
    options: {
      prompt: string;
      workspacePath: string;
      threadId: string | null;
      delegated: boolean;
    } = {
      prompt: run.prompt,
      workspacePath: agentAtStart.workspacePath,
      threadId: agentAtStart.codexThreadId,
      delegated: false,
    },
  ): Promise<void> {
    await this.store.mutate((database) => {
      const storedRun = database.runs.find((item) => item.id === run.id);
      if (storedRun) {
        storedRun.status = "running";
        storedRun.startedAt = now();
      }
    });
    try {
      if (this.cancellationRequests.has(agentAtStart.id)) {
        throw new RunCancelledError();
      }
      const result = await this.runner.run({
        agentId: agentAtStart.id,
        workspacePath: options.workspacePath,
        prompt: options.prompt,
        threadId: options.threadId,
      });
      const completedAt = now();
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (!storedRun || !agent) return;
        storedRun.status = "completed";
        storedRun.output = result.output;
        storedRun.usage = result.usage;
        storedRun.completedAt = completedAt;
        if (!options.delegated) {
          database.messages.push({
            id: randomUUID(),
            agentId: agent.id,
            runId: run.id,
            role: "assistant",
            content: result.output,
            createdAt: completedAt,
          });
        }
        agent.status = agent.revokedAt ? "stopped" : "ready";
        if (!options.delegated) agent.codexThreadId = result.threadId;
        agent.lastError = null;
        agent.updatedAt = completedAt;
      });
    } catch (error) {
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
      if (options.delegated) {
        await this.workspaces.cleanupDelegatedRunWorkspace(options.workspacePath);
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
      if (contract?.runId === runId && contract.status === "consumed") {
        contract.status = "active";
        contract.usesConsumed = 0;
        contract.runId = null;
        contract.consumedAt = null;
      }
      database.runs = database.runs.filter((candidate) => candidate.id !== runId);
      const agent = database.agents.find((candidate) => candidate.id === agentId);
      if (agent?.status === "busy") {
        agent.status = "ready";
        agent.lastError = null;
        agent.updatedAt = now();
      }
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
