import { describe, expect, it, vi } from "vitest";
import { api, ApiError } from "./api";

describe("structured authorization denials", () => {
  it("preserves the exact 403 decision used by the scenario result panel", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: "Access denied by Agent Trust Gateway",
      code: "AUTHORIZATION_DENIED",
      decision: {
        id: "44444444-4444-4444-8444-444444444444",
        requestId: "request-1",
        humanUserId: "11111111-1111-4111-8111-111111111111",
        humanEmail: "owner@example.test",
        humanDepartment: "frontend",
        agentId: "99999999-9999-4999-8999-999999999999",
        agentName: "Demo Agent",
        action: "file.read",
        targetType: "file",
        targetId: "README.md",
        targetLabel: ".env",
        decision: "deny",
        reasonCode: "PROTECTED_SECRET_FILE",
        reason: "Protected configuration and credential files cannot be read by this Agent.",
        createdAt: "2026-08-29T00:00:00.000Z",
      },
    }), { status: 403, headers: { "Content-Type": "application/json" } })));

    const error = await api.readWorkspaceFile("99999999-9999-4999-8999-999999999999", ".env")
      .catch((value: unknown) => value);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 403, code: "AUTHORIZATION_DENIED" });
    expect((error as ApiError).decision).toMatchObject({
      decision: "deny",
      action: "file.read",
      targetLabel: ".env",
      reasonCode: "PROTECTED_SECRET_FILE",
      reason: expect.stringContaining("Protected configuration"),
    });
  });
});
