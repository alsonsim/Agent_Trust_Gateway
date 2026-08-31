import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { isIP } from "node:net";

export type Department = "frontend" | "backend" | "qa";

export interface HumanPrincipal {
  id: string;
  email: string;
  displayName: string;
  department: Department;
}

export interface LoginCredentials {
  email: string;
  password?: string;
}

export interface IdentitySession {
  principal: HumanPrincipal;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string;
}

export interface IdentityProvider {
  readonly kind: "demo" | "supabase";
  signIn(credentials: LoginCredentials): Promise<IdentitySession>;
  verifyAccessToken(accessToken: string): Promise<HumanPrincipal>;
}

export const DEMO_PRINCIPALS = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    email: "frontend@bytedance.com",
    displayName: "Frontend",
    department: "frontend",
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    email: "backend@bytedance.com",
    displayName: "Backend",
    department: "backend",
  },
  {
    id: "33333333-3333-4333-8333-333333333333",
    email: "qa@bytedance.com",
    displayName: "QA",
    department: "qa",
  },
] as const satisfies readonly HumanPrincipal[];

export const FRONTEND_PRINCIPAL = DEMO_PRINCIPALS[0];
export const BACKEND_PRINCIPAL = DEMO_PRINCIPALS[1];
export const QA_PRINCIPAL = DEMO_PRINCIPALS[2];

const AUTHENTICATION_FAILED = "Authentication failed";
const DEMO_PASSWORD = "test-password";

export class IdentityAuthenticationError extends Error {
  readonly statusCode = 401;

  constructor() {
    super(AUTHENTICATION_FAILED);
    this.name = "IdentityAuthenticationError";
  }
}

