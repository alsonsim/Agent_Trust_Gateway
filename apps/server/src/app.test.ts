import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { DelegationService } from "./delegation-service.js";
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

class ControlledRunner extends FakeRunner {
  private finishFirst!: (result: RunnerResult) => void;
  private readonly firstResult = new Promise<RunnerResult>((resolve) => {
    this.finishFirst = resolve;
  });

  override async run(request: RunnerRequest): Promise<RunnerResult> {
    this.requests.push(request);
    if (this.requests.length === 1) return this.firstResult;
    return {
      output: "Completed: " + request.prompt,
      threadId: request.threadId ?? "test-thread",
      usage: null,
    };
  }

  finish(output = "Approved finance result"): void {
    this.finishFirst({ output, threadId: "must-not-persist", usage: null });
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

async function makeHarness(
  overrides: NodeJS.ProcessEnv = {},
  runner: FakeRunner = new FakeRunner(),
) {
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
    RUNTIME_PROVIDER: "container",
    ...overrides,
  });
  const store = new JsonStore(path.join(root, "data", "launchpad.json"));
  const repository = new LocalSecurityRepository(store, config.dataDirectory);
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
  const delegations = new DelegationService(store, repository, service);
  await delegations.observePrincipals(gateway.demoPrincipals);
  const app = await createApp(config, service, gateway, delegations);
  return { app, config, repository, service, runner, store };
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
  it("reports the resolved Codex executable and availability", async () => {
    const { app, config } = await makeHarness();
    const cookie = await login(app, "finance@agent-gateway.local");
    const response = await app.inject({
      method: "GET",
      url: "/api/system",
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      codexExecutable: config.codexBin,
      codexExecutableSource: config.codexBinSource,
      codexAvailable: true,
    });
    await app.close();
  });

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
    const { app, config } = await makeHarness();
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

