import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonStore } from "./store.js";

const temporaryDirectories: string[] = [];
const ownerIds = {
  frontend: "11111111-1111-4111-8111-111111111111",
  backend: "22222222-2222-4222-8222-222222222222",
  qa: "33333333-3333-4333-8333-333333333333",
} as const;
const timestamp = "2026-08-29T00:00:00.000Z";

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function databasePath(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(root);
  return path.join(root, "db.json");
}

function legacyAgent(ownerId = ownerIds.frontend) {
  return {
    id: "99999999-9999-4999-8999-999999999999",
    ownerId,
    name: "Existing Agent",
    description: "Preserve me",
    instructions: "Keep these instructions",
    status: "ready",
    revokedAt: null,
    workspacePath: path.join("legacy", ownerId),
    codexThreadId: "thread-existing",
    lastError: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function resource(ownerDepartment: string) {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    ownerId: ownerIds.frontend,
    ownerDepartment,
    name: "Preserved resource",
    description: "Legacy description",
    fileName: "resource.md",
    storageKey: ownerIds.frontend + "/resource.md",
    createdAt: timestamp,
  };
}

function decision(humanDepartment: string) {
  return {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    requestId: "request-1",
    humanUserId: ownerIds.frontend,
    humanEmail: "frontend@bytedance.com",
    humanDepartment,
    agentId: "99999999-9999-4999-8999-999999999999",
    agentName: "Existing Agent",
    action: "agent.read",
    targetType: "agent",
    targetId: "99999999-9999-4999-8999-999999999999",
    targetLabel: "Existing Agent",
    decision: "allow",
    reasonCode: "OWNER_MATCH",
    reason: "Preserved decision",
    createdAt: timestamp,
  };
}

describe("JsonStore", () => {
  it("migrates version 1 state to the canonical version 4 workspace schema", async () => {
    const filePath = await databasePath("launchpad-v1-migration-");
    const { ownerId: _ownerId, revokedAt: _revokedAt, ...agent } = legacyAgent();
    await writeFile(
      filePath,
      JSON.stringify({ version: 1, agents: [agent], messages: [], runs: [] }),
      "utf8",
    );

    const store = new JsonStore(filePath);
    await store.initialize();

    expect(store.snapshot()).toMatchObject({
      version: 4,
      agents: [
        {
          ownerId: ownerIds.frontend,
          department: "frontend",
          workspaceProfileId: "department-frontend",
          revokedAt: null,
          instructions: "Keep these instructions",
        },
      ],
      workspaceProfiles: [],
      protectedResources: [],
      authorizationDecisions: [],
    });
  });

  it("migrates version 2 role values while preserving conversation and resource data", async () => {
    const filePath = await databasePath("launchpad-v2-migration-");
    const agent = legacyAgent(ownerIds.backend);
    const message = {
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      agentId: agent.id,
      runId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      role: "user",
      content: "preserved message",
      createdAt: timestamp,
    };
    const run = {
      id: message.runId,
      agentId: agent.id,
      status: "completed",
      prompt: "preserved prompt",
      output: "preserved output",
      error: null,
      usage: null,
      startedAt: timestamp,
      completedAt: timestamp,
      createdAt: timestamp,
    };
    await writeFile(
      filePath,
      JSON.stringify({
        version: 2,
        agents: [agent],
        messages: [message],
        runs: [run],
        protectedResources: [resource("finance")],
        authorizationDecisions: [decision("research")],
      }),
      "utf8",
    );

    const store = new JsonStore(filePath);
    await store.initialize();
    const migrated = store.snapshot();

    expect(migrated).toMatchObject({
      version: 4,
      agents: [
        {
          id: agent.id,
          ownerId: ownerIds.backend,
          department: "backend",
          workspaceProfileId: "department-backend",
          instructions: "Keep these instructions",
        },
      ],
      messages: [message],
      runs: [run],
    });
    expect(migrated.protectedResources[0]?.ownerDepartment).toBe("frontend");
    expect(migrated.authorizationDecisions[0]?.humanDepartment).toBe("qa");
  });

  it("migrates engineering version 3 data that has no workspace profiles", async () => {
    const filePath = await databasePath("launchpad-engineering-v3-");
    const agent = legacyAgent(ownerIds.qa);
    await writeFile(
      filePath,
      JSON.stringify({
        version: 3,
        agents: [agent],
        messages: [],
        runs: [],
        protectedResources: [resource("frontend")],
        authorizationDecisions: [decision("backend")],
      }),
      "utf8",
    );

    const store = new JsonStore(filePath);
    await store.initialize();
    const migrated = store.snapshot();

    expect(migrated.version).toBe(4);
    expect(migrated.workspaceProfiles).toEqual([]);
    expect(migrated.agents[0]).toMatchObject({
      ownerId: ownerIds.qa,
      department: "qa",
      workspaceProfileId: "department-qa",
      workspacePath: agent.workspacePath,
      instructions: agent.instructions,
    });
  });

  it("migrates incoming version 3 profiles and every legacy department value", async () => {
    const filePath = await databasePath("launchpad-incoming-v3-");
    const agent = {
      ...legacyAgent(),
      department: "finance",
      workspaceProfileId: "department-finance",
    };
    await writeFile(
      filePath,
      JSON.stringify({
        version: 3,
        agents: [agent],
        workspaceProfiles: [
          {
            id: "department-finance",
            department: "finance",
            workspacePath: path.join("legacy", "finance"),
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        ],
        messages: [],
        runs: [],
        protectedResources: [resource("hr")],
        authorizationDecisions: [decision("research")],
        documentAccessRequests: [],
      }),
      "utf8",
    );

    const store = new JsonStore(filePath);
    await store.initialize();
    const migrated = store.snapshot();

    expect(migrated).toMatchObject({
      version: 4,
      agents: [
        {
          department: "frontend",
          workspaceProfileId: "department-frontend",
          instructions: "Keep these instructions",
        },
      ],
      workspaceProfiles: [
        { id: "department-frontend", department: "frontend" },
      ],
      knownHumans: [],
      delegationRequests: [],
      delegationContracts: [],
    });
    expect(migrated.protectedResources[0]?.ownerDepartment).toBe("backend");
    expect(migrated.authorizationDecisions[0]?.humanDepartment).toBe("qa");
    expect(JSON.parse(await readFile(filePath, "utf8"))).not.toHaveProperty(
      "documentAccessRequests",
    );
  });

  it("refuses to discard non-empty state from the incomplete access-request scaffold", async () => {
    const filePath = await databasePath("launchpad-incomplete-v3-");
    await writeFile(
      filePath,
      JSON.stringify({
        version: 3,
        agents: [],
        workspaceProfiles: [],
        messages: [],
        runs: [],
        protectedResources: [],
        authorizationDecisions: [],
        documentAccessRequests: [{ id: "must-not-be-lost" }],
      }),
      "utf8",
    );

    await expect(new JsonStore(filePath).initialize()).rejects.toThrow(
      /non-empty document access request state/i,
    );
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
          createdAt: timestamp,
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
        createdAt: timestamp,
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
    expect(store.snapshot().delegationRequests[0]).toMatchObject({
      requesterDepartment: "backend",
      requiredCapability: "frontend.interface-implementation",
      personalInformation: "none_detected",
    });
    expect(store.snapshot().version).toBe(4);
    expect(await readFile(databasePath, "utf8")).not.toContain("secret raw suffix");
  });
});
