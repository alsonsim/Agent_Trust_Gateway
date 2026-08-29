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
  Department,
  Message,
  RuntimeAuthorizationContext,
  UpdateAgentInput,
} from "./types.js";
import { WorkspaceManager } from "./workspace.js";

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
    for (const department of ["finance", "hr", "research"] as const) {
      await this.workspaces.ensureProfile(this.workspaces.profile(department));
    }
    await this.store.mutate((database) => {
      const timestamp = now();
      for (const department of ["finance", "hr", "research"] as const) {
        const profile = this.workspaces.profile(department);
        if (!database.workspaceProfiles.some((item) => item.id === profile.id)) {
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
        const profile = database.workspaceProfiles.find(
          (item) => item.id === agent.workspaceProfileId,
        );
        if (profile) {
          // Legacy UUID workspaces stay on disk for recovery, but new and
          // migrated Agent execution uses the deterministic department profile.
          agent.workspacePath = profile.workspacePath;
          agent.updatedAt = timestamp;
        }
        if (agent.status === "busy") {
          agent.status = "ready";
          agent.updatedAt = now();
        }
      }
    });
  }

  listAgents(department?: Department): Agent[] {
    const agents = this.store.snapshot().agents;
    return agents
      .filter((agent) => department === undefined || agent.department === department)
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
    departmentOrInput: Department | CreateAgentInput,
    suppliedInput?: CreateAgentInput,
  ): Promise<Agent> {
    const department =
      typeof departmentOrInput === "string"
        ? departmentOrInput
        : legacyDepartmentForOwner(ownerId);
    const input = typeof departmentOrInput === "string" ? suppliedInput : departmentOrInput;
    if (!input) throw new Error("Agent input is required");
    const timestamp = now();
    const id = randomUUID();
    const profile = this.workspaces.profile(department);
    await this.workspaces.ensureProfile(profile);
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
      workspacePath: profile.workspacePath,
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
    await this.cancelExecution(id);
    const archivedWorkspace = agent.workspacePath;
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
      const profileBusy = database.runs.some((candidate) => {
        if (candidate.status !== "queued" && candidate.status !== "running") return false;
        const candidateAgent = database.agents.find((item) => item.id === candidate.agentId);
        return candidateAgent?.workspaceProfileId === storedAgent.workspaceProfileId;
      });
      if (profileBusy) {
        throw new HttpError(
          409,
          "Another Agent is using this shared department workspace",
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

  async systemInfo(): Promise<Record<string, unknown>> {
    const isContainerRuntime = this.config.runtimeProvider === "container";
    return {
      arkConfigured: isArkConfigured(this.config),
      arkBaseUrl: this.config.arkBaseUrl,
      arkModel: this.config.arkModel || null,
      codexExecutable: isContainerRuntime
        ? this.config.containerCodexBin
        : this.config.codexBin,
      codexExecutableSource: isContainerRuntime
        ? this.config.containerCodexBinSource
        : this.config.codexBinSource,
      codexAvailable: await this.runner.isAvailable(),
      codexSandboxMode: this.config.codexSandboxMode,
      runtimeProvider: this.config.runtimeProvider,
      containerEngine:
        isContainerRuntime
          ? this.config.containerEngine
          : null,
      runtime:
        isContainerRuntime
          ? "Codex CLI in " + this.config.containerEngine + " Runtime"
          : "Codex CLI in application container",
    };
  }

  private async executeRun(agentAtStart: Agent, run: AgentRun): Promise<void> {
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
        workspaceProfileId: agentAtStart.workspaceProfileId,
        workspacePath: agentAtStart.workspacePath,
        prompt: run.prompt,
        threadId: agentAtStart.codexThreadId,
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
        database.messages.push({
          id: randomUUID(),
          agentId: agent.id,
          runId: run.id,
          role: "assistant",
          content: result.output,
          createdAt: completedAt,
        });
        agent.status = agent.revokedAt ? "stopped" : "ready";
        agent.codexThreadId = result.threadId;
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
            agent.status = cancelled ? "ready" : "error";
          }
          agent.lastError = cancelled ? null : message;
          agent.updatedAt = completedAt;
        }
      });
    }
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

function legacyDepartmentForOwner(ownerId: string): Department {
  if (ownerId === "22222222-2222-4222-8222-222222222222") return "hr";
  if (ownerId === "33333333-3333-4333-8333-333333333333") return "research";
  return "finance";
}
