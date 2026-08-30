import fastifyCookie from "@fastify/cookie";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { AgentService } from "./agent-service.js";
import type { AppConfig } from "./config.js";
import type { DelegationService } from "./delegation-service.js";
import { HttpError } from "./errors.js";
import {
  FRONTEND_PRINCIPAL,
  type HumanPrincipal,
} from "./identity-provider.js";
import type { TrustGateway } from "./trust-gateway.js";
import type { Agent, AuthorizationAction, AuthorizationDecision } from "./types.js";

declare module "fastify" {
  interface FastifyRequest {
    principal: HumanPrincipal | null;
    userAccessToken: string;
  }
}

const SESSION_COOKIE = "agent_trust_session";
const agentIdParams = z.object({ id: z.string().uuid() });
const runIdParams = z.object({ id: z.string().uuid() });
const resourceParams = z.object({
  id: z.string().uuid(),
  resourceId: z.string().uuid(),
});
const decisionQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const createAgentBody = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).optional(),
  instructions: z.string().max(10_000).optional(),
});
const updateAgentBody = createAgentBody.partial().refine(
  (value) => Object.keys(value).length > 0,
  "At least one field is required",
);
const messageBody = z.object({
  content: z.string().trim().min(1).max(50_000),
});
const workspaceFileReadBody = z.object({
  path: z.string().trim().min(1).max(1_024),
});
const runtimeActionEvaluationBody = z.object({
  type: z.literal("shell"),
  command: z.string().trim().min(1).max(10_000),
});
const loginBody = z.object({
  email: z.string().trim().email().max(320),
  password: z.string().max(4_096).optional(),
});
const capabilityDiscoveryBody = z
  .object({
    prompt: z.string().min(1).max(50_000).refine((value) => value.trim().length > 0),
  })
  .strict();
const createDelegationRequestBody = z
  .object({
    requiredCapability: z.string().min(1).max(120),
    prompt: z.string().min(1).max(50_000).refine((value) => value.trim().length > 0),
  })
  .strict();
const delegationRequestQuery = z
  .object({ box: z.enum(["incoming", "outgoing"]) })
  .strict();
const delegationIdParams = z.object({ id: z.string().uuid() }).strict();
const delegationScopeFields = {
  agentId: z.string().uuid(),
  approvedResourceIds: z.array(z.string().uuid()).max(20).default([]),
  expiresInSeconds: z.coerce.number().int().min(60).max(600).default(600),
};
const approveDelegationRequestBody = z.object(delegationScopeFields).strict();
const createDelegationContractBody = z
  .object({
    requiredCapability: z.string().min(1).max(120),
    granteeHumanId: z.string().uuid(),
    exactPrompt: z.string().min(1).max(50_000).refine((value) => value.trim().length > 0),
    ...delegationScopeFields,
  })
  .strict();
const delegationContractQuery = z
  .object({ box: z.enum(["incoming", "outgoing"]) })
  .strict();
const invokeDelegationContractBody = z
  .object({
    content: z.string().min(1).max(50_000).refine((value) => value.trim().length > 0),
  })
  .strict();

