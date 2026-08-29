import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { HttpError } from "./errors.js";
import { JsonStore } from "./store.js";
import type {
  AuthorizationDecision,
  Department,
  ProtectedResource,
} from "./types.js";

export interface ResourceReadResult {
  resource: ProtectedResource;
  content: string;
}

export interface SecurityRepository {
  initialize(): Promise<void>;
  listResources(): Promise<ProtectedResource[]>;
  readResource(id: string, userAccessToken: string): Promise<ResourceReadResult | null>;
  appendDecision(decision: AuthorizationDecision): Promise<void>;
  listDecisions(humanUserId: string, limit: number): Promise<AuthorizationDecision[]>;
}

interface ResourceFixture {
  id: string;
  ownerId: string;
  ownerDepartment: Department;
  name: string;
  description: string;
  fileName: string;
  content: string;
}

export const RESOURCE_FIXTURES: ResourceFixture[] = [
  {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
    ownerId: "11111111-1111-4111-8111-111111111111",
    ownerDepartment: "frontend",
    name: "Profile page requirements",
    description: "Frontend requirements for the shared profile-page engineering project.",
    fileName: "profile-page-requirements.md",
    content:
      "# Profile page requirements\n\n" +
      "Build an accessible, responsive profile page at `/profile`.\n\n" +
      "## Required states\n\n" +
      "- Loading skeleton while the profile request is pending.\n" +
      "- Profile header with display name, avatar fallback, biography, and team.\n" +
      "- Inline validation for display name and biography edits.\n" +
      "- Explicit empty, not-found, forbidden, and retryable error states.\n\n" +
      "## Acceptance criteria\n\n" +
      "- Keyboard navigation and labelled controls meet WCAG 2.2 AA expectations.\n" +
      "- The layout works from 360 px through desktop widths.\n" +
      "- API data is treated as untrusted and rendered without raw HTML.\n",
  },
  {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2",
    ownerId: "22222222-2222-4222-8222-222222222222",
    ownerDepartment: "backend",
    name: "Profile API contract",
    description: "Backend contract for reading and updating the shared profile resource.",
    fileName: "profile-api-contract.md",
    content:
      "# Profile API contract\n\n" +
      "## `GET /api/profile`\n\n" +
      "Returns `{ id, displayName, biography, team, avatarUrl, updatedAt }`. " +
      "Use `404` for an unknown profile and `403` when the caller cannot view it.\n\n" +
      "## `PATCH /api/profile`\n\n" +
      "Accepts `{ displayName?, biography?, avatarUrl? }`. Reject unknown fields, " +
      "trim text, cap biographies at 500 characters, and return the updated profile.\n\n" +
      "## Engineering constraints\n\n" +
      "- Authenticate before loading protected profile data.\n" +
      "- Use parameterized persistence operations and optimistic concurrency.\n" +
      "- Never return internal errors, credentials, or authorization metadata.\n",
  },
  {
    id: "cccccccc-cccc-4ccc-8ccc-ccccccccccc3",
    ownerId: "33333333-3333-4333-8333-333333333333",
    ownerDepartment: "qa",
    name: "Profile release test plan",
    description: "QA release coverage for the profile page and profile API contract.",
    fileName: "profile-release-test-plan.md",
    content:
      "# Profile release test plan\n\n" +
      "## Functional coverage\n\n" +
      "- Load, edit, save, cancel, and refresh a valid profile.\n" +
      "- Verify empty biography, avatar fallback, validation, and concurrent edits.\n" +
      "- Exercise `403`, `404`, validation, timeout, and retryable server failures.\n\n" +
      "## Quality gates\n\n" +
      "- Automated API contract tests and browser tests pass.\n" +
      "- Keyboard-only and responsive checks pass at 360, 768, and 1440 px.\n" +
      "- Cross-user reads and updates are denied without leaking profile content.\n",
  },
];

const LEGACY_RESOURCE_FILES = [
  {
    ownerId: "11111111-1111-4111-8111-111111111111",
    fileName: "quarterly-budget.md",
  },
  {
    ownerId: "22222222-2222-4222-8222-222222222222",
    fileName: "compensation-bands.md",
  },
  {
    ownerId: "33333333-3333-4333-8333-333333333333",
    fileName: "experiment-notes.md",
  },
] as const;

export class LocalSecurityRepository implements SecurityRepository {
  private readonly resourceRoot: string;

  constructor(
    private readonly store: JsonStore,
    dataDirectory: string,
  ) {
    this.resourceRoot = path.resolve(dataDirectory, "protected-resources");
  }

