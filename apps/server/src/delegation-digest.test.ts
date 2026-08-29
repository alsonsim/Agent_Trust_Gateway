import { describe, expect, it } from "vitest";
import {
  canonicalizeJson,
  canonicalizeResourceIds,
  digestCanonicalContent,
  digestDelegationScope,
  digestExactPrompt,
  digestResourceContent,
  digestResourceIds,
} from "./delegation-digest.js";

describe("delegation digests", () => {
  it("hashes the exact UTF-8 prompt without normalization", () => {
    expect(digestExactPrompt("hello")).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
    expect(digestExactPrompt("hello")).not.toBe(digestExactPrompt("hello "));
    expect(digestExactPrompt("line one\nline two")).not.toBe(
      digestExactPrompt("line one\r\nline two"),
    );
    expect(digestExactPrompt("é")).not.toBe(digestExactPrompt("e\u0301"));
  });

  it("hashes resource content as exact bytes", () => {
    expect(digestResourceContent("budget\n")).toBe(
      digestResourceContent(new TextEncoder().encode("budget\n")),
    );
    expect(digestResourceContent("budget\n")).not.toBe(
      digestResourceContent("budget"),
    );
  });

  it("canonicalizes structured content independently of object insertion order", () => {
    const left = { salaryBands: [82_000, 104_000], headcount: 12 };
    const right = { headcount: 12, salaryBands: [82_000, 104_000] };

    expect(canonicalizeJson(left)).toBe(canonicalizeJson(right));
    expect(digestCanonicalContent(left)).toBe(digestCanonicalContent(right));
    expect(digestCanonicalContent(left)).not.toBe(
      digestCanonicalContent({ ...right, headcount: 13 }),
    );
  });

  it("treats approved resource IDs as an order-independent set", () => {
    expect(canonicalizeResourceIds(["resource-b", "resource-a", "resource-a"])).toEqual([
      "resource-a",
      "resource-b",
    ]);
    expect(digestResourceIds(["resource-a", "resource-b"])).toBe(
      digestResourceIds(["resource-b", "resource-a", "resource-a"]),
    );
    expect(digestResourceIds(["resource-a"])).not.toBe(
      digestResourceIds(["resource-b"]),
    );
  });

  it("binds prompt, approved inputs, and resources into one stable scope digest", () => {
    const scope = {
      prompt: "Estimate the hiring budget.",
      approvedInputs: { headcount: 12, salaryBand: "H4" },
      approvedResourceIds: ["budget", "bands"],
    };

    expect(digestDelegationScope(scope)).toBe(
      digestDelegationScope({
        ...scope,
        approvedInputs: { salaryBand: "H4", headcount: 12 },
        approvedResourceIds: ["bands", "budget"],
      }),
    );
    expect(digestDelegationScope(scope)).not.toBe(
      digestDelegationScope({ ...scope, prompt: scope.prompt + " " }),
    );
  });

  it("rejects values that JSON cannot represent safely", () => {
    expect(() => canonicalizeJson({ value: undefined })).toThrow(TypeError);
    expect(() => canonicalizeJson(Number.NaN)).toThrow(TypeError);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalizeJson(cyclic)).toThrow(TypeError);
    expect(() => canonicalizeResourceIds([""])).toThrow(TypeError);
  });
});
