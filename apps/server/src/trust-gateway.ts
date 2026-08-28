import { randomUUID } from "node:crypto";
import type { AgentService } from "./agent-service.js";
import { HttpError } from "./errors.js";
import {
  DEMO_PRINCIPALS,
  type HumanPrincipal,
  type IdentityProvider,
  type IdentitySession,
  type LoginCredentials,
} from "./identity-provider.js";
import type {
  ResourceReadResult,
  SecurityRepository,
} from "./security-repository.js";
import type {
  Agent,
  AuthorizationAction,
  AuthorizationDecision,
  ProtectedResource,
  ProtectedResourceSummary,
} from "./types.js";

export interface AuthorizedResourceRead {
  resource: ResourceReadResult;
  decision: AuthorizationDecision;
}

interface AgentAuthorizationOptions {
  auditAllow?: boolean;
  targetType?: "agent" | "run";
  targetId?: string;
  targetLabel?: string;
}

export class TrustGateway {
  constructor(
    private readonly identityProvider: IdentityProvider,
    private readonly securityRepository: SecurityRepository,
    private readonly agents: AgentService,
  ) {}

  get demoPrincipals(): HumanPrincipal[] {
    return DEMO_PRINCIPALS.map((principal) => ({ ...principal }));
  }

  async signIn(credentials: LoginCredentials): Promise<IdentitySession> {
    return this.identityProvider.signIn(credentials);
  }

  async authenticate(accessToken: string): Promise<HumanPrincipal> {
    return this.identityProvider.verifyAccessToken(accessToken);
  }

  async authorizeAgent(
    principal: HumanPrincipal,
    agentId: string,
    action: AuthorizationAction,
    requestId: string,
    options: AgentAuthorizationOptions = {},
  ): Promise<Agent> {
    const agent = this.agents.getAgent(agentId);
    const allowed = agent.ownerId === principal.id;
    const targetType = options.targetType ?? "agent";
    const targetId = options.targetId ?? agent.id;
    const targetLabel =
      options.targetLabel ?? (allowed ? agent.name : "Protected Agent");
    const decision = this.makeDecision({
      principal,
      requestId,
      agent,
      action,
      targetType,
      targetId,
      targetLabel,
      allowed,
      reasonCode: allowed ? "OWNER_MATCH" : "HUMAN_AGENT_OWNER_MISMATCH",
      reason: allowed
        ? "The authenticated user owns the requested Agent."
        : "The authenticated user does not own the requested Agent.",
      redactAgent: !allowed,
    });
    if (!allowed) {
      await this.appendDeniedDecision(decision);
      throw deniedError(decision);
    }
    if (options.auditAllow) await this.appendAllowedDecision(decision);
    return agent;
  }

  async authorizeRun(
    principal: HumanPrincipal,
    runId: string,
    requestId: string,
  ): Promise<void> {
    const run = this.agents.getRun(runId);
    await this.authorizeAgent(principal, run.agentId, "run.read", requestId, {
      targetType: "run",
      targetId: run.id,
      targetLabel: "Run " + run.id.slice(0, 8),
    });
  }

  async recordAgentCreated(
    principal: HumanPrincipal,
    agent: Agent,
    requestId: string,
  ): Promise<AuthorizationDecision> {
    const decision = this.makeDecision({
      principal,
      requestId,
      agent,
      action: "agent.create",
      targetType: "agent",
      targetId: agent.id,
      targetLabel: agent.name,
      allowed: true,
      reasonCode: "OWNER_MATCH",
      reason: "The backend assigned the new Agent to the authenticated user.",
    });
    await this.appendAllowedDecision(decision);
    return decision;
  }

  async listResources(principal: HumanPrincipal): Promise<ProtectedResourceSummary[]> {
    const resources = await this.securityRepository.listResources();
    return resources.map(({ storageKey: _storageKey, ...resource }) => ({
      ...resource,
      ownedByCurrentUser: resource.ownerId === principal.id,
    }));
  }