  async initialize(): Promise<void> {
    await mkdir(this.resourceRoot, { recursive: true });
    for (const fixture of RESOURCE_FIXTURES) {
      const ownerDirectory = path.join(this.resourceRoot, fixture.ownerId);
      await mkdir(ownerDirectory, { recursive: true });
      await refreshFixtureFile(ownerDirectory, fixture);
    }
    await this.store.mutate((database) => {
      for (const fixture of RESOURCE_FIXTURES) {
        const existing = database.protectedResources.find(
          (resource) => resource.id === fixture.id,
        );
        const refreshed: ProtectedResource = {
          id: fixture.id,
          ownerId: fixture.ownerId,
          ownerDepartment: fixture.ownerDepartment,
          name: fixture.name,
          description: fixture.description,
          fileName: fixture.fileName,
          storageKey: fixture.ownerId + "/" + fixture.fileName,
          createdAt: existing?.createdAt ?? new Date().toISOString(),
        };
        if (existing) Object.assign(existing, refreshed);
        else database.protectedResources.push(refreshed);
      }
    });
    for (const legacyFile of LEGACY_RESOURCE_FILES) {
      await removeFileIfExists(
        path.join(this.resourceRoot, legacyFile.ownerId, legacyFile.fileName),
      );
    }
  }

  async listResources(): Promise<ProtectedResource[]> {
    return this.store.snapshot().protectedResources;
  }

  async readResource(id: string, _userAccessToken: string): Promise<ResourceReadResult | null> {
    const resource = this.store
      .snapshot()
      .protectedResources.find((candidate) => candidate.id === id);
    if (!resource) return null;
    const resourcePath = path.resolve(this.resourceRoot, resource.storageKey);
    const rootPrefix = this.resourceRoot.endsWith(path.sep)
      ? this.resourceRoot
      : this.resourceRoot + path.sep;
    if (!resourcePath.startsWith(rootPrefix)) {
      throw new HttpError(500, "Protected resource path is invalid");
    }
    return { resource, content: await readFile(resourcePath, "utf8") };
  }

  async appendDecision(decision: AuthorizationDecision): Promise<void> {
    await this.store.mutate((database) => {
      database.authorizationDecisions.push(decision);
      if (database.authorizationDecisions.length > 1_000) {
        database.authorizationDecisions.splice(
          0,
          database.authorizationDecisions.length - 1_000,
        );
      }
    });
  }

  async listDecisions(
    humanUserId: string,
    limit: number,
  ): Promise<AuthorizationDecision[]> {
    return this.store
      .snapshot()
      .authorizationDecisions.filter((decision) => decision.humanUserId === humanUserId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit);
  }
}

interface SupabaseResourceRow {
  id: string;
  owner_id: string;
  owner_department: Department;
  name: string;
  description: string;
  file_name: string;
  content?: string;
  created_at: string;
}

const REQUIRED_DEPARTMENTS: Department[] = ["frontend", "backend", "qa"];