    const financeResources = await app.inject({
      method: "GET",
      url: "/api/resources",
      headers: { cookie },
    });
    expect(financeResources.json().resources).toEqual([
      expect.objectContaining({
        id: financeResource.id,
        ownedByCurrentUser: true,
      }),
    ]);
    expect(financeResources.body).not.toContain(hrResource.name);

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
      statusCode: 403,
      code: "AUTHORIZATION_DENIED",
      error: "Forbidden",
      decision: {
        id: expect.any(String),
        requestId: expect.any(String),
        agentId,
        humanEmail: "finance@agent-gateway.local",
        action: "resource.read",
        targetType: "resource",
        decision: "deny",
        reasonCode: "AGENT_RESOURCE_OWNER_MISMATCH",
        targetId: "redacted",
        targetLabel: "Protected resource",
      },
    });
    expect(denied.body).not.toContain(hrResource.name);

    const privateCrossOwnerDemo = await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/resources/cross-owner-demo`,
      headers: { cookie },
    });
    expect(privateCrossOwnerDemo.statusCode).toBe(403);
    expect(privateCrossOwnerDemo.json()).toMatchObject({
      decision: {
        decision: "deny",
        reasonCode: "AGENT_RESOURCE_OWNER_MISMATCH",
        targetId: "redacted",
        targetLabel: "Protected resource",
      },
    });
    expect(privateCrossOwnerDemo.body).not.toContain(hrResource.name);

    await rm(
      path.join(
        config.dataDirectory,
        "protected-resources",
        financeResource.ownerId,
        financeResource.fileName,
      ),
    );
    const unavailable = await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/resources/${financeResource.id}/read`,
      headers: { cookie },
    });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toEqual({
      error: "The protected resource could not be read under the active data policy",
      code: "RESOURCE_POLICY_UNAVAILABLE",
    });
    expect(unavailable.body).not.toContain(config.dataDirectory);

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
    const cookie = await login(app, "finance@agent-gateway.local");
    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { cookie },
      payload: { name: "Finance Agent" },
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
      content: expect.stringContaining("finance department workspace"),
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
      statusCode: 403,
      code: "AUTHORIZATION_DENIED",
      error: "Forbidden",
      message: "Access denied by Agent Trust Gateway",
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
    await expect
      .poll(async () => {
        const completed = await app.inject({
          method: "GET",
          url: "/api/runs/" + sent.json().run.id,
          headers: { cookie: financeCookie },
        });
        return completed.json().run?.status;
      })
      .toBe("completed");
    await app.close();
  });

  it("denies a dangerous Playground chat command before creating a Run or starting the runner", async () => {
    const { app, service, runner } = await makeHarness();
    const cookie = await login(app, "finance@agent-gateway.local");
    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { cookie },
      payload: { name: "Finance Agent" },
    });
    const agentId = created.json().agent.id as string;

    const denied = await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/messages`,
      headers: { cookie },
      payload: { content: "Run this shell command: rm -rf /workspace/test" },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({
      statusCode: 403,
      code: "RUNTIME_ACTION_DENIED",
      error: "Forbidden",
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

  it("allows a safe Playground chat command through the normal Run path", async () => {
    const { app, service, runner } = await makeHarness();
    const cookie = await login(app, "finance@agent-gateway.local");
    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { cookie },
      payload: { name: "Finance Agent" },
    });
    const agentId = created.json().agent.id as string;

    const accepted = await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/messages`,
      headers: { cookie },
      payload: { content: "Run pwd and report the current directory." },
    });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toMatchObject({
      run: {
        id: expect.any(String),
        agentId,
        status: "queued",
        prompt: "Run pwd and report the current directory.",
      },
      message: {
        agentId,
        role: "user",
        content: "Run pwd and report the current directory.",
      },
    });
    await expect.poll(() => runner.requests).toHaveLength(1);
    expect(runner.requests[0]).toMatchObject({
      agentId,
      prompt: "Run pwd and report the current directory.",
    });
    await expect.poll(() => service.getRuns(agentId)[0]?.status).toBe("completed");
    await app.close();
  });

  it("evaluates a dangerous shell demo action without creating a Run or calling the runner", async () => {
    const { app, service, runner } = await makeHarness();
    const cookie = await login(app, "finance@agent-gateway.local");
    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { cookie },
      payload: { name: "Finance Agent" },
    });
    const agentId = created.json().agent.id as string;

    const denied = await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/runtime-actions/evaluate`,
      headers: { cookie },
      payload: {
        type: "shell",
        command: "Please execute:\n```bash\nrm -rf ./demo-folder\n```",
      },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({
      statusCode: 403,
      code: "RUNTIME_ACTION_DENIED",
      error: "Forbidden",
      decision: {
        id: expect.any(String),
        requestId: expect.any(String),
        agentId,
        humanEmail: "finance@agent-gateway.local",
        action: "shell.execute",
        targetType: "command",
        targetLabel: "rm -rf",
        decision: "deny",
        reasonCode: "RUNTIME_COMMAND_DENIED",
      },
    });
    expect(service.getRuns(agentId)).toHaveLength(0);
    expect(runner.requests).toHaveLength(0);

    const audit = await app.inject({
      method: "GET",
      url: "/api/authorization-decisions?limit=20",
      headers: { cookie },
    });
    expect(audit.json().decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "shell.execute",
          decision: "deny",
          reasonCode: "RUNTIME_COMMAND_DENIED",
        }),
      ]),
    );
    await app.close();
  });

  it("revokes an owned Agent, blocks future actions before the runner, and audits both decisions", async () => {
    const { app, runner } = await makeHarness();
    const financeCookie = await login(app, "finance@agent-gateway.local");
    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { cookie: financeCookie },
      payload: { name: "Revocable Finance Agent" },
    });
    const agentId = created.json().agent.id as string;

    const active = await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/messages`,
      headers: { cookie: financeCookie },
      payload: { content: "Run npm test" },
    });
    expect(active.statusCode).toBe(202);
    await expect.poll(() => runner.requests).toHaveLength(1);

    const revoked = await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/revoke`,
      headers: { cookie: financeCookie },
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toMatchObject({
      agent: { status: "stopped", revokedAt: expect.any(String) },
      decision: { action: "agent.revoke", decision: "allow", reasonCode: "AGENT_REVOKED" },
    });

    const denied = await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/messages`,
      headers: { cookie: financeCookie },
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
      headers: { cookie: financeCookie },
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
    const financeCookie = await login(app, "finance@agent-gateway.local");
    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { cookie: financeCookie },
      payload: { name: "Finance Agent" },
    });
    const agentId = created.json().agent.id as string;
    const hrCookie = await login(app, "hr@agent-gateway.local");

    const denied = await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/revoke`,
      headers: { cookie: hrCookie },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({
      decision: { action: "agent.revoke", reasonCode: "HUMAN_AGENT_OWNER_MISMATCH" },
    });
    expect(service.getAgent(agentId).revokedAt).toBeNull();
    await app.close();
  });

  it("discovers and forwards a consented capability request without Agent disclosure", async () => {
    const { app } = await makeHarness();
    const hrCookie = await login(app, "hr@agent-gateway.local");
    const discovery = await app.inject({
      method: "POST",
      url: "/api/capability-discovery",
      headers: { cookie: hrCookie },
      payload: {
        prompt: "Estimate the budget impact of hiring 12 engineers.",
      },
    });
    expect(discovery.statusCode).toBe(200);
    expect(discovery.json()).toMatchObject({
      required: true,
      capability: "finance.cost-analysis",
      providerDepartment: "finance",
    });
    expect(discovery.body).not.toContain("Agent");

    const spoofed = await app.inject({
      method: "POST",
      url: "/api/delegation-requests",
      headers: { cookie: hrCookie },
      payload: {
        requiredCapability: "finance.cost-analysis",
        prompt: "Estimate the cost for alice@example.com and 12 engineers.",
        sanitizedTaskSummary: "Aggregate headcount and salary bands",
      },
    });
    expect(spoofed.statusCode).toBe(400);

    const mismatchedCapability = await app.inject({
      method: "POST",
      url: "/api/delegation-requests",
      headers: { cookie: hrCookie },
      payload: {
        requiredCapability: "finance.cost-analysis",
        prompt: "Synthesize evidence from recent research studies.",
      },
    });
    expect(mismatchedCapability.statusCode).toBe(400);

    const created = await app.inject({
      method: "POST",
      url: "/api/delegation-requests",
      headers: { cookie: hrCookie },
      payload: {
        requiredCapability: "finance.cost-analysis",
        prompt: "Estimate the cost for alice@example.com and 12 engineers.",
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      request: {
        box: "outgoing",
        requiredCapability: "finance.cost-analysis",
        sanitizedTaskSummary:
          "Estimate the cost for [personal information redacted] and 12 engineers.",
        personalInformation: "possible",
        status: "pending",
      },
      decision: {
        action: "delegation.request",
        reasonCode: "DELEGATION_REQUESTED",
      },
    });
    expect(created.body).not.toContain("alice@example.com");
    expect(created.json().request).not.toHaveProperty("agentId");
    const requestId = created.json().request.id as string;

    const researchCookie = await login(app, "research@agent-gateway.local");
    const unrelatedInbox = await app.inject({
      method: "GET",
      url: "/api/delegation-requests?box=incoming",
      headers: { cookie: researchCookie },
    });
    expect(unrelatedInbox.json().requests).toEqual([]);

    const financeCookie = await login(app, "finance@agent-gateway.local");
    const financeInbox = await app.inject({
      method: "GET",
      url: "/api/delegation-requests?box=incoming",
      headers: { cookie: financeCookie },
    });
    expect(financeInbox.json().requests).toEqual([
      expect.objectContaining({
        id: requestId,
        requester: { displayName: "HR", department: "hr" },
        sanitizedTaskSummary:
          "Estimate the cost for [personal information redacted] and 12 engineers.",
      }),
    ]);
    expect(financeInbox.body).not.toContain("alice@example.com");
    expect(financeInbox.json().requests[0]).not.toHaveProperty("agentId");

    const rejected = await app.inject({
      method: "POST",
      url: `/api/delegation-requests/${requestId}/reject`,
      headers: { cookie: financeCookie },
    });
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json()).toMatchObject({
      request: { status: "rejected" },
      decision: { reasonCode: "DELEGATION_REJECTED" },
    });
    await app.close();
  });

  it("issues the same scoped Trust Pass through request and owner initiated paths", async () => {
    const { app, service } = await makeHarness();
    const financeCookie = await login(app, "finance@agent-gateway.local");
    const createdAgent = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { cookie: financeCookie },
      payload: { name: "Private Finance Agent" },
    });
    const financeAgent = createdAgent.json().agent as { id: string; workspacePath: string };
    const financeResource = RESOURCE_FIXTURES.find(
      (resource) => resource.ownerDepartment === "finance",
    )!;

    const hrCookie = await login(app, "hr@agent-gateway.local");
    const request = await app.inject({
      method: "POST",
      url: "/api/delegation-requests",
      headers: { cookie: hrCookie },
      payload: {
        requiredCapability: "finance.cost-analysis",
        prompt: "Estimate the budget impact of hiring 12 engineers.",
      },
    });
    const requestId = request.json().request.id as string;

    const approved = await app.inject({
      method: "POST",
      url: `/api/delegation-requests/${requestId}/approve`,
      headers: { cookie: financeCookie },
      payload: {
        agentId: financeAgent.id,
        approvedResourceIds: [financeResource.id],
        expiresInSeconds: 600,
      },
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({
      contract: {
        source: "request",
        box: "outgoing",
        grantee: { displayName: "HR", department: "hr" },
        agent: { id: financeAgent.id, name: "Private Finance Agent" },
        allowedActions: ["agent.invoke"],
        resultVisibility: "final_output_only",
        maximumUses: 1,
        remainingUses: 1,
        status: "active",
        policyReasonCode: "DELEGATION_ACTIVE",
      },
      decision: {
        action: "delegation.approve",
        reasonCode: "DELEGATION_APPROVED",
      },
    });
    const approvedContractId = approved.json().contract.id as string;

    const hrPasses = await app.inject({
      method: "GET",
      url: "/api/delegation-contracts?box=incoming",
      headers: { cookie: hrCookie },
    });
    expect(hrPasses.statusCode).toBe(200);
    expect(hrPasses.json().contracts).toEqual([
      expect.objectContaining({
        id: approvedContractId,
        box: "incoming",
        providerLabel: "Privately managed finance capability",
        approvedPrompt: "Estimate the budget impact of hiring 12 engineers.",
        approvedInputCount: 1,
      }),
    ]);
    expect(hrPasses.body).not.toContain(financeAgent.id);
    expect(hrPasses.body).not.toContain("Private Finance Agent");
    expect(hrPasses.body).not.toContain(financeAgent.workspacePath);
    expect(hrPasses.body).not.toContain(financeResource.name);
    expect(hrPasses.body).not.toContain(financeResource.fileName);

    const unauthorizedRevoke = await app.inject({
      method: "POST",
      url: `/api/delegation-contracts/${approvedContractId}/revoke`,
      headers: { cookie: hrCookie },
    });
    expect(unauthorizedRevoke.statusCode).toBe(404);

    const revoked = await app.inject({
      method: "POST",
      url: `/api/delegation-contracts/${approvedContractId}/revoke`,
      headers: { cookie: financeCookie },
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toMatchObject({
      contract: { status: "revoked", policyReasonCode: "DELEGATION_REVOKED" },
      decision: { reasonCode: "DELEGATION_REVOKED" },
    });
    expect(service.getAgent(financeAgent.id)).toMatchObject({
      status: "ready",
      revokedAt: null,
    });

    const direct = await app.inject({
      method: "POST",
      url: "/api/delegation-contracts",
      headers: { cookie: financeCookie },
      payload: {
        requiredCapability: "finance.cost-analysis",
        granteeHumanId: "33333333-3333-4333-8333-333333333333",
        agentId: financeAgent.id,
        exactPrompt: "Summarize the approved aggregate budget inputs.",
        approvedResourceIds: [],
        expiresInSeconds: 60,
      },
    });
    expect(direct.statusCode).toBe(201);
    expect(direct.json()).toMatchObject({
      contract: {
        source: "owner",
        box: "outgoing",
        grantee: { displayName: "Research", department: "research" },
        allowedActions: ["agent.invoke"],
        resultVisibility: "final_output_only",
        maximumUses: 1,
      },
    });
    await app.close();
  });

  it("binds requester-initiated execution to the exact redacted task the owner sees", async () => {
    const { app, store } = await makeHarness();
    const financeCookie = await login(app, "finance@agent-gateway.local");
    const createdAgent = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { cookie: financeCookie },
      payload: { name: "Finance Agent" },
    });
    const hrCookie = await login(app, "hr@agent-gateway.local");
    const hiddenSuffix = "HIDDEN_UNREVIEWED_INSTRUCTIONS";
    const requestedPrompt =
      "Estimate the cost for alice@example.com and 12 engineers. " +
      "Context ".repeat(50) +
      hiddenSuffix;
    const requested = await app.inject({
      method: "POST",
      url: "/api/delegation-requests",
      headers: { cookie: hrCookie },
      payload: {
        requiredCapability: "finance.cost-analysis",
        prompt: requestedPrompt,
      },
    });
    expect(requested.statusCode).toBe(201);
    const ownerVisibleTask = requested.json().request.sanitizedTaskSummary as string;
    expect(ownerVisibleTask).toContain("[personal information redacted]");
    expect(ownerVisibleTask).not.toContain(hiddenSuffix);

    const approved = await app.inject({
      method: "POST",
      url: `/api/delegation-requests/${requested.json().request.id}/approve`,
      headers: { cookie: financeCookie },
      payload: {
        agentId: createdAgent.json().agent.id,
        approvedResourceIds: [],
        expiresInSeconds: 600,
      },
    });
    expect(approved.statusCode).toBe(200);
    const incoming = await app.inject({
      method: "GET",
      url: "/api/delegation-contracts?box=incoming",
      headers: { cookie: hrCookie },
    });
    expect(incoming.json().contracts[0].approvedPrompt).toBe(ownerVisibleTask);
    expect(incoming.body).not.toContain(hiddenSuffix);
    expect(JSON.stringify(store.snapshot().delegationRequests)).not.toContain(
      hiddenSuffix,
    );
    await app.close();
  });

  it("does not publish a Trust Pass when atomic approval evidence fails", async () => {
    const runner = new FakeRunner();
    const { app, repository, store } = await makeHarness({}, runner);
    const financeCookie = await login(app, "finance@agent-gateway.local");
    const createdAgent = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { cookie: financeCookie },
      payload: { name: "Finance Agent" },
    });
    const exactPrompt = "Estimate one approved aggregate budget.";
    const appendDecisionsToDatabase =
      repository.appendDecisionsToDatabase.bind(repository);
    repository.appendDecisionsToDatabase = (database, decisions) => {
      if (decisions.some((decision) => decision.action === "delegation.approve")) {
        throw new Error("audit unavailable");
      }
      appendDecisionsToDatabase(database, decisions);
    };

    const issue = await app.inject({
      method: "POST",
      url: "/api/delegation-contracts",
      headers: { cookie: financeCookie },
      payload: {
        requiredCapability: "finance.cost-analysis",
        granteeHumanId: "22222222-2222-4222-8222-222222222222",
        agentId: createdAgent.json().agent.id,
        exactPrompt,
        approvedResourceIds: [],
        expiresInSeconds: 600,
      },
    });
    expect(issue.statusCode).toBe(503);
    const visible = await app.inject({
      method: "GET",
      url: "/api/delegation-contracts?box=outgoing",
      headers: { cookie: financeCookie },
    });
    expect(visible.json().contracts).toEqual([]);
    expect(store.snapshot().delegationContracts).toEqual([]);
    expect(
      store
        .snapshot()
        .authorizationDecisions.some(
          (decision) => decision.action === "delegation.approve",
        ),
    ).toBe(false);
    expect(runner.requests).toHaveLength(0);
    await app.close();
  });

  it("fails closed when atomic delegation evidence is unavailable", async () => {
    const { app, repository, runner } = await makeHarness();
    const appendDecisionsToDatabase =
      repository.appendDecisionsToDatabase.bind(repository);
    let failedAction: string | null = "delegation.request";
    repository.appendDecisionsToDatabase = (database, decisions) => {
      if (failedAction && decisions.some((decision) => decision.action === failedAction)) {
        throw new Error("audit unavailable");
      }
      appendDecisionsToDatabase(database, decisions);
    };

    const hrCookie = await login(app, "hr@agent-gateway.local");
    const failedRequest = await app.inject({
      method: "POST",
      url: "/api/delegation-requests",
      headers: { cookie: hrCookie },
      payload: {
        requiredCapability: "finance.cost-analysis",
        prompt: "Estimate one aggregate hiring budget.",
      },
    });
    expect(failedRequest.statusCode).toBe(503);
    const requests = await app.inject({
      method: "GET",
      url: "/api/delegation-requests?box=outgoing",
      headers: { cookie: hrCookie },
    });
    expect(requests.json().requests).toEqual([]);

    const financeCookie = await login(app, "finance@agent-gateway.local");
    const createdAgent = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { cookie: financeCookie },
      payload: { name: "Finance Agent" },
    });
    const directPayload = {
      requiredCapability: "finance.cost-analysis",
      granteeHumanId: "22222222-2222-4222-8222-222222222222",
      agentId: createdAgent.json().agent.id,
      exactPrompt: "Estimate one approved aggregate budget.",
      approvedResourceIds: [],
      expiresInSeconds: 600,
    };
    failedAction = "delegation.approve";
    const failedIssue = await app.inject({
      method: "POST",
      url: "/api/delegation-contracts",
      headers: { cookie: financeCookie },
      payload: directPayload,
    });
    expect(failedIssue.statusCode).toBe(503);
    const noPasses = await app.inject({
      method: "GET",
      url: "/api/delegation-contracts?box=outgoing",
      headers: { cookie: financeCookie },
    });
    expect(noPasses.json().contracts).toEqual([]);

    failedAction = null;
    const issued = await app.inject({
      method: "POST",
      url: "/api/delegation-contracts",
      headers: { cookie: financeCookie },
      payload: directPayload,
    });
    const contractId = issued.json().contract.id as string;
    failedAction = "agent.invoke";
    const invokeCookie = await login(app, "hr@agent-gateway.local");
    const failedInvocation = await app.inject({
      method: "POST",
      url: `/api/delegation-contracts/${contractId}/invoke`,
      headers: { cookie: invokeCookie },
      payload: { content: directPayload.exactPrompt },
    });
    expect(failedInvocation.statusCode).toBe(503);
    const activeAfterFailedInvocation = await app.inject({
      method: "GET",
      url: "/api/delegation-contracts?box=outgoing",
      headers: { cookie: financeCookie },
    });
    expect(activeAfterFailedInvocation.json().contracts[0]).toMatchObject({
      id: contractId,
      status: "active",
      remainingUses: 1,
    });
    expect(runner.requests).toHaveLength(0);

    failedAction = "delegation.revoke";
    const failedRevoke = await app.inject({
      method: "POST",
      url: `/api/delegation-contracts/${contractId}/revoke`,
      headers: { cookie: financeCookie },
    });
    expect(failedRevoke.statusCode).toBe(503);
    const stillActive = await app.inject({
      method: "GET",
      url: "/api/delegation-contracts?box=outgoing",
      headers: { cookie: financeCookie },
    });
    expect(stillActive.json().contracts[0]).toMatchObject({
      id: contractId,
      status: "active",
      remainingUses: 1,
    });
    await app.close();
  });

  it("atomically consumes one pass and exposes only an isolated final result", async () => {
    const runner = new ControlledRunner();
    const { app, config, repository, service } = await makeHarness({}, runner);
    await mkdir(path.join(config.codexHome, "sessions"), { recursive: true });
    await writeFile(path.join(config.codexHome, "config.toml"), "model = 'safe'\n");
    await writeFile(
      path.join(config.codexHome, "sessions", "private-session.json"),
      "PRIVATE_SESSION_SENTINEL",
    );
    await writeFile(path.join(config.codexHome, "auth.json"), "PRIVATE_AUTH_SENTINEL");
    const financeCookie = await login(app, "finance@agent-gateway.local");
    const createdAgent = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { cookie: financeCookie },
      payload: {
        name: "Hidden Finance Agent",
        instructions: "PRIVATE_AGENT_INSTRUCTION_SENTINEL",
      },
    });
    const financeAgent = createdAgent.json().agent as {
      id: string;
      workspacePath: string;
    };
    const financeResource = RESOURCE_FIXTURES.find(
      (resource) => resource.ownerDepartment === "finance",
    )!;
    const exactPrompt = "Estimate the approved aggregate hiring budget.";
    const issued = await app.inject({
      method: "POST",
      url: "/api/delegation-contracts",
      headers: { cookie: financeCookie },
      payload: {
        requiredCapability: "finance.cost-analysis",
        granteeHumanId: "22222222-2222-4222-8222-222222222222",
        agentId: financeAgent.id,
        exactPrompt,
        approvedResourceIds: [financeResource.id],
        expiresInSeconds: 600,
      },
    });
    const contractId = issued.json().contract.id as string;
    const readResourceForDelegation =
      repository.readResourceForDelegation.bind(repository);
    let delegatedResourceReads = 0;
    repository.readResourceForDelegation = async (resourceId, ownerId) => {
      delegatedResourceReads += 1;
      return readResourceForDelegation(resourceId, ownerId);
    };
    const hrCookie = await login(app, "hr@agent-gateway.local");

    const researchCookie = await login(app, "research@agent-gateway.local");
    const wrongGrantee = await app.inject({
      method: "POST",
      url: `/api/delegation-contracts/${contractId}/invoke`,
      headers: { cookie: researchCookie },
      payload: { content: exactPrompt },
    });
    expect(wrongGrantee.statusCode).toBe(404);
    expect(wrongGrantee.body).not.toContain(financeAgent.id);
    expect(wrongGrantee.body).not.toContain("Hidden Finance Agent");
    const wrongGranteeAudit = await app.inject({
      method: "GET",
      url: "/api/authorization-decisions?limit=10",
      headers: { cookie: researchCookie },
    });
    expect(wrongGranteeAudit.json().decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          decision: "deny",
          reasonCode: "DELEGATION_GRANTEE_MISMATCH",
          agentId: null,
          agentName: null,
        }),
      ]),
    );

    const attempts = await Promise.all(
      Array.from({ length: 20 }, () =>
        app.inject({
          method: "POST",
          url: `/api/delegation-contracts/${contractId}/invoke`,
          headers: { cookie: hrCookie },
          payload: { content: exactPrompt },
        }),
      ),
    );
    const accepted = attempts.filter((response) => response.statusCode === 202);
    const denied = attempts.filter((response) => response.statusCode === 403);
    expect(accepted).toHaveLength(1);
    expect(denied).toHaveLength(19);
    expect(delegatedResourceReads).toBe(1);
    await expect.poll(() => runner.requests).toHaveLength(1);
    for (const response of denied) {
      expect(response.json()).toMatchObject({
        code: "AUTHORIZATION_DENIED",
        decision: {
          reasonCode: "DELEGATION_CONSUMED",
          agentId: null,
          agentName: null,
        },
      });
      expect(response.body).not.toContain("Hidden Finance Agent");
      expect(response.body).not.toContain(financeAgent.workspacePath);
    }

    const acceptedBody = accepted[0]!.json();
    expect(acceptedBody).toMatchObject({
      contract: {
        id: contractId,
        box: "incoming",
        status: "consumed",
        remainingUses: 0,
      },
      decision: {
        decision: "allow",
        reasonCode: "DELEGATION_ACTIVE",
        agentId: null,
        agentName: null,
      },
      result: { status: "queued", output: null },
    });
    expect(JSON.stringify(acceptedBody.contract)).not.toContain(financeAgent.id);
    expect(JSON.stringify(acceptedBody.contract)).not.toContain("Hidden Finance Agent");

    const delegatedRequest = runner.requests[0]!;
    expect(delegatedRequest.threadId).toBeNull();
    expect(delegatedRequest.workspacePath).not.toBe(financeAgent.workspacePath);
    expect(delegatedRequest.workspacePath).toContain(`${path.sep}.delegated${path.sep}`);
    expect(delegatedRequest.codexHome).toBeDefined();
    expect(delegatedRequest.codexHome).not.toBe(config.codexHome);
    expect(delegatedRequest.codexHome).toContain(
      `${path.sep}delegated-codex-homes${path.sep}`,
    );
    expect(await readdir(delegatedRequest.workspacePath)).toEqual([
      "AGENTS.md",
      "approved-input-1.md",
    ]);
    const delegatedInstructions = await readFile(
      path.join(delegatedRequest.workspacePath, "AGENTS.md"),
      "utf8",
    );
    expect(delegatedInstructions).not.toContain("Hidden Finance Agent");
    expect(delegatedInstructions).not.toContain("PRIVATE_AGENT_INSTRUCTION_SENTINEL");
    expect(await readdir(delegatedRequest.codexHome!)).toEqual(["config.toml"]);
    await expect(
      access(path.join(delegatedRequest.codexHome!, "sessions")),
    ).rejects.toThrow();
    await expect(
      access(path.join(delegatedRequest.codexHome!, "auth.json")),
    ).rejects.toThrow();
    expect(
      await readFile(
        path.join(delegatedRequest.workspacePath, "approved-input-1.md"),
        "utf8",
      ),
    ).toContain("Quarterly budget");
    expect(service.getAgent(financeAgent.id).codexThreadId).toBeNull();

    const changedRetry = await app.inject({
      method: "POST",
      url: `/api/delegation-contracts/${contractId}/invoke`,
      headers: { cookie: hrCookie },
      payload: { content: exactPrompt + " changed" },
    });
    expect(changedRetry.statusCode).toBe(403);
    expect(changedRetry.json()).toMatchObject({
      decision: { reasonCode: "DELEGATION_CONSUMED" },
    });

    const genericAgentRead = await app.inject({
      method: "GET",
      url: `/api/agents/${financeAgent.id}`,
      headers: { cookie: hrCookie },
    });
    expect(genericAgentRead.statusCode).toBe(403);
    const genericRunRead = await app.inject({
      method: "GET",
      url: `/api/runs/${acceptedBody.result.id}`,
      headers: { cookie: hrCookie },
    });
    expect(genericRunRead.statusCode).toBe(403);

    runner.finish("Final approved budget impact: SGD 1.2M. test-key");
    await expect
      .poll(async () => {
        const result = await app.inject({
          method: "GET",
          url: `/api/delegation-contracts/${contractId}/result`,
          headers: { cookie: hrCookie },
        });
        return result.json().result?.status;
      })
      .toBe("completed");
    const resultResponse = await app.inject({
      method: "GET",
      url: `/api/delegation-contracts/${contractId}/result`,
      headers: { cookie: hrCookie },
    });
    expect(resultResponse.json()).toMatchObject({
      contractStatus: "consumed",
      result: {
        id: acceptedBody.result.id,
        status: "completed",
        output: "Final approved budget impact: SGD 1.2M. [secret redacted]",
        error: null,
      },
    });
    for (const forbidden of [
      financeAgent.id,
      financeAgent.workspacePath,
      "Hidden Finance Agent",
      "PRIVATE_AGENT_INSTRUCTION_SENTINEL",
      "must-not-persist",
      "usage",
      "prompt",
      "test-key",
    ]) {
      expect(resultResponse.body).not.toContain(forbidden);
    }
    await expect(access(delegatedRequest.workspacePath)).rejects.toThrow();
    await expect(access(delegatedRequest.codexHome!)).rejects.toThrow();
    expect(service.getAgent(financeAgent.id).codexThreadId).toBeNull();

    const audit = await app.inject({
      method: "GET",
      url: "/api/authorization-decisions?limit=100",
      headers: { cookie: hrCookie },
    });
    const delegatedDecisions = audit
      .json()
      .decisions.filter(
        (decision: { targetType: string }) => decision.targetType === "delegation",
      );
    expect(delegatedDecisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          decision: "allow",
          reasonCode: "DELEGATION_ACTIVE",
          agentId: null,
          agentName: null,
        }),
        expect.objectContaining({
          decision: "deny",
          reasonCode: "DELEGATION_CONSUMED",
          agentId: null,
          agentName: null,
        }),
      ]),
    );
    expect(audit.json().decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "resource.read",
          targetType: "resource",
          targetId: "redacted",
          targetLabel: "Approved delegated input",
          agentId: null,
          agentName: null,
        }),
      ]),
    );

    const ownerAudit = await app.inject({
      method: "GET",
      url: "/api/authorization-decisions?limit=100",
      headers: { cookie: financeCookie },
    });
    expect(ownerAudit.json().decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          humanUserId: "22222222-2222-4222-8222-222222222222",
          agentId: financeAgent.id,
          action: "resource.read",
          targetId: financeResource.id,
          decision: "allow",
          reasonCode: "DELEGATION_ACTIVE",
        }),
      ]),
    );

    const ownerRun = await app.inject({
      method: "POST",
      url: `/api/agents/${financeAgent.id}/messages`,
      headers: { cookie: financeCookie },
      payload: { content: "Run npm test" },
    });
    expect(ownerRun.statusCode).toBe(202);
    await expect.poll(() => runner.requests).toHaveLength(2);
    await app.close();
  }, 20_000);

  it("rejects an altered task without consuming the active pass", async () => {
    const { app, runner } = await makeHarness();
    const financeCookie = await login(app, "finance@agent-gateway.local");
    const createdAgent = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { cookie: financeCookie },
      payload: { name: "Finance Agent" },
    });
    const agentId = createdAgent.json().agent.id as string;
    const exactPrompt = "Estimate one approved budget.";
    const issued = await app.inject({
      method: "POST",
      url: "/api/delegation-contracts",
      headers: { cookie: financeCookie },
      payload: {
        requiredCapability: "finance.cost-analysis",
        granteeHumanId: "22222222-2222-4222-8222-222222222222",
        agentId,
        exactPrompt,
        approvedResourceIds: [],
        expiresInSeconds: 600,
      },
    });
    const contractId = issued.json().contract.id as string;
    const hrCookie = await login(app, "hr@agent-gateway.local");
    const changed = await app.inject({
      method: "POST",
      url: `/api/delegation-contracts/${contractId}/invoke`,
      headers: { cookie: hrCookie },
      payload: { content: exactPrompt + " " },
    });
    expect(changed.statusCode).toBe(403);
    expect(changed.json()).toMatchObject({
      decision: { reasonCode: "DELEGATION_PROMPT_MISMATCH" },
    });
    expect(runner.requests).toHaveLength(0);

    const stillActive = await app.inject({
      method: "GET",
      url: "/api/delegation-contracts?box=incoming",
      headers: { cookie: hrCookie },
    });
    expect(stillActive.json().contracts[0]).toMatchObject({
      id: contractId,
      status: "active",
      remainingUses: 1,
    });

    const exact = await app.inject({
      method: "POST",
      url: `/api/delegation-contracts/${contractId}/invoke`,
      headers: { cookie: hrCookie },
      payload: { content: exactPrompt },
    });
    expect(exact.statusCode).toBe(202);
    await expect.poll(() => runner.requests).toHaveLength(1);
    await app.close();
  });

  it("refuses delegated execution without the isolated container boundary", async () => {
    const { app, runner } = await makeHarness({ RUNTIME_PROVIDER: "local-process" });
    const financeCookie = await login(app, "finance@agent-gateway.local");
    const createdAgent = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { cookie: financeCookie },
      payload: { name: "Finance Agent" },
    });
    const exactPrompt = "Estimate the approved aggregate budget.";
    const issued = await app.inject({
      method: "POST",
      url: "/api/delegation-contracts",
      headers: { cookie: financeCookie },
      payload: {
        requiredCapability: "finance.cost-analysis",
        granteeHumanId: "22222222-2222-4222-8222-222222222222",
        agentId: createdAgent.json().agent.id,
        exactPrompt,
        approvedResourceIds: [],
        expiresInSeconds: 600,
      },
    });
    const contractId = issued.json().contract.id as string;
    const hrCookie = await login(app, "hr@agent-gateway.local");

    const response = await app.inject({
      method: "POST",
      url: `/api/delegation-contracts/${contractId}/invoke`,
      headers: { cookie: hrCookie },
      payload: { content: exactPrompt },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      code: "DELEGATED_RUNTIME_ISOLATION_REQUIRED",
    });
    expect(runner.requests).toHaveLength(0);
    const passes = await app.inject({
      method: "GET",
      url: "/api/delegation-contracts?box=incoming",
      headers: { cookie: hrCookie },
    });
    expect(passes.json().contracts[0]).toMatchObject({
      id: contractId,
      status: "active",
      remainingUses: 1,
    });
    await app.close();
  });

  it("does not admit a delegated Run when the owner stops during input preflight", async () => {
    const { app, repository, runner } = await makeHarness();
    const financeCookie = await login(app, "finance@agent-gateway.local");
    const createdAgent = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { cookie: financeCookie },
      payload: { name: "Finance Agent" },
    });
    const agentId = createdAgent.json().agent.id as string;
    const exactPrompt = "Calculate the approved aggregate budget.";
    const financeResource = RESOURCE_FIXTURES.find(
      (resource) => resource.ownerDepartment === "finance",
    )!;
    const issued = await app.inject({
      method: "POST",
      url: "/api/delegation-contracts",
      headers: { cookie: financeCookie },
      payload: {
        requiredCapability: "finance.cost-analysis",
        granteeHumanId: "22222222-2222-4222-8222-222222222222",
        agentId,
        exactPrompt,
        approvedResourceIds: [financeResource.id],
        expiresInSeconds: 600,
      },
    });
    const contractId = issued.json().contract.id as string;
    const hrCookie = await login(app, "hr@agent-gateway.local");

    let inputReadEntered!: () => void;
    let releaseInputRead!: () => void;
    const inputReadPending = new Promise<void>((resolve) => {
      inputReadEntered = resolve;
    });
    const inputReadRelease = new Promise<void>((resolve) => {
      releaseInputRead = resolve;
    });
    const readResourceForDelegation =
      repository.readResourceForDelegation.bind(repository);
    repository.readResourceForDelegation = async (resourceId, ownerId) => {
      inputReadEntered();
      await inputReadRelease;
      return readResourceForDelegation(resourceId, ownerId);
    };

    const invocationPromise = app.inject({
      method: "POST",
      url: `/api/delegation-contracts/${contractId}/invoke`,
      headers: { cookie: hrCookie },
      payload: { content: exactPrompt },
    });
    await inputReadPending;
    const stopped = await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/stop`,
      headers: { cookie: financeCookie },
    });
    expect(stopped.statusCode).toBe(200);
    expect(stopped.json().agent.status).toBe("stopped");
    releaseInputRead();

    const invocation = await invocationPromise;
    expect(invocation.statusCode).toBe(409);
    const result = await app.inject({
      method: "GET",
      url: `/api/delegation-contracts/${contractId}/result`,
      headers: { cookie: hrCookie },
    });
    expect(result.json()).toMatchObject({
      contractStatus: "active",
      result: null,
    });
    expect(runner.requests).toHaveLength(0);
    await app.close();
  });

  it("serializes pass revocation against invocation so only one transition wins", async () => {
    const { app, runner } = await makeHarness();
    const financeCookie = await login(app, "finance@agent-gateway.local");
    const createdAgent = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { cookie: financeCookie },
      payload: { name: "Finance Agent" },
    });
    const exactPrompt = "Calculate one approved budget scenario.";
    const issued = await app.inject({
      method: "POST",
      url: "/api/delegation-contracts",
      headers: { cookie: financeCookie },
      payload: {
        requiredCapability: "finance.cost-analysis",
        granteeHumanId: "22222222-2222-4222-8222-222222222222",
        agentId: createdAgent.json().agent.id,
        exactPrompt,
        approvedResourceIds: [],
        expiresInSeconds: 600,
      },
    });
    const contractId = issued.json().contract.id as string;
    const hrCookie = await login(app, "hr@agent-gateway.local");

    const [invocation, revocation] = await Promise.all([
      app.inject({
        method: "POST",
        url: `/api/delegation-contracts/${contractId}/invoke`,
        headers: { cookie: hrCookie },
        payload: { content: exactPrompt },
      }),
      app.inject({
        method: "POST",
        url: `/api/delegation-contracts/${contractId}/revoke`,
        headers: { cookie: financeCookie },
      }),
    ]);

    if (invocation.statusCode === 202) {
      expect(revocation.statusCode).toBe(409);
      await expect.poll(() => runner.requests).toHaveLength(1);
    } else {
      expect(invocation.statusCode).toBe(403);
      expect(invocation.json()).toMatchObject({
        decision: { reasonCode: "DELEGATION_REVOKED" },
      });
      expect(revocation.statusCode).toBe(200);
      expect(runner.requests).toHaveLength(0);
    }

    const ownerView = await app.inject({
      method: "GET",
      url: "/api/delegation-contracts?box=outgoing",
      headers: { cookie: financeCookie },
    });
    expect(ownerView.json().contracts[0].status).toMatch(/^(consumed|revoked)$/);
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
