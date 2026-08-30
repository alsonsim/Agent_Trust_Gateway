import { access, mkdir, mkdtemp, readdir } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService, redactDelegatedOutput } from "./agent-service.js";
import { loadConfig } from "./config.js";
import { ContainerRemovalUnverifiedError } from "./container-codex-runner.js";
import { digestExactPrompt } from "./delegation-digest.js";
import { RunCancelledError } from "./errors.js";
import { FINANCE_PRINCIPAL, HR_PRINCIPAL } from "./identity-provider.js";
import { JsonStore } from "./store.js";
import {
  DEFAULT_LEGACY_OWNER_ID,
  type AgentRunner,
  type DelegationContract,
  type RunnerRequest,
  type RunnerResult,
} from "./types.js";
import { WorkspaceManager } from "./workspace.js";

class FakeRunner implements AgentRunner {
  async run(request: RunnerRequest): Promise<RunnerResult> {
    return {
      output: "Completed: " + request.prompt,
      threadId: request.threadId ?? "fake-thread",
      usage: { inputTokens: 12, outputTokens: 5 },
    };
  }
  async cancel(): Promise<boolean> {
    return false;
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function makeService(runner: AgentRunner = new FakeRunner()): Promise<AgentService> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-test-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
  });
  const service = new AgentService(
    config,
    new JsonStore(path.join(root, "data", "db.json")),
    new WorkspaceManager(path.join(root, "workspaces")),
    runner,
  );
  await service.initialize();
  return service;
}

async function makeDelegatedHarness(runner: AgentRunner) {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-delegated-test-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-provider-key",
    ARK_MODEL: "ep-test",
    RUNTIME_PROVIDER: "container",
  });
  const store = new JsonStore(path.join(root, "data", "db.json"));
  const workspaces = new WorkspaceManager(path.join(root, "workspaces"));
  const service = new AgentService(config, store, workspaces, runner);
  await service.initialize();
  const agent = await service.createAgent(DEFAULT_LEGACY_OWNER_ID, {
    name: "Delegated Finance Agent",
  });
  const prompt = "Estimate the approved aggregate budget.";
  const timestamp = new Date().toISOString();
  const contract: DelegationContract = {
    id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    requestId: null,
    requiredCapability: "finance.cost-analysis",
    sanitizedTaskSummary: prompt,
    personalInformation: "none_detected",
    approvingHumanId: DEFAULT_LEGACY_OWNER_ID,
    granteeHumanId: "22222222-2222-4222-8222-222222222222",
    granteeEmail: "hr@agent-gateway.local",
    granteeDisplayName: "HR",
    granteeDepartment: "hr",
    agentId: agent.id,
    approvedPrompt: prompt,
    exactPromptDigest: digestExactPrompt(prompt),
    approvedResourceIds: [],
    approvedResourceDigests: {},
    allowedActions: ["agent.invoke"],
    resultVisibility: "final_output_only",
    maximumUses: 1,
    usesConsumed: 0,
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    status: "active",
    runId: null,
    createdAt: timestamp,
    consumedAt: null,
    revokedAt: null,
  };
  await store.mutate((database) => database.delegationContracts.push(contract));
  return { root, store, workspaces, service, agent, contract, prompt };
}

function delegatedInput(
  contract: DelegationContract,
  prompt: string,
  onAuthorized: () => Promise<void> = async () => undefined,
) {
  return {
    contractId: contract.id,
    granteeHumanId: contract.granteeHumanId,
    prompt,
    promptDigest: digestExactPrompt(prompt),
    loadApprovedInputs: async () => [],
    runtimeAuthorization: {
      humanUserId: contract.granteeHumanId,
      humanEmail: contract.granteeEmail,
      humanDepartment: contract.granteeDepartment,
      requestId: "delegated-test-request",
    },
    onAuthorized,
  };
}