  async readResource(
    principal: HumanPrincipal,
    userAccessToken: string,
    agentId: string,
    resourceId: string,
    requestId: string,
  ): Promise<AuthorizedResourceRead> {
    const [agent, resources] = await Promise.all([
      Promise.resolve(this.agents.getAgent(agentId)),
      this.securityRepository.listResources(),
    ]);
    const resource = resources.find((candidate) => candidate.id === resourceId);
    if (!resource) throw new HttpError(404, "Protected resource not found");

    if (agent.ownerId !== principal.id) {
      const decision = this.resourceDecision(
        principal,
        requestId,
        agent,
        resource,
        false,
        "HUMAN_AGENT_OWNER_MISMATCH",
        "The authenticated user cannot act through an Agent owned by another user.",
        true,
      );
      await this.appendDeniedDecision(decision);
      throw deniedError(decision);
    }
    if (agent.ownerId !== resource.ownerId) {
      const decision = this.resourceDecision(
        principal,
        requestId,
        agent,
        resource,
        false,
        "AGENT_RESOURCE_OWNER_MISMATCH",
        "The Agent owner and protected resource owner do not match.",
      );
      await this.appendDeniedDecision(decision);
      throw deniedError(decision);
    }

    const result = await this.securityRepository.readResource(
      resource.id,
      userAccessToken,
    );
    if (!result) {
      throw new HttpError(
        503,
        "The protected resource could not be read under the active data policy",
        { code: "RESOURCE_POLICY_UNAVAILABLE" },
      );
    }
    const decision = this.resourceDecision(
      principal,
      requestId,
      agent,
      resource,
      true,
      "OWNER_MATCH",
      "Human, Agent, and resource ownership match.",
    );
    await this.appendAllowedDecision(decision);
    return { resource: result, decision };
  }

  async listDecisions(
    principal: HumanPrincipal,
    limit: number,
  ): Promise<AuthorizationDecision[]> {
    return this.securityRepository.listDecisions(principal.id, limit);
  }

  private resourceDecision(
    principal: HumanPrincipal,
    requestId: string,
    agent: Agent,
    resource: ProtectedResource,
    allowed: boolean,
    reasonCode: AuthorizationDecision["reasonCode"],
    reason: string,
    redactAgent = false,
  ): AuthorizationDecision {
    return this.makeDecision({
      principal,
      requestId,
      agent,
      action: "resource.read",
      targetType: "resource",
      targetId: resource.id,
      targetLabel: resource.name,
      allowed,
      reasonCode,
      reason,
      redactAgent,
    });
  }

  private makeDecision(input: {
    principal: HumanPrincipal;
    requestId: string;
    agent: Agent;
    action: AuthorizationAction;
    targetType: AuthorizationDecision["targetType"];
    targetId: string;
    targetLabel: string;
    allowed: boolean;
    reasonCode: AuthorizationDecision["reasonCode"];
    reason: string;
    redactAgent?: boolean;
  }): AuthorizationDecision {
    return {
      id: randomUUID(),
      requestId: input.requestId,
      humanUserId: input.principal.id,
      humanEmail: input.principal.email,
      humanDepartment: input.principal.department,
      agentId: input.redactAgent ? null : input.agent.id,
      agentName: input.redactAgent ? null : input.agent.name,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      targetLabel: input.targetLabel,
      decision: input.allowed ? "allow" : "deny",
      reasonCode: input.reasonCode,
      reason: input.reason,
      createdAt: new Date().toISOString(),
    };
  }

  private async appendAllowedDecision(decision: AuthorizationDecision): Promise<void> {
    try {
      await this.securityRepository.appendDecision(decision);
    } catch {
      throw new HttpError(
        503,
        "Authorization evidence could not be persisted; access failed closed",
        { code: "AUTHORIZATION_AUDIT_UNAVAILABLE" },
      );
    }
  }

  private async appendDeniedDecision(decision: AuthorizationDecision): Promise<void> {
    try {
      await this.securityRepository.appendDecision(decision);
    } catch {
      // The request remains denied even if the evidence sink is unavailable.
    }
  }
}

function deniedError(decision: AuthorizationDecision): HttpError {
  return new HttpError(403, "Access denied by Agent Trust Gateway", {
    code: "AUTHORIZATION_DENIED",
    details: decision,
  });
}