function authenticationFailed(): IdentityAuthenticationError {
  return new IdentityAuthenticationError();
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function parseHost(host: string): string {
  const candidate = host.trim().toLowerCase();
  if (!candidate) return "";

  if (candidate.includes("://")) {
    try {
      return new URL(candidate).hostname.toLowerCase();
    } catch {
      return "";
    }
  }

  if (candidate.startsWith("[")) {
    const closingBracket = candidate.indexOf("]");
    return closingBracket > 0 ? candidate.slice(1, closingBracket) : "";
  }

  const colonCount = (candidate.match(/:/g) ?? []).length;
  return colonCount === 1 ? (candidate.split(":", 1)[0] ?? "") : candidate;
}

export function isLoopbackHost(host: string): boolean {
  const hostname = parseHost(host);
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  if (hostname === "::1" || hostname === "0:0:0:0:0:0:0:1") return true;
  if (hostname.startsWith("::ffff:127.")) return true;
  if (isIP(hostname) === 4) return hostname.split(".")[0] === "127";
  return false;
}

interface DemoTokenPayload {
  iss: "agent-trust-gateway-demo";
  sub: string;
  email: string;
  department: Department;
  iat: number;
  exp: number;
  jti: string;
}

export interface DemoIdentityProviderOptions {
  /** The configured listen host. Demo identity is rejected on non-loopback hosts. */
  host: string;
  /** Explicit escape hatch for a disposable demo. Defaults to false. */
  allowNonLoopback?: boolean;
  /** Omit for an ephemeral key. Tokens then intentionally expire on restart. */
  signingKey?: string | Uint8Array;
  tokenTtlSeconds?: number;
  now?: () => number;
}

const DEMO_ISSUER = "agent-trust-gateway-demo";
const DEMO_TOKEN_HEADER = { alg: "HS256", typ: "JWT" } as const;
const DEFAULT_DEMO_TOKEN_TTL_SECONDS = 15 * 60;
const MAX_DEMO_TOKEN_TTL_SECONDS = 24 * 60 * 60;
const MAX_CLOCK_SKEW_SECONDS = 30;
const MAX_TOKEN_LENGTH = 8_192;

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function parseBase64UrlJson(value: string): unknown {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) throw authenticationFailed();
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
  } catch {
    throw authenticationFailed();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDepartment(value: unknown): value is Department {
  return value === "frontend" || value === "backend" || value === "qa";
}

function parseDemoPayload(value: unknown): DemoTokenPayload {
  if (
    !isRecord(value) ||
    value.iss !== DEMO_ISSUER ||
    typeof value.sub !== "string" ||
    typeof value.email !== "string" ||
    !isDepartment(value.department) ||
    !Number.isInteger(value.iat) ||
    !Number.isInteger(value.exp) ||
    typeof value.jti !== "string"
  ) {
    throw authenticationFailed();
  }
  return value as unknown as DemoTokenPayload;
}

function copyPrincipal(principal: HumanPrincipal): HumanPrincipal {
  return { ...principal };
}

export class DemoIdentityProvider implements IdentityProvider {
  readonly kind = "demo" as const;

  private readonly signingKey: Buffer;
  private readonly tokenTtlSeconds: number;
  private readonly now: () => number;

  constructor(options: DemoIdentityProviderOptions) {
    if (!isLoopbackHost(options.host) && options.allowNonLoopback !== true) {
      throw new Error("Demo identity provider requires a loopback listen host");
    }

    const signingKey =
      options.signingKey === undefined
        ? randomBytes(32)
        : typeof options.signingKey === "string"
          ? Buffer.from(options.signingKey, "utf8")
          : Buffer.from(options.signingKey);
    if (signingKey.byteLength < 32) {
      throw new Error("Demo identity signing key must contain at least 32 bytes");
    }

    const tokenTtlSeconds =
      options.tokenTtlSeconds ?? DEFAULT_DEMO_TOKEN_TTL_SECONDS;
    if (
      !Number.isInteger(tokenTtlSeconds) ||
      tokenTtlSeconds < 60 ||
      tokenTtlSeconds > MAX_DEMO_TOKEN_TTL_SECONDS
    ) {
      throw new Error("Demo token TTL must be between 60 and 86400 seconds");
    }

    this.signingKey = signingKey;
    this.tokenTtlSeconds = tokenTtlSeconds;
    this.now = options.now ?? (() => Date.now());
  }

  async signIn(credentials: LoginCredentials): Promise<IdentitySession> {
    const email = normalizeEmail(credentials.email);
    const principal = DEMO_PRINCIPALS.find((candidate) => candidate.email === email);
    if (!principal) throw authenticationFailed();
    if (credentials.password !== undefined && credentials.password !== DEMO_PASSWORD) {
      throw authenticationFailed();
    }

    const issuedAt = Math.floor(this.now() / 1_000);
    const expiresAt = issuedAt + this.tokenTtlSeconds;
    const payload: DemoTokenPayload = {
      iss: DEMO_ISSUER,
      sub: principal.id,
      email: principal.email,
      department: principal.department,
      iat: issuedAt,
      exp: expiresAt,
      jti: randomUUID(),
    };
    const header = base64UrlJson(DEMO_TOKEN_HEADER);
    const body = base64UrlJson(payload);
    const unsignedToken = header + "." + body;
    const signature = createHmac("sha256", this.signingKey)
      .update(unsignedToken)
      .digest("base64url");

    return {
      principal: copyPrincipal(principal),
      accessToken: unsignedToken + "." + signature,
      refreshToken: null,
      expiresAt: new Date(expiresAt * 1_000).toISOString(),
    };
  }

  async verifyAccessToken(accessToken: string): Promise<HumanPrincipal> {
    if (!accessToken || accessToken.length > MAX_TOKEN_LENGTH) {
      throw authenticationFailed();
    }

    const parts = accessToken.split(".");
    if (parts.length !== 3) throw authenticationFailed();
    const [encodedHeader, encodedBody, encodedSignature] = parts;
    if (!encodedHeader || !encodedBody || !encodedSignature) {
      throw authenticationFailed();
    }

    const header = parseBase64UrlJson(encodedHeader);
    if (
      !isRecord(header) ||
      header.alg !== DEMO_TOKEN_HEADER.alg ||
      header.typ !== DEMO_TOKEN_HEADER.typ
    ) {
      throw authenticationFailed();
    }

    if (!/^[A-Za-z0-9_-]+$/.test(encodedSignature)) {
      throw authenticationFailed();
    }
    const expectedSignature = createHmac("sha256", this.signingKey)
      .update(encodedHeader + "." + encodedBody)
      .digest();
    const suppliedSignature = Buffer.from(encodedSignature, "base64url");
    if (
      suppliedSignature.byteLength !== expectedSignature.byteLength ||
      !timingSafeEqual(suppliedSignature, expectedSignature)
    ) {
      throw authenticationFailed();
    }

    const payload = parseDemoPayload(parseBase64UrlJson(encodedBody));
    const currentTime = Math.floor(this.now() / 1_000);
    if (
      payload.exp <= currentTime ||
      payload.iat > currentTime + MAX_CLOCK_SKEW_SECONDS ||
      payload.exp <= payload.iat ||
      payload.exp - payload.iat > this.tokenTtlSeconds
    ) {
      throw authenticationFailed();
    }

    const principal = DEMO_PRINCIPALS.find((candidate) => candidate.id === payload.sub);
    if (
      !principal ||
      principal.email !== normalizeEmail(payload.email) ||
      principal.department !== payload.department
    ) {
      throw authenticationFailed();
    }
    return copyPrincipal(principal);
  }
}

export type FetchLike = typeof globalThis.fetch;

export interface SupabaseIdentityProviderOptions {
  supabaseUrl: string;
  anonKey: string;
  serviceRoleKey: string;
  fetchImpl?: FetchLike;
  profilesTable?: string;
  requestTimeoutMs?: number;
  now?: () => number;
}

interface SupabaseTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  expires_at?: number;
}

