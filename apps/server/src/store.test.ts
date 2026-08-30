import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonStore } from "./store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("JsonStore", () => {
  it("migrates legacy single-user state to the current owned database", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-migration-test-"));
    temporaryDirectories.push(root);
    const databasePath = path.join(root, "db.json");
    const timestamp = new Date().toISOString();
    await writeFile(
      databasePath,
      JSON.stringify({
        version: 1,
        agents: [
          {
            id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            name: "Legacy Agent",
            description: "",
            instructions: "",
            status: "ready",
            workspacePath: path.join(root, "workspace"),
            codexThreadId: null,
            lastError: null,
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        ],
        messages: [],
        runs: [],
      }),
      "utf8",
    );
    const store = new JsonStore(databasePath);
    await store.initialize();
    expect(store.snapshot()).toMatchObject({
      version: 3,
      agents: [
        { ownerId: "11111111-1111-4111-8111-111111111111" },
      ],
      protectedResources: [],
      authorizationDecisions: [],
      knownHumans: [],
      delegationRequests: [],
      delegationContracts: [],
    });
  });

  it("migrates version 2 state with empty delegation collections", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-v2-test-"));
    temporaryDirectories.push(root);
    const databasePath = path.join(root, "db.json");
    await writeFile(
      databasePath,
      JSON.stringify({
        version: 2,
        agents: [],
        messages: [],
        runs: [],
        protectedResources: [],
        authorizationDecisions: [],
      }),
      "utf8",
    );

    const store = new JsonStore(databasePath);
    await store.initialize();

    expect(store.snapshot()).toEqual({
      version: 3,
      agents: [],
      messages: [],
      runs: [],
      protectedResources: [],
      authorizationDecisions: [],
      knownHumans: [],
      delegationRequests: [],
      delegationContracts: [],
    });
  });

  it("does not publish a mutation in memory when persistence fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-test-"));
    temporaryDirectories.push(root);
    const originalPath = path.join(root, "db.json");
    const store = new JsonStore(originalPath);
    await store.initialize();

    const mutableStore = store as unknown as { filePath: string };
    mutableStore.filePath = path.join(root, "missing-directory", "db.json");
    await expect(
      store.mutate((database) => {
        database.messages.push({
          id: "message-1",
          agentId: "agent-1",
          runId: "run-1",
          role: "user",
          content: "must not become visible",
          createdAt: new Date().toISOString(),
        });
      }),
    ).rejects.toThrow();
    expect(store.snapshot().messages).toEqual([]);

    mutableStore.filePath = originalPath;
    await store.mutate((database) => {
      database.messages.push({
        id: "message-2",
        agentId: "agent-1",
        runId: "run-2",
        role: "user",
        content: "queue recovered",
        createdAt: new Date().toISOString(),
      });
    });
    expect(store.snapshot().messages.map((message) => message.content)).toEqual([
      "queue recovered",
    ]);
  });

  it("removes legacy raw requester prompts during initialization", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-v3-test-"));
    temporaryDirectories.push(root);
    const databasePath = path.join(root, "db.json");
    await writeFile(
      databasePath,
      JSON.stringify({
        version: 3,
        agents: [],
        messages: [],
        runs: [],
        protectedResources: [],
        authorizationDecisions: [],
        knownHumans: [],
        delegationContracts: [],
        delegationRequests: [
          {
            id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            requesterHumanId: "11111111-1111-4111-8111-111111111111",
            requesterEmail: "requester@example.test",
            requesterDisplayName: "Requester",
            requesterDepartment: "hr",
            requiredCapability: "finance.cost-analysis",
            sanitizedTaskSummary: "Owner-visible task",
            personalInformation: "none",
            requestedPrompt: "secret raw suffix",
            taskDigest: "a".repeat(64),
            status: "pending",
            createdAt: "2026-08-30T00:00:00.000Z",
            expiresAt: "2026-08-30T00:30:00.000Z",
            reviewedAt: null,
            contractId: null,
          },
        ],
      }),
      "utf8",
    );

    const store = new JsonStore(databasePath);
    await store.initialize();

    expect(store.snapshot().delegationRequests[0]).not.toHaveProperty(
      "requestedPrompt",
    );
    expect(await readFile(databasePath, "utf8")).not.toContain("secret raw suffix");
  });
});
