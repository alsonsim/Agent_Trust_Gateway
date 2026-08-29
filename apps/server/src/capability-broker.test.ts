import { describe, expect, it } from "vitest";
import {
  assessPersonalInformation,
  CAPABILITY_CATALOG,
  discoverCapability,
  getCapabilityDefinition,
  sanitizeTaskSummary,
} from "./capability-broker.js";
import { digestExactPrompt } from "./delegation-digest.js";

describe("capability broker", () => {
  it("exposes a deterministic, bounded capability catalog", () => {
    expect(CAPABILITY_CATALOG.map((capability) => capability.id)).toEqual([
      "finance.cost-analysis",
      "hr.people-operations",
      "research.evidence-synthesis",
    ]);
    expect(getCapabilityDefinition("finance.cost-analysis")).toMatchObject({
      label: "Finance cost analysis",
      providerDepartment: "finance",
    });
    expect(getCapabilityDefinition("unknown.capability")).toBeNull();
  });

  it.each([
    [
      "Estimate the budget impact of hiring 12 engineers.",
      "hr",
      "finance.cost-analysis",
    ],
    [
      "Draft an onboarding and employee benefits policy.",
      "finance",
      "hr.people-operations",
    ],
    [
      "Synthesize the evidence across these research studies.",
      "finance",
      "research.evidence-synthesis",
    ],
  ] as const)("discovers a missing private capability for %s", (prompt, department, capability) => {
    const discovery = discoverCapability(prompt, department);

    expect(discovery).toMatchObject({ required: true, capability });
    expect(discovery.taskDigest).toBe(digestExactPrompt(prompt));
    expect(discovery).not.toHaveProperty("agentId");
    expect(discovery).not.toHaveProperty("ownerId");
  });

  it("does not recommend delegation to the requester's own department", () => {
    expect(discoverCapability("Review the quarterly budget.", "finance")).toMatchObject({
      required: false,
      capability: "finance.cost-analysis",
    });
  });

  it("returns no capability when the prompt has no catalog signal", () => {
    expect(discoverCapability("Write a friendly greeting.", "research")).toMatchObject({
      required: false,
      capability: null,
      capabilityLabel: null,
      providerDepartment: null,
    });
  });

  it("redacts likely personal information from the summary without changing the digest", () => {
    const prompt =
      "Estimate hiring cost for employee name: Alice Tan, email alice@example.com, phone +65 9123 4567.";
    const discovery = discoverCapability(prompt, "hr");

    expect(assessPersonalInformation(prompt)).toBe("possible");
    expect(discovery.personalInformation).toBe("possible");
    expect(discovery.sanitizedTaskSummary).not.toContain("Alice Tan");
    expect(discovery.sanitizedTaskSummary).not.toContain("alice@example.com");
    expect(discovery.sanitizedTaskSummary).not.toContain("9123 4567");
    expect(discovery.taskDigest).toBe(digestExactPrompt(prompt));
  });

  it("redacts secrets and bounds a whitespace-normalized display summary", () => {
    const prompt = "Review\n\n budget\twith API_KEY=do-not-display " + "x".repeat(400);
    const summary = sanitizeTaskSummary(prompt);

    expect(summary).toContain("[secret redacted]");
    expect(summary).not.toContain("do-not-display");
    expect(summary).not.toContain("\n");
    expect(summary.length).toBeLessThanOrEqual(280);
    expect(assessPersonalInformation(prompt)).toBe("none_detected");
  });
});