export class SupabaseSecurityRepository implements SecurityRepository {
  constructor(
    private readonly url: string,
    private readonly anonKey: string,
    private readonly secretKey: string,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {}

  async initialize(): Promise<void> {
    const openApi = await this.request<unknown>("/rest/v1/", this.secretKey, {
      accept: "application/openapi+json",
    });
    assertSupabaseSchemaContract(openApi);
    await this.listResources();
  }

  async listResources(): Promise<ProtectedResource[]> {
    const rows = await this.request<SupabaseResourceRow[]>(
      "/rest/v1/protected_resources" +
        "?select=id,owner_id,owner_department,name,description,file_name,created_at" +
        "&order=created_at.asc",
      this.secretKey,
    );
    return rows.map(mapSupabaseResource);
  }

  async readResource(
    id: string,
    userAccessToken: string,
  ): Promise<ResourceReadResult | null> {
    const rows = await this.request<SupabaseResourceRow[]>(
      "/rest/v1/protected_resources?id=eq." +
        encodeURIComponent(id) +
        "&select=id,owner_id,owner_department,name,description,file_name,content,created_at&limit=1",
      userAccessToken,
      { apiKey: this.anonKey },
    );
    const row = rows[0];
    if (!row) return null;
    return { resource: mapSupabaseResource(row), content: row.content ?? "" };
  }

  async appendDecision(decision: AuthorizationDecision): Promise<void> {
    await this.request<unknown>(
      "/rest/v1/authorization_decisions",
      this.secretKey,
      {
        method: "POST",
        body: JSON.stringify({
          id: decision.id,
          request_id: decision.requestId,
          human_user_id: decision.humanUserId,
          human_email: decision.humanEmail,
          human_department: decision.humanDepartment,
          agent_id: decision.agentId,
          agent_name: decision.agentName,
          action: decision.action,
          target_type: decision.targetType,
          target_id: decision.targetId,
          target_label: decision.targetLabel,
          decision: decision.decision,
          reason_code: decision.reasonCode,
          reason: decision.reason,
          created_at: decision.createdAt,
        }),
        prefer: "return=minimal",
      },
    );
  }

  async listDecisions(
    humanUserId: string,
    limit: number,
  ): Promise<AuthorizationDecision[]> {
    return this.request<AuthorizationDecision[]>(
      "/rest/v1/authorization_decisions?human_user_id=eq." +
        encodeURIComponent(humanUserId) +
        "&select=id,requestId:request_id,humanUserId:human_user_id,humanEmail:human_email," +
        "humanDepartment:human_department,agentId:agent_id,agentName:agent_name,action," +
        "targetType:target_type,targetId:target_id,targetLabel:target_label,decision," +
        "reasonCode:reason_code,reason,createdAt:created_at&order=created_at.desc&limit=" +
        limit,
      this.secretKey,
    );
  }

  private async request<T>(
    resourcePath: string,
    bearerToken: string,
    options: {
      method?: string;
      body?: string;
      apiKey?: string;
      prefer?: string;
      accept?: string;
    } = {},
  ): Promise<T> {
    const response = await this.fetchImplementation(this.url + resourcePath, {
      method: options.method ?? "GET",
      headers: {
        apikey: options.apiKey ?? this.secretKey,
        ...(bearerToken.split(".").length === 3
          ? { Authorization: "Bearer " + bearerToken }
          : {}),
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.prefer ? { Prefer: options.prefer } : {}),
        ...(options.accept ? { Accept: options.accept } : {}),
      },
      ...(options.body ? { body: options.body } : {}),
    });
    if (!response.ok) {
      throw new HttpError(503, "Supabase security repository is unavailable");
    }
    const responseBody = await response.text();
    if (!responseBody) return undefined as T;
    return JSON.parse(responseBody) as T;
  }
}

function assertSupabaseSchemaContract(openApi: unknown): void {
  const definitions = asRecord(asRecord(openApi)?.definitions);
  const authorizationDecisions = asRecord(definitions?.authorization_decisions);
  const properties = asRecord(authorizationDecisions?.properties);
  const targetId = asRecord(properties?.target_id);
  const humanDepartment = asRecord(properties?.human_department);

  if (!targetId || targetId.type !== "string" || targetId.format === "uuid") {
    throw incompatibleSupabaseSchema(
      "authorization_decisions.target_id must be text rather than uuid",
    );
  }

  const departmentValues = Array.isArray(humanDepartment?.enum)
    ? humanDepartment.enum.filter((value): value is string => typeof value === "string")
    : [];
  if (
    departmentValues.length === 0 ||
    REQUIRED_DEPARTMENTS.some((department) => !departmentValues.includes(department))
  ) {
    throw incompatibleSupabaseSchema(
      "authorization_decisions.human_department must allow frontend, backend, and qa",
    );
  }
}

function incompatibleSupabaseSchema(detail: string): HttpError {
  return new HttpError(
    503,
    "Supabase schema is incompatible with Agent Trust Gateway: " +
      detail +
      ". Apply the current hosted Supabase setup SQL, reload the PostgREST schema cache, and restart the app.",
    { code: "SUPABASE_SCHEMA_INCOMPATIBLE" },
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function refreshFixtureFile(
  ownerDirectory: string,
  fixture: ResourceFixture,
): Promise<void> {
  const targetPath = path.join(ownerDirectory, fixture.fileName);
  const temporaryPath = path.join(
    ownerDirectory,
    "." + fixture.fileName + "." + randomUUID() + ".tmp",
  );
  await writeFile(temporaryPath, fixture.content, {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    await rename(temporaryPath, targetPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function removeFileIfExists(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function mapSupabaseResource(row: SupabaseResourceRow): ProtectedResource {
  return {
    id: row.id,
    ownerId: row.owner_id,
    ownerDepartment: row.owner_department,
    name: row.name,
    description: row.description,
    fileName: row.file_name,
    storageKey: "supabase:" + row.id,
    createdAt: row.created_at,
  };
}