interface SupabaseAuthUser {
  id: string;
  email: string;
}

interface SupabaseProfileRow {
  id: string;
  display_name: string;
  department: Department;
}

function validateSupabaseBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("SUPABASE_URL must be a valid URL");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname))) {
    throw new Error("SUPABASE_URL must use HTTPS unless it targets loopback");
  }
  return url.toString().replace(/\/+$/, "");
}

function parseTokenResponse(value: unknown): SupabaseTokenResponse {
  if (
    !isRecord(value) ||
    typeof value.access_token !== "string" ||
    !value.access_token ||
    (value.refresh_token !== undefined && typeof value.refresh_token !== "string") ||
    (value.expires_in !== undefined && typeof value.expires_in !== "number") ||
    (value.expires_at !== undefined && typeof value.expires_at !== "number")
  ) {
    throw authenticationFailed();
  }
  return value as unknown as SupabaseTokenResponse;
}

function parseAuthUser(value: unknown): SupabaseAuthUser {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !value.id ||
    typeof value.email !== "string" ||
    !value.email
  ) {
    throw authenticationFailed();
  }
  return { id: value.id, email: normalizeEmail(value.email) };
}

function parseProfile(value: unknown, expectedUserId: string): SupabaseProfileRow {
  if (!Array.isArray(value) || value.length !== 1) throw authenticationFailed();
  const profile = value[0];
  if (
    !isRecord(profile) ||
    profile.id !== expectedUserId ||
    typeof profile.display_name !== "string" ||
    !profile.display_name.trim() ||
    !isDepartment(profile.department)
  ) {
    throw authenticationFailed();
  }
  return {
    id: expectedUserId,
    display_name: profile.display_name.trim(),
    department: profile.department,
  };
}

export class SupabaseIdentityProvider implements IdentityProvider {
  readonly kind = "supabase" as const;

  private readonly supabaseUrl: string;
  private readonly anonKey: string;
  private readonly serviceRoleKey: string;
  private readonly fetchImpl: FetchLike;
  private readonly profilesTable: string;
  private readonly requestTimeoutMs: number;
  private readonly now: () => number;

