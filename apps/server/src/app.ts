import fastifyCookie from "@fastify/cookie";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
} from "fastify";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { AgentService } from "./agent-service.js";
import type { AppConfig } from "./config.js";
import { HttpError } from "./errors.js";
import {
  FRONTEND_PRINCIPAL,
  type HumanPrincipal,
} from "./identity-provider.js";
import type { TrustGateway } from "./trust-gateway.js";
import type { Agent, AuthorizationAction } from "./types.js";

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
const loginBody = z.object({
  email: z.string().trim().email().max(320),
  password: z.string().max(4_096).optional(),
});

export async function createApp(
  config: AppConfig,
  service: AgentService,
  gateway: TrustGateway,
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

  app.post("/api/agents/:id/files/read", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    const body = workspaceFileReadBody.parse(request.body);
    return gateway.readWorkspaceFile(
      requirePrincipal(request),
      id,
      body.path,
      String(request.id),
    );
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
    return reply.code(statusCode).send({
      error: appError.message,
      ...(error instanceof HttpError && error.code ? { code: error.code } : {}),
      ...(error instanceof HttpError &&
      (error.code === "AUTHORIZATION_DENIED" || error.code === "RUNTIME_ACTION_DENIED")
        ? { decision: error.details }
        : {}),
      ...(validationError ? { details: error.issues } : {}),
    });
  });

  return app;
}

function requirePrincipal(request: FastifyRequest): HumanPrincipal {
  if (!request.principal) throw new HttpError(401, "Authentication required");
  return request.principal;
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
