import { describe, expect, it } from "vitest";
import { RUNTIME_EXEC_POLICY } from "./runtime-execpolicy.js";

describe("Runtime execpolicy", () => {
  it("allows the supported development commands and forbids dangerous prefixes", () => {
    expect(RUNTIME_EXEC_POLICY).toContain('prefix_rule(pattern = ["npm", "test"], decision = "allow")');
    expect(RUNTIME_EXEC_POLICY).toContain('prefix_rule(pattern = ["npm", "run", "build"], decision = "allow")');
    expect(RUNTIME_EXEC_POLICY).toContain('prefix_rule(pattern = ["git", "status"], decision = "allow")');
    expect(RUNTIME_EXEC_POLICY).toContain('prefix_rule(pattern = ["git", "diff"], decision = "allow")');
    expect(RUNTIME_EXEC_POLICY).toContain('prefix_rule(pattern = ["rm", "-rf"], decision = "forbidden"');
    expect(RUNTIME_EXEC_POLICY).toContain('prefix_rule(pattern = ["sudo"], decision = "forbidden"');
    expect(RUNTIME_EXEC_POLICY).toContain('prefix_rule(pattern = ["curl"], decision = "forbidden"');
    expect(RUNTIME_EXEC_POLICY).toContain('prefix_rule(pattern = ["git", "push"], decision = "forbidden"');
  });
});
