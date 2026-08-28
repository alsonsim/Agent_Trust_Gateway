import { mkdir, readFile, writeFile } from "node:fs/promises";
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
    ownerDepartment: "finance",
    name: "Quarterly budget",
    description: "Synthetic Finance planning data for the authorization demo.",
    fileName: "quarterly-budget.md",
    content:
      "# Quarterly budget (synthetic)\n\nLaunch budget: SGD 125,000.\nContingency: SGD 18,500.\n",
  },
  {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2",
    ownerId: "22222222-2222-4222-8222-222222222222",
    ownerDepartment: "hr",
    name: "Compensation bands",
    description: "Synthetic HR compensation data for the authorization demo.",
    fileName: "compensation-bands.md",
    content:
      "# Compensation bands (synthetic)\n\nLevel H3: SGD 82,000–104,000.\nLevel H4: SGD 105,000–138,000.\n",
  },
  {
    id: "cccccccc-cccc-4ccc-8ccc-ccccccccccc3",
    ownerId: "33333333-3333-4333-8333-333333333333",
    ownerDepartment: "research",
    name: "Experiment notes",
    description: "Synthetic Research notes for the authorization demo.",
    fileName: "experiment-notes.md",
    content:
      "# Experiment notes (synthetic)\n\nEvaluation set: trust-gateway-v2.\nPrimary metric: unauthorized reads blocked.\n",
  },
];

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
      try {
        await writeFile(path.join(ownerDirectory, fixture.fileName), fixture.content, {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    await this.store.mutate((database) => {
      for (const fixture of RESOURCE_FIXTURES) {
        if (database.protectedResources.some((resource) => resource.id === fixture.id)) {
          continue;
        }
        database.protectedResources.push({
          id: fixture.id,
          ownerId: fixture.ownerId,
          ownerDepartment: fixture.ownerDepartment,
          name: fixture.name,
          description: fixture.description,
          fileName: fixture.fileName,
          storageKey: fixture.ownerId + "/" + fixture.fileName,
          createdAt: new Date().toISOString(),
        });
      }
    });
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

export class SupabaseSecurityRepository implements SecurityRepository {
  constructor(
    private readonly url: string,
    private readonly anonKey: string,
    private readonly secretKey: string,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {}

  async initialize(): Promise<void> {
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
