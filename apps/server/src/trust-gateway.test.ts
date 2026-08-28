import { describe, expect, it } from "vitest";
import type { AgentService } from "./agent-service.js";
import {
  DemoIdentityProvider,
  FINANCE_PRINCIPAL,
} from "./identity-provider.js";
import type { SecurityRepository } from "./security-repository.js";
import { TrustGateway } from "./trust-gateway.js";
import type {
  Agent,
  AuthorizationDecision,
  ProtectedResource,
} from "./types.js";

const timestamp = new Date().toISOString();
const financeAgent: Agent = {
  id: "99999999-9999-4999-8999-999999999999",
  ownerId: FINANCE_PRINCIPAL.id,
  name: "Finance Agent",
  description: "",
  instructions: "",
  status: "ready",
  workspacePath: "/workspace",
  codexThreadId: null,
  lastError: null,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const financeResource: ProtectedResource = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
  ownerId: FINANCE_PRINCIPAL.id,
  ownerDepartment: "finance",
  name: "Quarterly budget",
  description: "Synthetic",
  fileName: "quarterly-budget.md",
  storageKey: "finance/quarterly-budget.md",
  createdAt: timestamp,
};

function makeGateway(repository: SecurityRepository): TrustGateway {
  const agents = {
    getAgent: (id: string) => {
      if (id !== financeAgent.id) throw new Error("missing");
      return financeAgent;
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
    listResources: async () => [financeResource],
    readResource: async () => ({ resource: financeResource, content: "sensitive" }),
    appendDecision: async () => undefined,
    listDecisions: async () => [],
    ...overrides,
  };
}

describe("TrustGateway fail-closed behavior", () => {
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
        { ...FINANCE_PRINCIPAL },
        "demo-token",
        financeAgent.id,
        financeResource.id,
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
            ...financeResource,
            id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2",
            ownerId: "22222222-2222-4222-8222-222222222222",
            ownerDepartment: "hr",
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
        { ...FINANCE_PRINCIPAL },
        "demo-token",
        financeAgent.id,
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
