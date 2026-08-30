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
      "frontend.interface-implementation",
      "backend.service-implementation",
      "qa.release-validation",
    ]);
    expect(getCapabilityDefinition("frontend.interface-implementation")).toMatchObject({
      label: "Frontend interface implementation",
      providerDepartment: "frontend",
    });
    expect(getCapabilityDefinition("unknown.capability")).toBeNull();
  });

  it.each([
    [
      "Create a typed profile API handler with input validation.",
      "frontend",
      "backend.service-implementation",
    ],
    [
      "Implement a React profile page with accessible loading and error states.",
      "backend",
      "frontend.interface-implementation",
    ],
    [
      "Create a release regression test plan for the profile workflow.",
      "frontend",
      "qa.release-validation",
    ],
  ] as const)("discovers a missing private capability for %s", (prompt, department, capability) => {
    const discovery = discoverCapability(prompt, department);

    expect(discovery).toMatchObject({ required: true, capability });
    expect(discovery.taskDigest).toBe(digestExactPrompt(prompt));
    expect(discovery).not.toHaveProperty("agentId");
    expect(discovery).not.toHaveProperty("ownerId");
  });

  it("does not recommend delegation to the requester's own department", () => {
    expect(discoverCapability("Implement an accessible React profile page.", "frontend")).toMatchObject({
      required: false,
      capability: "frontend.interface-implementation",
    });
  });

  it("returns no capability when the prompt has no catalog signal", () => {
    expect(discoverCapability("Write a friendly greeting.", "qa")).toMatchObject({
      required: false,
      capability: null,
      capabilityLabel: null,
      providerDepartment: null,
    });
  });

  it("redacts likely personal information from the summary without changing the digest", () => {
    const prompt =
      "Create an API request for employee name: Alice Tan, email alice@example.com, phone +65 9123 4567.";
    const discovery = discoverCapability(prompt, "frontend");

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
