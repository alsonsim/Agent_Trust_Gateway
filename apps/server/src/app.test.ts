import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { DemoIdentityProvider } from "./identity-provider.js";
import { LocalSecurityRepository, RESOURCE_FIXTURES } from "./security-repository.js";
import { JsonStore } from "./store.js";
import { TrustGateway } from "./trust-gateway.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

class FakeRunner implements AgentRunner {
  async run(request: RunnerRequest): Promise<RunnerResult> {
    return {
      output: "Completed: " + request.prompt,
      threadId: request.threadId ?? "test-thread",
      usage: null,
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
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function makeHarness(overrides: NodeJS.ProcessEnv = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "trust-gateway-http-test-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    HOST: "127.0.0.1",
    AUTH_MODE: "demo",
    AUTH_SESSION_SECRET: "test-session-secret-with-at-least-32-bytes",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
    ...overrides,
  });
  const store = new JsonStore(path.join(root, "data", "launchpad.json"));
  const service = new AgentService(
    config,
    store,
    new WorkspaceManager(path.join(root, "workspaces")),
    new FakeRunner(),
  );
  await service.initialize();
  const repository = new LocalSecurityRepository(store, config.dataDirectory);
  await repository.initialize();
  const identity = new DemoIdentityProvider({
    host: "127.0.0.1",
    signingKey: config.authSessionSecret,
    tokenTtlSeconds: 3_600,
  });
  const gateway = new TrustGateway(identity, repository, service);
  const app = await createApp(config, service, gateway);
  return { app, config, service };
}

async function login(app: Awaited<ReturnType<typeof createApp>>, email: string) {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email },
  });
  expect(response.statusCode).toBe(200);
  const cookie = response.headers["set-cookie"];
  if (!cookie) throw new Error("Login did not set a session cookie");
  return cookie.split(";", 1)[0] ?? "";
}

describe("HTTP identity and authorization boundary", () => {
  it("requires a session and scopes Agent creation/listing to its owner", async () => {
    const { app } = await makeHarness();
    const denied = await app.inject({ method: "GET", url: "/api/agents" });
    expect(denied.statusCode).toBe(401);

    const financeCookie = await login(app, "finance@agent-gateway.local");
    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { cookie: financeCookie },
      payload: {
        name: "Finance Agent",
        ownerId: "22222222-2222-4222-8222-222222222222",
      },
    });
    expect(created.statusCode).toBe(201);
    const financeAgent = created.json().agent;
    expect(financeAgent.ownerId).toBe("11111111-1111-4111-8111-111111111111");

    const hrCookie = await login(app, "hr@agent-gateway.local");
    const hrList = await app.inject({
      method: "GET",
      url: "/api/agents",
      headers: { cookie: hrCookie },
    });
    expect(hrList.json()).toEqual({ agents: [] });

    const crossTenant = await app.inject({
      method: "GET",
      url: "/api/agents/" + financeAgent.id,
      headers: { cookie: hrCookie },
    });
    expect(crossTenant.statusCode).toBe(403);
    expect(crossTenant.json()).toMatchObject({
      code: "AUTHORIZATION_DENIED",
      decision: {
        decision: "deny",
        reasonCode: "HUMAN_AGENT_OWNER_MISMATCH",
        agentId: null,
      },
    });
    await app.close();
  }, 20_000);

  it("allows an owned resource and denies a cross-owner file with audit evidence", async () => {
    const { app } = await makeHarness();
    const cookie = await login(app, "finance@agent-gateway.local");
    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { cookie },
      payload: { name: "Finance Agent" },
    });
    const agentId = created.json().agent.id as string;
    const financeResource = RESOURCE_FIXTURES.find(
      (resource) => resource.ownerDepartment === "finance",
    )!;
    const hrResource = RESOURCE_FIXTURES.find(
      (resource) => resource.ownerDepartment === "hr",
    )!;

    const allowed = await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/resources/${financeResource.id}/read`,
      headers: { cookie },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toMatchObject({
      resource: { content: expect.stringContaining("Quarterly budget") },
      decision: { decision: "allow", reasonCode: "OWNER_MATCH" },
    });

    const denied = await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/resources/${hrResource.id}/read`,
      headers: { cookie },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.body).not.toContain("Compensation bands (synthetic)");
    expect(denied.json()).toMatchObject({
      decision: {
        decision: "deny",
        reasonCode: "AGENT_RESOURCE_OWNER_MISMATCH",
      },
    });

    const audit = await app.inject({
      method: "GET",
      url: "/api/authorization-decisions?limit=10",
      headers: { cookie },
    });
    expect(audit.statusCode).toBe(200);
    expect(
      audit.json().decisions.map((decision: { decision: string }) => decision.decision),
    ).toEqual(expect.arrayContaining(["allow", "deny"]));
    await app.close();
  });

  it("closes the direct Run lookup bypass", async () => {
    const { app } = await makeHarness();
    const financeCookie = await login(app, "finance@agent-gateway.local");
    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { cookie: financeCookie },
      payload: { name: "Finance Agent" },
    });
    const agentId = created.json().agent.id as string;
    const sent = await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/messages`,
      headers: { cookie: financeCookie },
      payload: { content: "test authorization" },
    });
    expect(sent.statusCode).toBe(202);

    const hrCookie = await login(app, "hr@agent-gateway.local");
    const denied = await app.inject({
      method: "GET",
      url: "/api/runs/" + sent.json().run.id,
      headers: { cookie: hrCookie },
    });
    expect(denied.statusCode).toBe(403);
    await app.close();
  });

  it("preserves the optional shared-token boundary in legacy mode", async () => {
    const { app } = await makeHarness({
      AUTH_MODE: "legacy",
      APP_AUTH_TOKEN: "a-strong-test-token",
    });
    const denied = await app.inject({ method: "GET", url: "/api/agents" });
    expect(denied.statusCode).toBe(401);
    const allowed = await app.inject({
      method: "GET",
      url: "/api/agents",
      headers: { authorization: "Bearer a-strong-test-token" },
    });
    expect(allowed.statusCode).toBe(200);
    await app.close();
  });

  it("preserves Fastify client error status codes", async () => {
    const { app } = await makeHarness({ AUTH_MODE: "legacy" });
    const malformed = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { "content-type": "application/json" },
      payload: "{not-json",
    });
    expect(malformed.statusCode).toBe(400);

    const oversized = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ name: "x".repeat(1_100_000) }),
    });
    expect(oversized.statusCode).toBe(413);
    await app.close();
  });
});
