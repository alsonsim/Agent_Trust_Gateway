import { describe, expect, it } from "vitest";
import { SupabaseSecurityRepository } from "./security-repository.js";
import type { AuthorizationDecision } from "./types.js";

const decision: AuthorizationDecision = {
  id: "44444444-4444-4444-8444-444444444444",
  requestId: "request-1",
  humanUserId: "11111111-1111-4111-8111-111111111111",
  humanEmail: "finance@agent-gateway.local",
  humanDepartment: "finance",
  agentId: "99999999-9999-4999-8999-999999999999",
  agentName: "Finance Agent",
  action: "resource.read",
  targetType: "resource",
  targetId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
  targetLabel: "Quarterly budget",
  decision: "allow",
  reasonCode: "OWNER_MATCH",
  reason: "The user, agent, and resource owners match.",
  createdAt: "2026-08-29T00:00:00.000Z",
};

describe("SupabaseSecurityRepository", () => {
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

  it("maps a file path target to a UUID while preserving its audit label", async () => {
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

    await repository.appendDecision({
      ...decision,
      action: "file.read",
      targetType: "file",
      targetId: "README.md",
      targetLabel: "README.md",
      reasonCode: "WORKSPACE_PATH_ALLOWED",
    });

    expect(JSON.parse(body)).toMatchObject({
      target_id: decision.id,
      target_label: "README.md",
      action: "file.read",
    });
  });
});