export async function createApp(
  config: AppConfig,
  service: AgentService,
  gateway: TrustGateway,
  delegations: DelegationService,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: [
        "req.headers.authorization",
        "req.headers.cookie",
        "req.body.password",
      ],
    },
    bodyLimit: 1_048_576,
  });

  await app.register(fastifyCookie);
  await app.register(cors, {
    origin:
      config.nodeEnv === "development"
        ? ["http://localhost:5173", "http://127.0.0.1:5173"]
        : false,
    credentials: true,
  });

  app.decorateRequest("principal", null);
  app.decorateRequest("userAccessToken", "");
  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/api/") || isPublicAuthRoute(request)) return;

    if (config.authMode === "legacy") {
      if (config.authToken && !validSharedToken(request, config.authToken)) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      request.principal = { ...FRONTEND_PRINCIPAL };
      request.userAccessToken = config.authToken || "legacy-loopback";
      return;
    }

    const accessToken = request.cookies[SESSION_COOKIE] ?? "";
    if (!accessToken) {
      return reply.code(401).send({ error: "Authentication required" });
    }
    try {
      request.principal = await gateway.authenticate(accessToken);
      request.userAccessToken = accessToken;
      await delegations.observePrincipal(request.principal);
    } catch {
      return reply.code(401).send({ error: "Authentication required" });
    }
  });

  app.get("/api/health", async () => ({
    ok: true,
    service: "agent-trust-gateway",
  }));

  app.get("/api/auth", async () => ({
    mode: config.authMode,
    legacyTokenRequired: config.authMode === "legacy" && config.authToken.length > 0,
    demoUsers: gateway.demoPrincipals,
  }));

  app.post("/api/auth/login", async (request, reply) => {
    if (config.authMode === "legacy") {
      throw new HttpError(400, "Legacy mode uses the deployment access token");
    }
    const credentials = loginBody.parse(request.body);
    const session = await gateway.signIn({
      email: credentials.email,
      ...(credentials.password === undefined ? {} : { password: credentials.password }),
    });
    await delegations.observePrincipal(session.principal);
    const expiresInSeconds = Math.max(
      60,
      Math.floor((new Date(session.expiresAt).getTime() - Date.now()) / 1_000),
    );
    reply.setCookie(SESSION_COOKIE, session.accessToken, {
      httpOnly: true,
      sameSite: "strict",
      secure: config.authCookieSecure,
      path: "/",
      maxAge: expiresInSeconds,
    });
    return { principal: session.principal };
  });

  app.post("/api/auth/logout", async (_request, reply) => {
    reply.clearCookie(SESSION_COOKIE, {
      httpOnly: true,
      sameSite: "strict",
      secure: config.authCookieSecure,
      path: "/",
    });
    return { ok: true };
  });

  app.get("/api/me", async (request) => ({ principal: requirePrincipal(request) }));
  app.get("/api/system", async () => service.systemInfo());

  app.post("/api/capability-discovery", async (request) => {
    ensureDelegationAvailable(config);
    const body = capabilityDiscoveryBody.parse(request.body);
    return delegations.discover(requirePrincipal(request), body.prompt);
  });

  app.get("/api/delegation-recipients", async (request) => {
    ensureDelegationAvailable(config);
    return { recipients: delegations.listRecipients(requirePrincipal(request)) };
  });

  app.post("/api/delegation-requests", async (request, reply) => {
    ensureDelegationAvailable(config);
    const body = createDelegationRequestBody.parse(request.body);
    const result = await delegations.createRequest(
      requirePrincipal(request),
      {
        requiredCapability: body.requiredCapability,
        prompt: body.prompt,
      },
      String(request.id),
    );
    return reply.code(201).send(result);
  });

  app.get("/api/delegation-requests", async (request) => {
    ensureDelegationAvailable(config);
    const { box } = delegationRequestQuery.parse(request.query);
    return delegations.listRequests(requirePrincipal(request), box);
  });

  app.post("/api/delegation-requests/:id/reject", async (request) => {
    ensureDelegationAvailable(config);
    const { id } = delegationIdParams.parse(request.params);
    return delegations.rejectRequest(
      requirePrincipal(request),
      id,
      String(request.id),
    );
  });

  app.post("/api/delegation-requests/:id/approve", async (request) => {
    ensureDelegationAvailable(config);
    const { id } = delegationIdParams.parse(request.params);
    const body = approveDelegationRequestBody.parse(request.body);
    return delegations.approveRequest(
      requirePrincipal(request),
      id,
      body,
      String(request.id),
    );
  });

  app.post("/api/delegation-contracts", async (request, reply) => {
    ensureDelegationAvailable(config);
    const body = createDelegationContractBody.parse(request.body);
    const result = await delegations.createContract(
      requirePrincipal(request),
      {
        requiredCapability: body.requiredCapability,
        granteeHumanId: body.granteeHumanId,
        agentId: body.agentId,
        exactPrompt: body.exactPrompt,
        approvedResourceIds: body.approvedResourceIds,
        expiresInSeconds: body.expiresInSeconds,
      },
      String(request.id),
    );
    return reply.code(201).send(result);
  });

  app.get("/api/delegation-contracts", async (request) => {
    ensureDelegationAvailable(config);
    const { box } = delegationContractQuery.parse(request.query);
    return delegations.listContracts(requirePrincipal(request), box);
  });

  app.post("/api/delegation-contracts/:id/revoke", async (request) => {
    ensureDelegationAvailable(config);
    const { id } = delegationIdParams.parse(request.params);
    return delegations.revokeContract(
      requirePrincipal(request),
      id,
      String(request.id),
    );
  });

  app.post("/api/delegation-contracts/:id/invoke", async (request, reply) => {
    ensureDelegationAvailable(config);
    const { id } = delegationIdParams.parse(request.params);
    const body = invokeDelegationContractBody.parse(request.body);
    const result = await delegations.invokeContract(
      requirePrincipal(request),
      id,
      body.content,
      String(request.id),
    );
    return reply.code(202).send(result);
  });

  app.get("/api/delegation-contracts/:id/result", async (request) => {
    ensureDelegationAvailable(config);
    const { id } = delegationIdParams.parse(request.params);
    return delegations.delegatedResult(requirePrincipal(request), id);
  });

  app.get("/api/agents", async (request) => {
    const principal = requirePrincipal(request);
    return {
      agents:
        config.authMode === "legacy"
          ? service.listAgents()
          : service.listAgents(principal.id),
    };
  });

  app.post("/api/agents", async (request, reply) => {
    const principal = requirePrincipal(request);
    const body = createAgentBody.parse(request.body);
    const agent = await service.createAgent(principal.id, principal.department, body);
    await gateway.recordAgentCreated(principal, agent, String(request.id));
    return reply.code(201).send({ agent });
  });

  app.get("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    const agent = await authorizeAgent(request, id, "agent.read");
    return { agent };
  });

  app.patch("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    await authorizeAgent(request, id, "agent.update");
    const body = updateAgentBody.parse(request.body);
    return { agent: await service.updateAgent(id, body) };
  });

  app.delete("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    await authorizeAgent(request, id, "agent.delete");
    return service.deleteAgent(id);
  });

  app.post("/api/agents/:id/start", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    await authorizeAgent(request, id, "agent.start");
    return { agent: await service.startAgent(id) };
  });

  app.post("/api/agents/:id/stop", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    await authorizeAgent(request, id, "agent.stop");
    return { agent: await service.stopAgent(id) };
  });

  app.post("/api/agents/:id/revoke", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return gateway.revokeAgent(requirePrincipal(request), id, String(request.id));
  });

  app.get("/api/agents/:id/messages", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    await authorizeAgent(request, id, "agent.read");
    return { messages: service.getMessages(id) };
  });

  app.get("/api/agents/:id/runs", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    await authorizeAgent(request, id, "agent.read");
    return { runs: service.getRuns(id) };
  });

  app.post("/api/agents/:id/messages", async (request, reply) => {
    const { id } = agentIdParams.parse(request.params);
    await authorizeAgent(request, id, "agent.invoke", true);
    const body = messageBody.parse(request.body);
    const principal = requirePrincipal(request);
    const result = await service.sendMessage(id, body.content, {
      humanUserId: principal.id,
      humanEmail: principal.email,
      humanDepartment: principal.department,
      requestId: String(request.id),
    });
    return reply.code(202).send(result);
  });

  app.post("/api/agents/:id/runtime-actions/evaluate", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    await authorizeAgent(request, id, "agent.invoke");
    const body = runtimeActionEvaluationBody.parse(request.body);
    const principal = requirePrincipal(request);
    return {
      decision: await service.evaluateRuntimeShellAction(id, body.command, {
        humanUserId: principal.id,
        humanEmail: principal.email,
        humanDepartment: principal.department,
        requestId: String(request.id),
      }),
    };
  });

  app.get("/api/runs/:id", async (request) => {
    const { id } = runIdParams.parse(request.params);
    if (config.authMode !== "legacy") {
      await gateway.authorizeRun(requirePrincipal(request), id, String(request.id));
    }
    return { run: service.getRun(id) };
  });

  app.get("/api/resources", async (request) => ({
    resources: await gateway.listResources(requirePrincipal(request)),
  }));

  app.post("/api/authorization-probes/cross-owner-agent", async (request) =>
    gateway.probeCrossOwnerAgent(requirePrincipal(request), String(request.id)),
  );

  app.post("/api/agents/:id/resources/:resourceId/read", async (request) => {
    const { id, resourceId } = resourceParams.parse(request.params);
    const principal = requirePrincipal(request);
    const result = await gateway.readResource(
      principal,
      request.userAccessToken,
      id,
      resourceId,
      String(request.id),
    );
    const { storageKey: _storageKey, ...resource } = result.resource.resource;
    return {
      resource: {
        summary: { ...resource, ownedByCurrentUser: resource.ownerId === principal.id },
        content: result.resource.content,
      },
      decision: result.decision,
    };
  });

  app.post("/api/agents/:id/resources/cross-owner-demo", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    const principal = requirePrincipal(request);
    return gateway.demonstrateCrossOwnerResourceDenial(
      principal,
      request.userAccessToken,
      id,
      String(request.id),
    );
  });

  app.post("/api/agents/:id/files/read", async (request, reply) => {
    const { id } = agentIdParams.parse(request.params);
    const body = workspaceFileReadBody.parse(request.body);
    try {
      return await gateway.readWorkspaceFile(
        requirePrincipal(request),
        id,
        body.path,
        String(request.id),
      );
    } catch (error) {
      if (isDecisionDenial(error)) {
        return sendDeniedDecision(reply, error.details, error.code, error.message);
      }
      throw error;
    }
  });

  app.get("/api/authorization-decisions", async (request) => {
    const { limit } = decisionQuery.parse(request.query);
    return {
      decisions: await gateway.listDecisions(requirePrincipal(request), limit),
    };
  });

  async function authorizeAgent(
    request: FastifyRequest,
    agentId: string,
    action: AuthorizationAction,
    auditAllow = false,
  ): Promise<Agent> {
    if (config.authMode === "legacy") return service.getAgent(agentId);
    return gateway.authorizeAgent(
      requirePrincipal(request),
      agentId,
      action,
      String(request.id),
      { auditAllow },
    );
  }

  app.setErrorHandler((error, request, reply) => {
    const appError = error instanceof Error ? error : new Error(String(error));
    const validationError = error instanceof z.ZodError;
    const frameworkStatus =
      typeof (error as { statusCode?: unknown }).statusCode === "number"
        ? (error as { statusCode: number }).statusCode
        : null;
    const statusCode =
      error instanceof HttpError
        ? error.statusCode
        : validationError
          ? 400
          : frameworkStatus && frameworkStatus >= 400 && frameworkStatus <= 599
            ? frameworkStatus
            : 500;
    if (statusCode >= 500) request.log.error(appError);
    if (isDecisionDenial(error)) {
      return sendDeniedDecision(reply, error.details, error.code, appError.message);
    }
    const publicMessage =
      statusCode >= 500 && !(error instanceof HttpError)
        ? "Internal server error"
        : appError.message;
    return reply.code(statusCode).send({
      error: publicMessage,
      ...(error instanceof HttpError && error.code ? { code: error.code } : {}),
      ...(error instanceof HttpError &&
      (error.code === "AUTHORIZATION_DENIED" || error.code === "RUNTIME_ACTION_DENIED")
        ? { decision: error.details }
        : {}),
      ...(validationError ? { details: error.issues } : {}),
    });
  });

  if (config.nodeEnv === "production") {
    const webRoot = fileURLToPath(new URL("../../web/dist", import.meta.url));
    await app.register(fastifyStatic, {
      root: webRoot,
      prefix: "/",
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) {
        return reply.code(404).send({ error: "API route not found" });
      }
      return reply.sendFile("index.html");
    });
  }

  return app;
}

