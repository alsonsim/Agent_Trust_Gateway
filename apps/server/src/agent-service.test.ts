import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { loadConfig } from "./config.js";
import { BACKEND_PRINCIPAL, FRONTEND_PRINCIPAL } from "./identity-provider.js";
import { JsonStore } from "./store.js";
import {
  DEFAULT_LEGACY_OWNER_ID,
  type AgentRunner,
  type RunnerRequest,
  type RunnerResult,
} from "./types.js";
import {
  runtimeWorkspaceStateId,
  workspaceOwnerKey,
  WorkspaceManager,
} from "./workspace.js";

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
const standardWorkspaceDirectories = ["src", "test", "reports"] as const;

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

function serviceForRoot(
  root: string,
  runner: AgentRunner = new FakeRunner(),
): AgentService {
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
  });
  return new AgentService(
    config,
    new JsonStore(path.join(root, "data", "db.json")),
    new WorkspaceManager(path.join(root, "workspaces")),
    runner,
  );
}

async function makeService(runner: AgentRunner = new FakeRunner()): Promise<AgentService> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-test-"));
  temporaryDirectories.push(root);
  const service = serviceForRoot(root, runner);
  await service.initialize();
  return service;
}

async function expectStandardWorkspaceDirectories(workspacePath: string): Promise<void> {
  const directoryStats = await Promise.all(
    standardWorkspaceDirectories.map((directory) =>
      stat(path.join(workspacePath, directory)),
    ),
  );
  expect(directoryStats.every((entry) => entry.isDirectory())).toBe(true);
}

