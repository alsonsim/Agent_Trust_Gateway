import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LocalSecurityRepository,
  RESOURCE_FIXTURES,
  SupabaseSecurityRepository,
} from "./security-repository.js";
import { JsonStore } from "./store.js";
import type { AuthorizationDecision } from "./types.js";

const decision: AuthorizationDecision = {
  id: "44444444-4444-4444-8444-444444444444",
  requestId: "request-1",
  humanUserId: "11111111-1111-4111-8111-111111111111",
  humanEmail: "frontend@bytedance.com",
  humanDepartment: "frontend",
  agentId: "99999999-9999-4999-8999-999999999999",
  agentName: "Frontend Agent",
  action: "resource.read",
  targetType: "resource",
  targetId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
  targetLabel: "Profile page requirements",
  decision: "allow",
  reasonCode: "OWNER_MATCH",
  reason: "The user, agent, and resource owners match.",
  createdAt: "2026-08-29T00:00:00.000Z",
};

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("SupabaseSecurityRepository", () => {
  const compatibleOpenApi = () => ({
    definitions: {
      authorization_decisions: {
        properties: {
          target_id: { type: "string", format: "text" },
          human_department: {
            type: "string",
            enum: ["frontend", "backend", "qa"],
          },
        },
      },
    },
  });

  it("preflights the hosted schema before listing protected resources", async () => {
    const calls: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
    const repository = new SupabaseSecurityRepository(
      "https://example.supabase.co",
      "publishable-key",
      "secret-key",
      async (input, init) => {
        calls.push({ input, init });
        const body = String(input).endsWith("/rest/v1/")
          ? compatibleOpenApi()
          : [];
        return new Response(JSON.stringify(body), { status: 200 });
      },
    );

    await expect(repository.initialize()).resolves.toBeUndefined();

    expect(calls).toHaveLength(2);
    expect(String(calls[0]?.input)).toBe("https://example.supabase.co/rest/v1/");
    expect(calls[0]?.init).toMatchObject({
      method: "GET",
      headers: {
        apikey: "secret-key",
        Accept: "application/openapi+json",
      },
    });
    expect(String(calls[1]?.input)).toContain("/rest/v1/protected_resources?");
  });

  it("fails startup with an actionable error when target_id is still uuid", async () => {
    const openApi = compatibleOpenApi();
    openApi.definitions.authorization_decisions.properties.target_id.format = "uuid";
    const repository = new SupabaseSecurityRepository(
      "https://example.supabase.co",
      "publishable-key",
      "test-secret-sentinel",
      async () => new Response(JSON.stringify(openApi), { status: 200 }),
    );

    const error = await repository.initialize().then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(error).toMatchObject({
      statusCode: 503,
      code: "SUPABASE_SCHEMA_INCOMPATIBLE",
      message: expect.stringMatching(/target_id must be text.*hosted Supabase setup SQL/i),
    });
    expect((error as Error).message).not.toContain("test-secret-sentinel");
  });

  it("fails startup when the hosted department constraint is stale", async () => {
    const openApi = compatibleOpenApi();
    openApi.definitions.authorization_decisions.properties.human_department.enum = [
      "finance",
      "hr",
      "research",
    ];
    const repository = new SupabaseSecurityRepository(
      "https://example.supabase.co",
      "publishable-key",
      "secret-key",
      async () => new Response(JSON.stringify(openApi), { status: 200 }),
    );

    await expect(repository.initialize()).rejects.toMatchObject({
      statusCode: 503,
      code: "SUPABASE_SCHEMA_INCOMPATIBLE",
      message: expect.stringMatching(/human_department must allow frontend, backend, and qa/i),
    });
  });

  it("accepts an empty successful response when appending an audit decision", async () => {
    const calls: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
    const fetchImplementation: typeof fetch = async (input, init) => {
      calls.push({ input, init });
      return new Response(null, { status: 201 });
    };
    const repository = new SupabaseSecurityRepository(
      "https://example.supabase.co",
      "publishable-key",
      "secret-key",
      fetchImplementation,
    );

    await expect(repository.appendDecision(decision)).resolves.toBeUndefined();

    expect(calls).toHaveLength(1);
    expect(String(calls[0]?.input)).toBe(
      "https://example.supabase.co/rest/v1/authorization_decisions",
    );
    expect(calls[0]?.init).toMatchObject({
      method: "POST",
      headers: {
        apikey: "secret-key",
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
    });
  });

  it.each([
    ["file.read", "file", "README.md"],
    ["shell.execute", "command", "rm -rf"],
    ["network.request", "network", "curl (network request)"],
  ] as const)(
    "sends the non-UUID target for a %s audit decision",
    async (action, targetType, targetId) => {
      let body = "";
      const repository = new SupabaseSecurityRepository(
        "https://example.supabase.co",
        "publishable-key",
        "secret-key",
        async (_input, init) => {
          body = String(init?.body ?? "");
          return new Response(null, { status: 201 });
        },
      );

      await repository.appendDecision({
        ...decision,
        action,
        targetType,
        targetId,
        targetLabel: targetId,
      });

      expect(JSON.parse(body)).toMatchObject({
        action,
        target_type: targetType,
        target_id: targetId,
        target_label: targetId,
      });
    },
  );

  it("reports only sanitized diagnostics for a Supabase failure", async () => {
    const providerDetail = "do-not-expose-this-provider-detail";
    const repository = new SupabaseSecurityRepository(
      "https://example.supabase.co",
      "publishable-key",
      "secret-key",
      async () =>
        new Response(
          JSON.stringify({ code: "42501", message: providerDetail }),
          { status: 403 },
        ),
    );

    const error = await repository.listResources().then(
      () => null,
      (reason: unknown) => reason,
    );

    expect(error).toMatchObject({
      statusCode: 503,
      code: "SUPABASE_REPOSITORY_UNAVAILABLE",
      message: "Supabase security repository is unavailable",
      details: {
        repository: "supabase",
        httpStatus: 403,
        errorCode: "42501",
      },
    });
    expect((error as Error).message).not.toContain(providerDetail);
  });

  it.each([
    ["a non-JSON body", "upstream response with private detail"],
    ["a non-object JSON body", "null"],
    [
      "an unsafe provider code",
      JSON.stringify({ code: "PGRST301:private-detail", message: "private detail" }),
    ],
  ])("discards %s from Supabase diagnostics", async (_description, responseBody) => {
    const repository = new SupabaseSecurityRepository(
      "https://example.supabase.co",
      "publishable-key",
      "secret-key",
      async () => new Response(responseBody, { status: 500 }),
    );

    await expect(repository.listResources()).rejects.toMatchObject({
      statusCode: 503,
      code: "SUPABASE_REPOSITORY_UNAVAILABLE",
      details: {
        repository: "supabase",
        httpStatus: 500,
        errorCode: null,
      },
    });
  });

  it("posts multiple authorization decisions as one Supabase batch", async () => {
    let body = "";
    const fetchImplementation: typeof fetch = async (_input, init) => {
      body = String(init?.body ?? "");
      return new Response(null, { status: 201 });
    };
    const repository = new SupabaseSecurityRepository(
      "https://example.supabase.co",
      "publishable-key",
      "secret-key",
      fetchImplementation,
    );

    await repository.appendDecisions([
      decision,
      { ...decision, id: "55555555-5555-4555-8555-555555555555" },
    ]);

    expect(JSON.parse(body)).toEqual([
      expect.objectContaining({ id: decision.id, action: "resource.read" }),
      expect.objectContaining({
        id: "55555555-5555-4555-8555-555555555555",
        action: "resource.read",
      }),
    ]);
  });
});

describe("LocalSecurityRepository", () => {
  it("refreshes reserved fixture metadata and content without duplicating rows", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "security-fixture-refresh-"));
    temporaryDirectories.push(root);
    const store = new JsonStore(path.join(root, "launchpad.json"));
    await store.initialize();
    const repository = new LocalSecurityRepository(store, root);
    await repository.initialize();

    const fixture = RESOURCE_FIXTURES[0]!;
    const fixturePath = path.join(root, "protected-resources", fixture.ownerId, fixture.fileName);
    await writeFile(fixturePath, "stale fixture content\n", "utf8");
    await store.mutate((database) => {
      const stored = database.protectedResources.find((resource) => resource.id === fixture.id)!;
      stored.name = "Stale fixture name";
      stored.description = "Stale fixture description";
      stored.ownerDepartment = "qa";
    });

    await repository.initialize();

    const matching = store
      .snapshot()
      .protectedResources.filter((resource) => resource.id === fixture.id);
    expect(matching).toHaveLength(1);
    expect(matching[0]).toMatchObject({
      name: "Profile page requirements",
      fileName: "profile-page-requirements.md",
      ownerDepartment: "frontend",
    });
    await expect(readFile(fixturePath, "utf8")).resolves.toContain(
      "Build an accessible, responsive profile page",
    );
  });

  it("removes only the three known legacy fixture files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "security-legacy-fixture-cleanup-"));
    temporaryDirectories.push(root);
    const store = new JsonStore(path.join(root, "launchpad.json"));
    await store.initialize();
    const repository = new LocalSecurityRepository(store, root);
    await repository.initialize();

    const legacyFiles = [
      ["11111111-1111-4111-8111-111111111111", "quarterly-budget.md"],
      ["22222222-2222-4222-8222-222222222222", "compensation-bands.md"],
      ["33333333-3333-4333-8333-333333333333", "experiment-notes.md"],
    ] as const;
    const resourceRoot = path.join(root, "protected-resources");
    await Promise.all(
      legacyFiles.map(([ownerId, fileName]) =>
        writeFile(path.join(resourceRoot, ownerId, fileName), "legacy fixture\n", "utf8"),
      ),
    );
    const unrelatedPath = path.join(
      resourceRoot,
      legacyFiles[0][0],
      "keep-this-resource.md",
    );
    await writeFile(unrelatedPath, "keep me\n", "utf8");

    await repository.initialize();

    for (const [ownerId, fileName] of legacyFiles) {
      await expect(
        readFile(path.join(resourceRoot, ownerId, fileName), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
    }
    await expect(readFile(unrelatedPath, "utf8")).resolves.toBe("keep me\n");
  });
});
