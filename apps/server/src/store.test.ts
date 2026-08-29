import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonStore } from "./store.js";

const temporaryDirectories: string[] = [];
const departmentMigrations = [
  ["finance", "frontend"],
  ["hr", "backend"],
  ["research", "qa"],
  ["frontend", "frontend"],
  ["backend", "backend"],
  ["qa", "qa"],
] as const;

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("JsonStore", () => {
  it("migrates legacy single-user state to an owned version 3 database", async () => {
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
    });
  });

  it("migrates version 2 departments while preserving Agents, messages, and runs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-role-migration-test-"));
    temporaryDirectories.push(root);
    const databasePath = path.join(root, "db.json");
    const timestamp = "2026-08-29T00:00:00.000Z";
    const agent = {
      id: "99999999-9999-4999-8999-999999999999",
      ownerId: "11111111-1111-4111-8111-111111111111",
      name: "Existing Agent",
      description: "Preserve me",
      instructions: "Keep these instructions",
      status: "ready",
      revokedAt: null,
      workspacePath: path.join(root, "workspace"),
      codexThreadId: "thread-existing",
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const message = {
      id: "88888888-8888-4888-8888-888888888888",
      agentId: agent.id,
      runId: "77777777-7777-4777-8777-777777777777",
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
      databasePath,
      JSON.stringify({
        version: 2,
        agents: [agent],
        messages: [message],
        runs: [run],
        protectedResources: departmentMigrations.map(
          ([sourceDepartment], index) => ({
            id: `resource-${index}`,
            ownerId: agent.ownerId,
            ownerDepartment: sourceDepartment,
            name: `Resource ${index}`,
            description: "Legacy description",
            fileName: `resource-${index}.md`,
            storageKey: `${agent.ownerId}/resource-${index}.md`,
            createdAt: timestamp,
          }),
        ),
        authorizationDecisions: departmentMigrations.map(
          ([sourceDepartment], index) => ({
            id: `decision-${index}`,
            requestId: `request-${index}`,
            humanUserId: agent.ownerId,
            humanEmail: `${sourceDepartment}@agent-gateway.local`,
            humanDepartment: sourceDepartment,
            agentId: agent.id,
            agentName: agent.name,
            action: "agent.read",
            targetType: "agent",
            targetId: agent.id,
            targetLabel: agent.name,
            decision: "allow",
            reasonCode: "OWNER_MATCH",
            reason: `Decision ${index}`,
            createdAt: timestamp,
          }),
        ),
      }),
      "utf8",
    );

    const store = new JsonStore(databasePath);
    await store.initialize();
    const migrated = store.snapshot();

    expect(migrated.version).toBe(3);
    expect(migrated.agents).toEqual([agent]);
    expect(migrated.messages).toEqual([message]);
    expect(migrated.runs).toEqual([run]);
    const expectedDepartments = departmentMigrations.map(([, expected]) => expected);
    expect(
      migrated.protectedResources.map((resource) => resource.ownerDepartment),
    ).toEqual(expectedDepartments);
    expect(
      migrated.authorizationDecisions.map((decision) => decision.humanDepartment),
    ).toEqual(expectedDepartments);
    expect(JSON.parse(await readFile(databasePath, "utf8"))).toMatchObject({ version: 3 });
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
});
