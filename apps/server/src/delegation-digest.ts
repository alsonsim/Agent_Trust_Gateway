import { createHash } from "node:crypto";

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Hashes the exact UTF-8 bytes received at the authorization boundary.
 * Whitespace, line endings, casing, and Unicode normalization are deliberately preserved.
 */
export function digestExactPrompt(value: string): string {
  return sha256(Buffer.from(value, "utf8"));
}

/** Hashes resource bytes without trimming or otherwise normalizing their content. */
export function digestResourceContent(value: string | Uint8Array): string {
  return sha256(typeof value === "string" ? Buffer.from(value, "utf8") : value);
}

/**
 * Produces stable JSON for structured approved inputs. Object keys are sorted,
 * while array order and primitive values remain significant.
 */
export function canonicalizeJson(value: unknown): string {
  return canonicalizeJsonValue(value, new Set<object>());
}

export function digestCanonicalContent(value: unknown): string {
  return sha256(canonicalizeJson(value));
}

/** Resource scope is a set, so input order and duplicate IDs do not affect its digest. */
export function canonicalizeResourceIds(resourceIds: readonly string[]): string[] {
  for (const resourceId of resourceIds) {
    if (!resourceId) throw new TypeError("Resource IDs must be non-empty strings");
  }
  return [...new Set(resourceIds)].sort();
}

export function digestResourceIds(resourceIds: readonly string[]): string {
  return digestCanonicalContent(canonicalizeResourceIds(resourceIds));
}

export function digestDelegationScope(input: {
  prompt: string;
  approvedInputs: unknown;
  approvedResourceIds: readonly string[];
}): string {
  return digestCanonicalContent({
    approvedInputDigest: digestCanonicalContent(input.approvedInputs),
    approvedResourceDigest: digestResourceIds(input.approvedResourceIds),
    exactPromptDigest: digestExactPrompt(input.prompt),
  });
}

function canonicalizeJsonValue(value: unknown, seen: Set<object>): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Canonical JSON does not support non-finite numbers");
    }
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new TypeError("Canonical JSON contains an unsupported value");
  }
  if (seen.has(value)) throw new TypeError("Canonical JSON does not support cycles");

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return "[" + value.map((item) => canonicalizeJsonValue(item, seen)).join(",") + "]";
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Canonical JSON only supports plain objects");
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new TypeError("Canonical JSON does not support symbol keys");
    }

    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .map(
        (key) =>
          JSON.stringify(key) + ":" + canonicalizeJsonValue(record[key], seen),
      );
    return "{" + entries.join(",") + "}";
  } finally {
    seen.delete(value);
  }
}