function isDecisionDenial(
  error: unknown,
): error is HttpError & {
  code: "AUTHORIZATION_DENIED" | "RUNTIME_ACTION_DENIED";
  details: AuthorizationDecision;
} {
  if (!(error instanceof HttpError) || error.statusCode !== 403) return false;
  if (error.code !== "AUTHORIZATION_DENIED" && error.code !== "RUNTIME_ACTION_DENIED") return false;
  const decision = error.details;
  return !!decision && typeof decision === "object" &&
    (decision as Partial<AuthorizationDecision>).decision === "deny";
}

function sendDeniedDecision(
  reply: FastifyReply,
  decision: AuthorizationDecision,
  code: "AUTHORIZATION_DENIED" | "RUNTIME_ACTION_DENIED",
  message: string,
) {
  return reply.code(403).send({
    statusCode: 403,
    code,
    error: "Forbidden",
    message,
    decision,
  });
}

function requirePrincipal(request: FastifyRequest): HumanPrincipal {
  if (!request.principal) throw new HttpError(401, "Authentication required");
  return request.principal;
}

function ensureDelegationAvailable(config: AppConfig): void {
  if (config.authMode === "legacy") {
    throw new HttpError(
      400,
      "Trust Pass delegation requires authenticated human identities",
    );
  }
}

function isPublicAuthRoute(request: FastifyRequest): boolean {
  const requestPath = request.url.split("?", 1)[0];
  if (requestPath === "/api/health" || requestPath === "/api/auth") return true;
  return (
    request.method === "POST" &&
    (requestPath === "/api/auth/login" || requestPath === "/api/auth/logout")
  );
}

function validSharedToken(request: FastifyRequest, expected: string): boolean {
  const header = request.headers.authorization ?? "";
  const candidate = header.startsWith("Bearer ") ? header.slice(7) : "";
  const expectedBuffer = Buffer.from(expected);
  const candidateBuffer = Buffer.from(candidate);
  return (
    candidateBuffer.length === expectedBuffer.length &&
    timingSafeEqual(candidateBuffer, expectedBuffer)
  );
}
