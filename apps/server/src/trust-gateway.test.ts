import { describe, expect, it } from "vitest";
import type { AgentService } from "./agent-service.js";
import {
  BACKEND_PRINCIPAL,
  DemoIdentityProvider,
  FRONTEND_PRINCIPAL,
} from "./identity-provider.js";
import type { SecurityRepository } from "./security-repository.js";
import { TrustGateway } from "./trust-gateway.js";
import type {
  Agent,
  AuthorizationDecision,
  ProtectedResource,
} from "./types.js";

const timestamp = new Date().toISOString();
const frontendAgent: Agent = {
  id: "99999999-9999-4999-8999-999999999999",
  department: "frontend",
  workspaceProfileId: "department-frontend",
  ownerId: FRONTEND_PRINCIPAL.id,
  name: "Frontend Agent",
  description: "",
  instructions: "",
  status: "ready",
  revokedAt: null,
  workspacePath: "/workspace",
  codexThreadId: null,
  lastError: null,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const frontendResource: ProtectedResource = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
  ownerId: FRONTEND_PRINCIPAL.id,
  ownerDepartment: "frontend",
  name: "Profile page requirements",
  description: "Synthetic",
  fileName: "profile-page-requirements.md",
  storageKey: "frontend/profile-page-requirements.md",
  createdAt: timestamp,
};

function makeGateway(repository: SecurityRepository): TrustGateway {
  const agents = {
    getAgent: (id: string) => {
      if (id !== frontendAgent.id) throw new Error("missing");
      return frontendAgent;
    },
  } as unknown as AgentService;
  return new TrustGateway(
    new DemoIdentityProvider({
      host: "127.0.0.1",
      signingKey: "a-test-signing-key-that-is-at-least-32-bytes",
    }),
    repository,
    agents,
  );
}

function repository(overrides: Partial<SecurityRepository> = {}): SecurityRepository {
  return {
    initialize: async () => undefined,
    listResources: async () => [frontendResource],
    readResource: async () => ({ resource: frontendResource, content: "sensitive" }),
    readResourceForDelegation: async () => ({
      resource: frontendResource,
      content: "sensitive",
    }),
    appendDecision: async () => undefined,
    appendDecisions: async () => undefined,
    listDecisions: async () => [],
    ...overrides,
  };
}

describe("TrustGateway fail-closed behavior", () => {
  it("denies a different human even when they share the Agent department", async () => {
    const recorded: AuthorizationDecision[] = [];
    const gateway = makeGateway(
      repository({
        appendDecision: async (decision) => {
          recorded.push(decision);
        },
      }),
    );

    await expect(
      gateway.authorizeAgent(
        {
          ...FRONTEND_PRINCIPAL,
          id: "77777777-7777-4777-8777-777777777777",
          email: "frontend-reviewer@bytedance.com",
          displayName: "Frontend Reviewer",
        },
        frontendAgent.id,
        "agent.read",
        "same-department-request",
      ),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: "AUTHORIZATION_DENIED",
    });
    expect(recorded).toEqual([
      expect.objectContaining({
        agentId: null,
        targetLabel: "Protected Agent",
        decision: "deny",
        reasonCode: "HUMAN_AGENT_OWNER_MISMATCH",
      }),
    ]);
  });

  it("lists only protected resources owned by the authenticated human", async () => {
    const backendResource: ProtectedResource = {
      ...frontendResource,
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2",
      ownerId: BACKEND_PRINCIPAL.id,
      ownerDepartment: "backend",
      name: "Profile API contract",
      fileName: "profile-api-contract.md",
      storageKey: "backend/profile-api-contract.md",
    };
    const gateway = makeGateway(
      repository({ listResources: async () => [frontendResource, backendResource] }),
    );

    await expect(gateway.listResources({ ...BACKEND_PRINCIPAL })).resolves.toEqual([
      expect.objectContaining({
        id: backendResource.id,
        ownerId: BACKEND_PRINCIPAL.id,
        ownedByCurrentUser: true,
      }),
    ]);
  });

  it("does not return allowed content when audit evidence cannot be persisted", async () => {
    const gateway = makeGateway(
      repository({
        appendDecision: async () => {
          throw new Error("audit unavailable");
        },
      }),
    );
    await expect(
      gateway.readResource(
        { ...FRONTEND_PRINCIPAL },
        "demo-token",
        frontendAgent.id,
        frontendResource.id,
        "request-1",
      ),
    ).rejects.toMatchObject({
      statusCode: 503,
      code: "AUTHORIZATION_AUDIT_UNAVAILABLE",
    });
  });

  it("keeps a denial denied when the audit sink is unavailable", async () => {
    const recorded: AuthorizationDecision[] = [];
    const gateway = makeGateway(
      repository({
        listResources: async () => [
          {
            ...frontendResource,
            id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2",
            ownerId: "22222222-2222-4222-8222-222222222222",
            ownerDepartment: "backend",
          },
        ],
        appendDecision: async (decision) => {
          recorded.push(decision);
          throw new Error("audit unavailable");
        },
      }),
    );
    await expect(
      gateway.readResource(
        { ...FRONTEND_PRINCIPAL },
        "demo-token",
        frontendAgent.id,
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2",
        "request-2",
      ),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: "AUTHORIZATION_DENIED",
    });
    expect(recorded[0]).toMatchObject({
      decision: "deny",
      reasonCode: "AGENT_RESOURCE_OWNER_MISMATCH",
    });
  });
});
