import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { DemoIdentityProvider } from "./identity-provider.js";
import { LocalSecurityRepository, RESOURCE_FIXTURES } from "./security-repository.js";
import { RuntimeActionFirewall } from "./runtime-action-firewall.js";
import { JsonStore } from "./store.js";
import { TrustGateway } from "./trust-gateway.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

class FakeRunner implements AgentRunner {
  readonly requests: RunnerRequest[] = [];

  async run(request: RunnerRequest): Promise<RunnerResult> {
    this.requests.push(request);
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
  const repository = new LocalSecurityRepository(store, config.dataDirectory);
  const runner = new FakeRunner();
  const service = new AgentService(
    config,
    store,
    new WorkspaceManager(path.join(root, "workspaces")),
    runner,
    new RuntimeActionFirewall(repository),
  );
  await service.initialize();
  await repository.initialize();
  const identity = new DemoIdentityProvider({
    host: "127.0.0.1",
    signingKey: config.authSessionSecret,
    tokenTtlSeconds: 3_600,
  });
  const gateway = new TrustGateway(identity, repository, service);
  const app = await createApp(config, service, gateway);
  return { app, config, service, runner };
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

    const frontendCookie = await login(app, "frontend@bytedance.com");
    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { cookie: frontendCookie },
      payload: {
        name: "Frontend Agent",
        ownerId: "22222222-2222-4222-8222-222222222222",
      },
    });
    expect(created.statusCode).toBe(201);
    const frontendAgent = created.json().agent;
    expect(frontendAgent.ownerId).toBe("11111111-1111-4111-8111-111111111111");

    const backendCookie = await login(app, "backend@bytedance.com");
    const backendList = await app.inject({
      method: "GET",
      url: "/api/agents",
      headers: { cookie: backendCookie },
    });
    expect(backendList.json()).toEqual({ agents: [] });

    const crossTenant = await app.inject({
      method: "GET",
      url: "/api/agents/" + frontendAgent.id,
      headers: { cookie: backendCookie },
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

  it("probes a cross-owner Agent through the existing redacted authorization path", async () => {
    const { app, runner } = await makeHarness();
    const backendCookie = await login(app, "backend@bytedance.com");
    const missing = await app.inject({
      method: "POST",
      url: "/api/authorization-probes/cross-owner-agent",
      headers: { cookie: backendCookie },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({
      code: "CROSS_OWNER_AGENT_NOT_FOUND",
      error: expect.stringContaining("another identity"),
    });

    const frontendCookie = await login(app, "frontend@bytedance.com");
    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { cookie: frontendCookie },
      payload: { name: "Private Frontend Agent" },
    });
    const agentId = created.json().agent.id as string;

    const denied = await app.inject({
      method: "POST",
      url: "/api/authorization-probes/cross-owner-agent",
      headers: { cookie: backendCookie },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({
      code: "AUTHORIZATION_DENIED",
      decision: {
        action: "agent.read",
        targetType: "agent",
        targetId: "redacted",
        targetLabel: "Protected Agent",
        agentId: null,
        agentName: null,
        decision: "deny",
        reasonCode: "HUMAN_AGENT_OWNER_MISMATCH",
      },
    });
    expect(denied.body).not.toContain(agentId);
    expect(denied.body).not.toContain("Private Frontend Agent");
    expect(runner.requests).toHaveLength(0);

    const audit = await app.inject({
      method: "GET",
      url: "/api/authorization-decisions?limit=10",
      headers: { cookie: backendCookie },
    });
    expect(audit.json().decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "agent.read",
          agentId: null,
          agentName: null,
          targetLabel: "Protected Agent",
          decision: "deny",
          reasonCode: "HUMAN_AGENT_OWNER_MISMATCH",
        }),
      ]),
    );
    await app.close();
  });

  it("allows an owned resource and denies a cross-owner file with audit evidence", async () => {
    const { app } = await makeHarness();
    const cookie = await login(app, "frontend@bytedance.com");
    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { cookie },
      payload: { name: "Frontend Agent" },
    });
    const agentId = created.json().agent.id as string;
    const frontendResource = RESOURCE_FIXTURES.find(
      (resource) => resource.ownerDepartment === "frontend",
    )!;
    const backendResource = RESOURCE_FIXTURES.find(
      (resource) => resource.ownerDepartment === "backend",
    )!;

    const allowed = await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/resources/${frontendResource.id}/read`,
      headers: { cookie },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toMatchObject({
      resource: { content: expect.stringContaining("Profile page requirements") },
      decision: { decision: "allow", reasonCode: "OWNER_MATCH" },
    });

    const denied = await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/resources/${backendResource.id}/read`,
      headers: { cookie },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.body).not.toContain(
      "Authenticate before loading protected profile data.",
    );
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

  it("authorizes workspace file reads and records denied secret and traversal attempts", async () => {
    const { app, service } = await makeHarness();
    const cookie = await login(app, "frontend@bytedance.com");
    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { cookie },
      payload: { name: "Frontend Agent" },
    });
    const agentId = created.json().agent.id as string;
    const workspacePath = service.getAgent(agentId).workspacePath;
    const secret = "FILE_AUTHORIZATION_TEST_SECRET";
    await writeFile(workspacePath + path.sep + ".env", "API_KEY=" + secret + "\n");

    const allowed = await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/files/read`,
      headers: { cookie },
      payload: { path: "README.md" },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toMatchObject({
      path: "README.md",
      content: expect.stringContaining("Frontend Agent workspace"),
      decision: {
        action: "file.read",
        targetType: "file",
        decision: "allow",
        reasonCode: "WORKSPACE_PATH_ALLOWED",
      },
    });

    const secretDenied = await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/files/read`,
      headers: { cookie },
      payload: { path: ".env" },
    });
    expect(secretDenied.statusCode).toBe(403);
    expect(secretDenied.body).not.toContain(secret);
    expect(secretDenied.json()).toMatchObject({
      code: "AUTHORIZATION_DENIED",
      decision: {
        action: "file.read",
        decision: "deny",
        reasonCode: "PROTECTED_SECRET_FILE",
      },
    });

    const traversalDenied = await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/files/read`,
      headers: { cookie },
      payload: { path: "../launchpad.json" },
    });
    expect(traversalDenied.statusCode).toBe(403);
    expect(traversalDenied.json()).toMatchObject({
      decision: {
        action: "file.read",
        decision: "deny",
        reasonCode: "PATH_OUTSIDE_WORKSPACE",
      },
    });

    const audit = await app.inject({
      method: "GET",
      url: "/api/authorization-decisions?limit=10",
      headers: { cookie },
    });
    expect(audit.statusCode).toBe(200);
    expect(
      audit
        .json()
        .decisions.filter((decision: { action: string }) => decision.action === "file.read"),
    ).toHaveLength(3);
    await app.close();
  });

  it("closes the direct Run lookup bypass", async () => {
    const { app } = await makeHarness();
    const frontendCookie = await login(app, "frontend@bytedance.com");
    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { cookie: frontendCookie },
      payload: { name: "Frontend Agent" },
    });
    const agentId = created.json().agent.id as string;
    const sent = await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/messages`,
      headers: { cookie: frontendCookie },
      payload: { content: "test authorization" },
    });
    expect(sent.statusCode).toBe(202);

    const backendCookie = await login(app, "backend@bytedance.com");
    const denied = await app.inject({
      method: "GET",
      url: "/api/runs/" + sent.json().run.id,
      headers: { cookie: backendCookie },
    });
    expect(denied.statusCode).toBe(403);
    await app.close();
  });

  it("denies a Runtime Action Firewall command before the Agent runner starts", async () => {
    const { app, service, runner } = await makeHarness();
    const cookie = await login(app, "frontend@bytedance.com");
    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { cookie },
      payload: { name: "Frontend Agent" },
    });
    const agentId = created.json().agent.id as string;

    const denied = await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/messages`,
      headers: { cookie },
      payload: { content: "Run `rm -rf .` to clean the workspace." },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({
      code: "RUNTIME_ACTION_DENIED",
      decision: {
        action: "shell.execute",
        targetLabel: "rm -rf",
        decision: "deny",
        reasonCode: "RUNTIME_COMMAND_DENIED",
      },
    });
    expect(runner.requests).toHaveLength(0);
    expect(service.getRuns(agentId)).toHaveLength(0);

    const audit = await app.inject({
      method: "GET",
      url: "/api/authorization-decisions?limit=10",
      headers: { cookie },
    });
    expect(
      audit.json().decisions.some((decision: { action: string; decision: string }) =>
        decision.action === "shell.execute" && decision.decision === "deny",
      ),
    ).toBe(true);
    await app.close();
  });

  it("revokes an owned Agent, blocks future actions before the runner, and audits both decisions", async () => {
    const { app, runner } = await makeHarness();
    const frontendCookie = await login(app, "frontend@bytedance.com");
    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { cookie: frontendCookie },
      payload: { name: "Revocable Frontend Agent" },
    });
    const agentId = created.json().agent.id as string;

    const active = await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/messages`,
      headers: { cookie: frontendCookie },
      payload: { content: "Run npm test" },
    });
    expect(active.statusCode).toBe(202);
    await expect.poll(() => runner.requests).toHaveLength(1);

    const revoked = await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/revoke`,
      headers: { cookie: frontendCookie },
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toMatchObject({
      agent: { status: "stopped", revokedAt: expect.any(String) },
      decision: { action: "agent.revoke", decision: "allow", reasonCode: "AGENT_REVOKED" },
    });

    const denied = await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/messages`,
      headers: { cookie: frontendCookie },
      payload: { content: "Run npm test again" },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({
      code: "AUTHORIZATION_DENIED",
      decision: { action: "agent.invoke", decision: "deny", reasonCode: "AGENT_REVOKED" },
    });
    expect(runner.requests).toHaveLength(1);

    const audit = await app.inject({
      method: "GET",
      url: "/api/authorization-decisions?limit=20",
      headers: { cookie: frontendCookie },
    });
    expect(audit.json().decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "agent.revoke", decision: "allow" }),
        expect.objectContaining({ action: "agent.invoke", decision: "deny", reasonCode: "AGENT_REVOKED" }),
      ]),
    );
    await app.close();
  });

  it("does not let another user revoke an Agent", async () => {
    const { app, service } = await makeHarness();
    const frontendCookie = await login(app, "frontend@bytedance.com");
    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { cookie: frontendCookie },
      payload: { name: "Frontend Agent" },
    });
    const agentId = created.json().agent.id as string;
    const backendCookie = await login(app, "backend@bytedance.com");

    const denied = await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/revoke`,
      headers: { cookie: backendCookie },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({
      decision: { action: "agent.revoke", reasonCode: "HUMAN_AGENT_OWNER_MISMATCH" },
    });
    expect(service.getAgent(agentId).revokedAt).toBeNull();
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