  constructor(options: SupabaseIdentityProviderOptions) {
    this.supabaseUrl = validateSupabaseBaseUrl(options.supabaseUrl);
    if (!options.anonKey.trim() || !options.serviceRoleKey.trim()) {
      throw new Error("Supabase identity keys are required");
    }
    const profilesTable = options.profilesTable ?? "profiles";
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(profilesTable)) {
      throw new Error("Supabase profiles table name is invalid");
    }
    const requestTimeoutMs = options.requestTimeoutMs ?? 8_000;
    if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 100 || requestTimeoutMs > 60_000) {
      throw new Error("Supabase identity request timeout is invalid");
    }

    this.anonKey = options.anonKey.trim();
    this.serviceRoleKey = options.serviceRoleKey.trim();
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.profilesTable = profilesTable;
    this.requestTimeoutMs = requestTimeoutMs;
    this.now = options.now ?? (() => Date.now());
  }

  async signIn(credentials: LoginCredentials): Promise<IdentitySession> {
    const email = normalizeEmail(credentials.email);
    const password = credentials.password ?? "";
    if (!email || email.length > 320 || !password || password.length > 4_096) {
      throw authenticationFailed();
    }

    try {
      const response = await this.fetchWithTimeout(
        this.supabaseUrl + "/auth/v1/token?grant_type=password",
        {
          method: "POST",
          headers: {
            apikey: this.anonKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ email, password }),
        },
      );
      if (!response.ok) throw authenticationFailed();
      const token = parseTokenResponse(await response.json());
      const principal = await this.verifyAccessToken(token.access_token);
      const expiresAtSeconds =
        token.expires_at ??
        Math.floor(this.now() / 1_000) +
          (Number.isFinite(token.expires_in) && (token.expires_in ?? 0) > 0
            ? Math.floor(token.expires_in ?? 0)
            : 60 * 60);

      return {
        principal,
        accessToken: token.access_token,
        refreshToken: token.refresh_token?.trim() || null,
        expiresAt: new Date(expiresAtSeconds * 1_000).toISOString(),
      };
    } catch (error) {
      if (error instanceof IdentityAuthenticationError) throw error;
      throw authenticationFailed();
    }
  }

  async verifyAccessToken(accessToken: string): Promise<HumanPrincipal> {
    if (!accessToken || accessToken.length > MAX_TOKEN_LENGTH) {
      throw authenticationFailed();
    }

    try {
      const userResponse = await this.fetchWithTimeout(
        this.supabaseUrl + "/auth/v1/user",
        {
          method: "GET",
          headers: {
            apikey: this.anonKey,
            Authorization: "Bearer " + accessToken,
          },
        },
      );
      if (!userResponse.ok) throw authenticationFailed();
      const user = parseAuthUser(await userResponse.json());

      const profileUrl = new URL(
        this.supabaseUrl + "/rest/v1/" + this.profilesTable,
      );
      profileUrl.searchParams.set("select", "id,display_name,department");
      profileUrl.searchParams.set("id", "eq." + user.id);
      profileUrl.searchParams.set("limit", "1");
      const profileResponse = await this.fetchWithTimeout(profileUrl, {
        method: "GET",
        headers: {
          apikey: this.serviceRoleKey,
          ...(this.serviceRoleKey.split(".").length === 3
            ? { Authorization: "Bearer " + this.serviceRoleKey }
            : {}),
          Accept: "application/json",
        },
      });
      if (!profileResponse.ok) throw authenticationFailed();
      const profile = parseProfile(await profileResponse.json(), user.id);

      return {
        id: user.id,
        email: user.email,
        displayName: profile.display_name,
        department: profile.department,
      };
    } catch (error) {
      if (error instanceof IdentityAuthenticationError) throw error;
      throw authenticationFailed();
    }
  }

  private fetchWithTimeout(
    input: string | URL,
    init: RequestInit,
  ): Promise<Response> {
    return this.fetchImpl(input, {
      ...init,
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
  }
}
