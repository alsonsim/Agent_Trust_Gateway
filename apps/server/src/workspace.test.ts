import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Agent } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function makeHarness(): Promise<{
  root: string;
  manager: WorkspaceManager;
  agent: Agent;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "delegated-workspace-test-"));
  temporaryDirectories.push(root);
  const manager = new WorkspaceManager(root);
  await manager.initialize();
  return {
    root,
    manager,
    agent: {
      id: "11111111-1111-4111-8111-111111111111",
      ownerId: "22222222-2222-4222-8222-222222222222",
      name: "Finance Agent",
      description: "Performs approved cost analysis.",
      instructions: "Use aggregate financial inputs and explain the result concisely.",
      status: "ready",
      revokedAt: null,
      workspacePath: path.join(root, "11111111-1111-4111-8111-111111111111"),
      codexThreadId: "owner-private-thread",
      lastError: null,
      createdAt: "2026-08-29T00:00:00.000Z",
      updatedAt: "2026-08-29T00:00:00.000Z",
    },
  };
}

describe("delegated Run workspaces", () => {
  it("initializes the delegated root and creates only instructions and approved inputs", async () => {
    const { root, manager, agent } = await makeHarness();
    const runId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const workspace = await manager.createDelegatedRunWorkspace(agent, runId, [
      { fileName: "headcount.json", content: '{"engineers":12}\n' },
      { fileName: "salary-bands.md", content: "Approved aggregate bands\n" },
    ]);

    expect(workspace).toBe(path.join(root, ".delegated", runId));
    expect((await readdir(workspace)).sort()).toEqual([
      "AGENTS.md",
      "headcount.json",
      "salary-bands.md",
    ]);
    expect(await readFile(path.join(workspace, "headcount.json"), "utf8")).toBe(
      '{"engineers":12}\n',
    );
    const instructions = await readFile(path.join(workspace, "AGENTS.md"), "utf8");
    expect(instructions).toContain("Finance Agent");
    expect(instructions).toContain("only approved inputs");
    expect(instructions).toContain("no prior conversation or workspace state");
    expect(instructions).not.toContain(agent.codexThreadId!);
  });

  it.each([
    "../outside.txt",
    "nested/input.txt",
    "nested\\input.txt",
    ".env",
    "AGENTS.md",
    "",
    "name with spaces.txt",
  ])("rejects unsafe approved input filename %j before creating a workspace", async (fileName) => {
    const { root, manager, agent } = await makeHarness();
    const runId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

    await expect(
      manager.createDelegatedRunWorkspace(agent, runId, [{ fileName, content: "data" }]),
    ).rejects.toThrow();
    await expect(access(path.join(root, ".delegated", runId))).rejects.toThrow();
  });

  it("rejects case-insensitive duplicate input names without creating a workspace", async () => {
    const { root, manager, agent } = await makeHarness();
    const runId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

    await expect(
      manager.createDelegatedRunWorkspace(agent, runId, [
        { fileName: "budget.json", content: "first" },
        { fileName: "BUDGET.json", content: "second" },
      ]),
    ).rejects.toThrow("unique");
    await expect(access(path.join(root, ".delegated", runId))).rejects.toThrow();
  });

  it("rejects an unsafe Run ID before creating anything outside the delegated root", async () => {
    const { root, manager, agent } = await makeHarness();
    const outsidePath = path.join(root, "outside-run");

    await expect(
      manager.createDelegatedRunWorkspace(agent, "../outside-run", []),
    ).rejects.toThrow("safe path segment");
    await expect(access(outsidePath)).rejects.toThrow();
  });

  it("removes a validated direct child idempotently", async () => {
    const { manager, agent } = await makeHarness();
    const workspace = await manager.createDelegatedRunWorkspace(
      agent,
      "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      [{ fileName: "approved.txt", content: "approved" }],
    );

    await manager.cleanupDelegatedRunWorkspace(workspace);
    await expect(access(workspace)).rejects.toThrow();
    await expect(manager.cleanupDelegatedRunWorkspace(workspace)).resolves.toBeUndefined();
  });

  it("refuses cleanup outside or below a direct delegated child", async () => {
    const { root, manager, agent } = await makeHarness();
    const workspace = await manager.createDelegatedRunWorkspace(
      agent,
      "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      [{ fileName: "approved.txt", content: "approved" }],
    );
    const protectedFile = path.join(root, "keep.txt");
    await writeFile(protectedFile, "keep", "utf8");

    await expect(manager.cleanupDelegatedRunWorkspace(root)).rejects.toThrow("direct children");
    await expect(
      manager.cleanupDelegatedRunWorkspace(path.join(root, ".delegated")),
    ).rejects.toThrow("direct children");
    await expect(
      manager.cleanupDelegatedRunWorkspace(path.join(workspace, "approved.txt")),
    ).rejects.toThrow("direct children");
    await expect(
      manager.cleanupDelegatedRunWorkspace(
        workspace + path.sep + ".." + path.sep + "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      ),
    ).rejects.toThrow("direct children");
    await expect(manager.cleanupDelegatedRunWorkspace(protectedFile)).rejects.toThrow(
      "direct children",
    );
    expect(await readFile(protectedFile, "utf8")).toBe("keep");
    expect(await readFile(path.join(workspace, "approved.txt"), "utf8")).toBe("approved");
  });
});