describe("Agent lifecycle", () => {
  it("creates the standard directories for a new Agent workspace", async () => {
    const service = await makeService();
    const agent = await service.createAgent(DEFAULT_LEGACY_OWNER_ID, "frontend", {
      name: "New workspace",
    });

    await expectStandardWorkspaceDirectories(agent.workspacePath);
  });

  it("reconciles the standard directories for a migrated Agent workspace", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-migrated-workspace-test-"));
    temporaryDirectories.push(root);
    const agentId = "99999999-9999-4999-8999-999999999999";
    const workspacePath = path.join(root, "workspaces", "frontend");
    const databasePath = path.join(root, "data", "db.json");
    const timestamp = "2026-08-29T00:00:00.000Z";
    await mkdir(workspacePath, { recursive: true });
    await writeFile(path.join(workspacePath, "legacy-note.txt"), "preserve me", "utf8");
    await mkdir(path.dirname(databasePath), { recursive: true });
    await writeFile(
      databasePath,
      JSON.stringify({
        version: 2,
        agents: [
          {
            id: agentId,
            ownerId: DEFAULT_LEGACY_OWNER_ID,
            name: "Migrated Agent",
            description: "",
            instructions: "",
            status: "ready",
            revokedAt: null,
            workspacePath,
            codexThreadId: null,
            lastError: null,
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        ],
        messages: [],
        runs: [],
        protectedResources: [],
        authorizationDecisions: [],
      }),
      "utf8",
    );

    const service = serviceForRoot(root);
    await service.initialize();

    const roleWorkspace = path.join(
      root,
      "workspaces",
      "frontend",
      ".owners",
      workspaceOwnerKey(DEFAULT_LEGACY_OWNER_ID),
    );
    expect(service.getAgent(agentId)).toMatchObject({
      department: "frontend",
      workspaceProfileId: "department-frontend",
      workspacePath: roleWorkspace,
    });
    await expectStandardWorkspaceDirectories(roleWorkspace);
    await expect(
      readFile(
        path.join(roleWorkspace, "legacy-note.txt"),
        "utf8",
      ),
    ).resolves.toBe("preserve me");
  });

  it("does not clone an ambiguous shared legacy workspace into multiple owners", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-ambiguous-workspace-test-"));
    temporaryDirectories.push(root);
    const sharedWorkspace = path.join(root, "workspaces", "frontend");
    const databasePath = path.join(root, "data", "db.json");
    const timestamp = "2026-08-29T00:00:00.000Z";
    const ownerOne = FRONTEND_PRINCIPAL.id;
    const ownerTwo = "44444444-4444-4444-8444-444444444444";
    await mkdir(sharedWorkspace, { recursive: true });
    await writeFile(path.join(sharedWorkspace, "ambiguous-note.txt"), "leave in recovery", "utf8");
    await mkdir(path.dirname(databasePath), { recursive: true });
    await writeFile(
      databasePath,
      JSON.stringify({
        version: 2,
        agents: [ownerOne, ownerTwo].map((ownerId, index) => ({
          id: `${index + 1}9999999-9999-4999-8999-999999999999`,
          ownerId,
          name: `Migrated Agent ${index + 1}`,
          description: "",
          instructions: "",
          status: "ready",
          revokedAt: null,
          workspacePath: sharedWorkspace,
          codexThreadId: null,
          lastError: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        })),
        messages: [],
        runs: [],
        protectedResources: [],
        authorizationDecisions: [],
      }),
      "utf8",
    );

    const service = serviceForRoot(root);
    await service.initialize();
    const migrated = service.listAgents();

    expect(migrated[0]?.workspacePath).not.toBe(migrated[1]?.workspacePath);
    for (const agent of migrated) {
      await expect(
        readFile(path.join(agent.workspacePath, "ambiguous-note.txt"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
    }
    await expect(
      readFile(path.join(sharedWorkspace, "ambiguous-note.txt"), "utf8"),
    ).resolves.toBe("leave in recovery");
  });

  it("creates, updates, stops, starts and deletes an Agent", async () => {
    const service = await makeService();
    const agent = await service.createAgent(DEFAULT_LEGACY_OWNER_ID, "frontend", { name: "Builder" });
    expect(service.listAgents()).toHaveLength(1);
    expect((await service.updateAgent(agent.id, { description: "Builds apps" })).description)
      .toBe("Builds apps");
    expect((await service.stopAgent(agent.id)).status).toBe("stopped");
    expect((await service.startAgent(agent.id)).status).toBe("ready");
    await service.deleteAgent(agent.id);
    expect(service.listAgents()).toHaveLength(0);
  });

  it("isolates writable role workspaces while listing Agents by strict owner", async () => {
    const service = await makeService();
    const ownerOne = FRONTEND_PRINCIPAL.id;
    const ownerTwo = "44444444-4444-4444-8444-444444444444";
    const first = await service.createAgent(ownerOne, "frontend", { name: "Owner one" });
    const second = await service.createAgent(ownerTwo, "frontend", { name: "Owner two" });

    expect(first.workspaceProfileId).toBe(second.workspaceProfileId);
    expect(first.workspacePath).not.toBe(second.workspacePath);
    expect(first.workspacePath).toContain(workspaceOwnerKey(ownerOne));
    expect(second.workspacePath).toContain(workspaceOwnerKey(ownerTwo));
    expect(service.listAgents(ownerOne).map((agent) => agent.id)).toEqual([first.id]);
    expect(service.listAgents(ownerTwo).map((agent) => agent.id)).toEqual([second.id]);
  });

  it("isolates Runtime state for distinct owners assigned the same role", async () => {
    const runtimeRequests: RunnerRequest[] = [];
    const service = await makeService({
      run: async (request) => {
        runtimeRequests.push(request);
        return { output: "done", threadId: "thread-" + request.agentId, usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const ownerOne = FRONTEND_PRINCIPAL.id;
    const ownerTwo = "44444444-4444-4444-8444-444444444444";
    const first = await service.createAgent(ownerOne, "frontend", { name: "First owner" });
    const second = await service.createAgent(ownerTwo, "frontend", { name: "Second owner" });

    const firstRun = await service.sendMessage(first.id, "first owner task");
    const secondRun = await service.sendMessage(second.id, "second owner task");
    await expect.poll(() => service.getRun(firstRun.run.id).status).toBe("completed");
    await expect.poll(() => service.getRun(secondRun.run.id).status).toBe("completed");

    expect(runtimeRequests.map((request) => request.workspaceProfileId)).toEqual(
      expect.arrayContaining([
        runtimeWorkspaceStateId("frontend", ownerOne),
        runtimeWorkspaceStateId("frontend", ownerTwo),
      ]),
    );
    expect(new Set(runtimeRequests.map((request) => request.workspaceProfileId)).size).toBe(2);
  });

  it("persists a playground conversation", async () => {
    const service = await makeService();
    const agent = await service.createAgent(DEFAULT_LEGACY_OWNER_ID, "frontend", { name: "Coder" });
    const { run } = await service.sendMessage(agent.id, "write hello world");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    const messages = service.getMessages(agent.id);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[1]?.content).toContain("write hello world");
    expect(service.getAgent(agent.id).codexThreadId).toBe("fake-thread");
  });

  it("injects the selected Agent instructions into the Runtime prompt", async () => {
    let runtimeRequest: RunnerRequest | null = null;
    const service = await makeService({
      run: async (request) => {
        runtimeRequest = request;
        return { output: "done", threadId: "thread", usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent(DEFAULT_LEGACY_OWNER_ID, "frontend", {
      name: "Accessibility specialist",
      description: "Build inclusive profile experiences",
      instructions: "Use semantic HTML and verify keyboard navigation.",
    });

    const { run } = await service.sendMessage(agent.id, "Implement the profile header.");
    await expect.poll(() => runtimeRequest).not.toBeNull();
    expect(runtimeRequest?.prompt).toContain("Accessibility specialist");
    expect(runtimeRequest?.prompt).toContain("Build inclusive profile experiences");
    expect(runtimeRequest?.prompt).toContain(
      "Use semantic HTML and verify keyboard navigation.",
    );
    expect(runtimeRequest?.prompt).toContain("Implement the profile header.");
    expect(runtimeRequest?.workspaceProfileId).toBe(
      runtimeWorkspaceStateId("frontend", DEFAULT_LEGACY_OWNER_ID),
    );
    expect(service.getRun(run.id).prompt).toBe("Implement the profile header.");
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
    const agent = await service.createAgent(DEFAULT_LEGACY_OWNER_ID, "frontend", { name: "Concurrent" });
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
    const agent = await service.createAgent(DEFAULT_LEGACY_OWNER_ID, "frontend", { name: "Busy" });
    const { run } = await service.sendMessage(agent.id, "first");

    await expect(service.startAgent(agent.id)).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.sendMessage(agent.id, "second")).rejects.toMatchObject({
      statusCode: 409,
    });

    finish({ output: "done", threadId: "thread", usage: null });
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
  });

  it("derives a shared deterministic workspace profile from the authenticated role", async () => {
    const service = await makeService();
    const frontendOne = await service.createAgent(FRONTEND_PRINCIPAL.id, "frontend", {
      name: "Frontend One",
    });
    const frontendTwo = await service.createAgent(FRONTEND_PRINCIPAL.id, "frontend", {
      name: "Frontend Two",
    });
    const backendAgent = await service.createAgent(BACKEND_PRINCIPAL.id, "backend", {
      name: "Backend",
    });

    expect(frontendOne).toMatchObject({
      department: "frontend",
      workspaceProfileId: "department-frontend",
    });
    expect(frontendTwo.workspacePath).toBe(frontendOne.workspacePath);
    expect(backendAgent.workspacePath).not.toBe(frontendOne.workspacePath);
  });

  it("serializes Runs across different Agents sharing one owner's role workspace", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const service = await makeService({
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const first = await service.createAgent(FRONTEND_PRINCIPAL.id, "frontend", {
      name: "First frontend Agent",
    });
    const second = await service.createAgent(
      FRONTEND_PRINCIPAL.id,
      "frontend",
      { name: "Second frontend Agent" },
    );

    const accepted = await service.sendMessage(first.id, "first role task");
    await expect(service.sendMessage(second.id, "second role task")).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("owner's role workspace"),
    });

    finish({ output: "done", threadId: "thread", usage: null });
    await expect.poll(() => service.getRun(accepted.run.id).status).toBe("completed");
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
    const agent = await service.createAgent(DEFAULT_LEGACY_OWNER_ID, "frontend", { name: "Revocable" });
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

  it.each([
    ["frontend", "Profile Page Frontend Project Brief", "responsive profile page"],
    ["backend", "Profile API Backend Project Brief", "authenticated profile read"],
    ["qa", "Profile Release QA Project Brief", "authorization boundary"],
  ] as const)(
    "creates a legitimate %s PROJECT_BRIEF.md",
    async (department, heading, expectedDetail) => {
      const service = await makeService();
      const agent = await service.createAgent(DEFAULT_LEGACY_OWNER_ID, department, {
        name: department + " engineer",
      });

      const brief = await readFile(path.join(agent.workspacePath, "PROJECT_BRIEF.md"), "utf8");
      expect(brief).toContain(heading);
      expect(brief).toContain(expectedDetail);
      expect(brief).toContain("Acceptance criteria");
    },
  );
});