describe("Agent lifecycle", () => {
  it("withholds transformed or split secrets from delegated output", () => {
    const secret = "provider-secret-key-123456";
    expect(
      redactDelegatedOutput(
        "encoded: " + Buffer.from(secret, "utf8").toString("base64"),
        [secret],
      ),
    ).toBe("[delegated output withheld: possible secret disclosure]");
    expect(redactDelegatedOutput([...secret].join("."), [secret])).toBe(
      "[delegated output withheld: possible secret disclosure]",
    );
    expect(redactDelegatedOutput("key=" + secret, [secret])).toBe(
      "key=[secret redacted]",
    );
  });

  it("creates, updates, stops, starts and deletes an Agent", async () => {
    const service = await makeService();
    const agent = await service.createAgent(DEFAULT_LEGACY_OWNER_ID, { name: "Builder" });
    expect(service.listAgents()).toHaveLength(1);
    expect((await service.updateAgent(agent.id, { description: "Builds apps" })).description)
      .toBe("Builds apps");
    expect((await service.stopAgent(agent.id)).status).toBe("stopped");
    expect((await service.startAgent(agent.id)).status).toBe("ready");
    await service.deleteAgent(agent.id);
    expect(service.listAgents()).toHaveLength(0);
  });

  it("persists a playground conversation", async () => {
    const service = await makeService();
    const agent = await service.createAgent(DEFAULT_LEGACY_OWNER_ID, { name: "Coder" });
    const { run } = await service.sendMessage(agent.id, "write hello world");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    const messages = service.getMessages(agent.id);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[1]?.content).toContain("write hello world");
    expect(service.getAgent(agent.id).codexThreadId).toBe("fake-thread");
  });

  it("atomically accepts only one concurrent run per Agent", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const runner: AgentRunner = {
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = await makeService(runner);
    const agent = await service.createAgent(DEFAULT_LEGACY_OWNER_ID, { name: "Concurrent" });
    const attempts = await Promise.allSettled([
      service.sendMessage(agent.id, "first"),
      service.sendMessage(agent.id, "second"),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    expect(rejected).toMatchObject({ reason: { statusCode: 409 } });
    expect(service.getMessages(agent.id)).toHaveLength(1);

    finish({ output: "done", threadId: "thread", usage: null });
    const accepted = attempts.find((attempt) => attempt.status === "fulfilled");
    if (accepted?.status === "fulfilled") {
      await expect.poll(() => service.getRun(accepted.value.run.id).status).toBe("completed");
    }
  });

  it("does not let start reset a busy Agent and admit a second run", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const service = await makeService({
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent(DEFAULT_LEGACY_OWNER_ID, { name: "Busy" });
    const { run } = await service.sendMessage(agent.id, "first");

    await expect(service.startAgent(agent.id)).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.sendMessage(agent.id, "second")).rejects.toMatchObject({
      statusCode: 409,
    });

    finish({ output: "done", threadId: "thread", usage: null });
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
  });

  it("derives a shared deterministic workspace profile from the authenticated department", async () => {
    const service = await makeService();
    const financeOne = await service.createAgent(FINANCE_PRINCIPAL.id, "finance", {
      name: "Finance One",
    });
    const financeTwo = await service.createAgent(FINANCE_PRINCIPAL.id, "finance", {
      name: "Finance Two",
    });
    const hrAgent = await service.createAgent(HR_PRINCIPAL.id, "hr", { name: "HR" });

    expect(financeOne).toMatchObject({
      department: "finance",
      workspaceProfileId: "department-finance",
    });
    expect(financeTwo.workspacePath).toBe(financeOne.workspacePath);
    expect(hrAgent.workspacePath).not.toBe(financeOne.workspacePath);
  });

  it("revokes an active Agent, cancels its run, and rejects future dispatch", async () => {
    let calls = 0;
    let cancelCalls = 0;
    let rejectRun!: (error: Error) => void;
    const pending = new Promise<RunnerResult>((_resolve, reject) => {
      rejectRun = reject;
    });
    const service = await makeService({
      run: () => {
        calls += 1;
        return pending;
      },
      cancel: async () => {
        cancelCalls += 1;
        rejectRun(new Error("cancelled by revocation"));
        return true;
      },
      isAvailable: async () => true,
    });
    const agent = await service.createAgent(DEFAULT_LEGACY_OWNER_ID, { name: "Revocable" });
    await service.sendMessage(agent.id, "first action");
    await expect.poll(() => calls).toBe(1);
    await service.revokeAgent(agent.id);

    expect(calls).toBe(1);
    expect(cancelCalls).toBeGreaterThan(0);
    expect(service.getAgent(agent.id)).toMatchObject({
      status: "stopped",
      revokedAt: expect.any(String),
    });
    await expect(service.startAgent(agent.id)).rejects.toMatchObject({ statusCode: 403 });
    await expect(service.sendMessage(agent.id, "second action")).rejects.toMatchObject({
      statusCode: 403,
      code: "AGENT_REVOKED",
    });
    expect(calls).toBe(1);
  });

  it("stops and awaits active execution during service shutdown", async () => {
    let runCalls = 0;
    let cancelCalls = 0;
    let rejectRun!: (error: Error) => void;
    const pending = new Promise<RunnerResult>((_resolve, reject) => {
      rejectRun = reject;
    });
    const service = await makeService({
      run: () => {
        runCalls += 1;
        return pending;
      },
      cancel: async () => {
        cancelCalls += 1;
        rejectRun(new RunCancelledError());
        return true;
      },
      isAvailable: async () => true,
    });
    const agent = await service.createAgent(DEFAULT_LEGACY_OWNER_ID, {
      name: "Shutdown protected",
    });
    const { run } = await service.sendMessage(agent.id, "long task");
    await expect.poll(() => runCalls).toBe(1);

    await service.shutdown();

    expect(cancelCalls).toBe(1);
    expect(service.getAgent(agent.id).status).toBe("stopped");
    expect(service.getRun(run.id).status).toBe("cancelled");
  });

  it("preserves delegated mounts when Runtime container removal is unverified", async () => {
    let capturedRequest: RunnerRequest | null = null;
    const runner: AgentRunner = {
      run: async (request) => {
        capturedRequest = request;
        throw new ContainerRemovalUnverifiedError(
          "Delegated Runtime container still exists after forced removal",
        );
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const { service, contract, prompt } = await makeDelegatedHarness(runner);

    const { run } = await service.sendDelegatedMessage(
      delegatedInput(contract, prompt),
    );
    await expect.poll(() => service.getRun(run.id).status).toBe("failed");
    await expect.poll(() => capturedRequest).not.toBeNull();

    const request = capturedRequest as RunnerRequest | null;
    expect(request).not.toBeNull();
    await expect(access(request!.workspacePath)).resolves.toBeUndefined();
    await expect(access(request!.codexHome!)).resolves.toBeUndefined();
    expect(service.getRun(run.id).error).toContain("container still exists");
  });

  it("sweeps stale delegated data only after stale containers are proven removed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-recovery-test-"));
    temporaryDirectories.push(root);
    const config = loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: path.join(root, "data"),
      AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
      CODEX_HOME: path.join(root, "codex"),
      RUNTIME_PROVIDER: "container",
    });
    const staleWorkspace = path.join(
      config.workspaceRoot,
      ".delegated",
      "run-stale-workspace",
    );
    const staleHome = path.join(
      config.dataDirectory,
      "delegated-codex-homes",
      "run-stale-home",
    );
    await Promise.all([
      mkdir(staleWorkspace, { recursive: true }),
      mkdir(staleHome, { recursive: true }),
    ]);
    let removalVerified = false;
    const service = new AgentService(
      config,
      new JsonStore(path.join(config.dataDirectory, "db.json")),
      new WorkspaceManager(config.workspaceRoot),
      {
        run: async () => {
          throw new Error("not used");
        },
        cancel: async () => false,
        isAvailable: async () => true,
        removeStaleContainers: async () => {
          removalVerified = true;
        },
      },
    );

    await service.initialize();

    expect(removalVerified).toBe(true);
    await expect(access(staleWorkspace)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(staleHome)).rejects.toMatchObject({ code: "ENOENT" });

    const preservedWorkspace = path.join(
      config.workspaceRoot,
      ".delegated",
      "run-preserved-workspace",
    );
    const preservedHome = path.join(
      config.dataDirectory,
      "delegated-codex-homes",
      "run-preserved-home",
    );
    await Promise.all([
      mkdir(preservedWorkspace, { recursive: true }),
      mkdir(preservedHome, { recursive: true }),
    ]);
    const blockedService = new AgentService(
      config,
      new JsonStore(path.join(config.dataDirectory, "blocked-db.json")),
      new WorkspaceManager(config.workspaceRoot),
      {
        run: async () => {
          throw new Error("not used");
        },
        cancel: async () => false,
        isAvailable: async () => true,
        removeStaleContainers: async () => {
          throw new ContainerRemovalUnverifiedError("container still present");
        },
      },
    );

    await expect(blockedService.initialize()).rejects.toBeInstanceOf(
      ContainerRemovalUnverifiedError,
    );
    await expect(access(preservedWorkspace)).resolves.toBeUndefined();
    await expect(access(preservedHome)).resolves.toBeUndefined();
  });

  it("attempts rollback and every pre-launch cleanup and records aggregate failure", async () => {
    let runnerCalls = 0;
    const runner: AgentRunner = {
      run: async () => {
        runnerCalls += 1;
        throw new Error("runner must not start");
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const { root, store, workspaces, service, agent, contract, prompt } =
      await makeDelegatedHarness(runner);
    let workspaceCleanupAttempts = 0;
    workspaces.cleanupDelegatedRunWorkspace = async () => {
      workspaceCleanupAttempts += 1;
      throw new Error("simulated workspace cleanup failure");
    };

    let failure: unknown = null;
    try {
      await service.sendDelegatedMessage(
        delegatedInput(contract, prompt, async () => {
          throw new Error("simulated audit failure");
        }),
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as Error).message).toContain("workspace cleanup");
    expect(workspaceCleanupAttempts).toBe(1);
    expect(runnerCalls).toBe(0);

    const snapshot = store.snapshot();
    expect(snapshot.delegationContracts[0]).toMatchObject({
      status: "active",
      usesConsumed: 0,
      runId: null,
    });
    expect(snapshot.agents.find((candidate) => candidate.id === agent.id)?.status).toBe(
      "ready",
    );
    const failedRun = snapshot.runs.find(
      (candidate) => candidate.error === "Delegated pre-launch rollback or cleanup failed",
    );
    expect(failedRun).toBeDefined();
    await expect(
      access(path.join(root, "workspaces", ".delegated", "run-" + failedRun!.id)),
    ).resolves.toBeUndefined();
    await expect(
      readdir(path.join(root, "data", "delegated-codex-homes")),
    ).resolves.toEqual([]);
  });
});
