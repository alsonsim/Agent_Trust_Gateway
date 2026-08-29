import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_LEGACY_OWNER_ID,
  type Agent,
  type AuthorizationDecision,
  type Database,
  type Department,
  type ProtectedResource,
} from "./types.js";

const emptyDatabase = (): Database => ({
  version: 3,
  agents: [],
  messages: [],
  runs: [],
  protectedResources: [],
  authorizationDecisions: [],
});

interface VersionOneDatabase {
  version: 1;
  agents: Array<
    Omit<Agent, "ownerId" | "revokedAt"> & {
      ownerId?: string;
      revokedAt?: string | null;
    }
  >;
  messages: Database["messages"];
  runs: Database["runs"];
}

type LegacyDepartment = Department | "finance" | "hr" | "research";

interface VersionTwoDatabase {
  version: 2;
  agents: Array<Omit<Agent, "revokedAt"> & { revokedAt?: string | null }>;
  messages: Database["messages"];
  runs: Database["runs"];
  protectedResources: Array<
    Omit<ProtectedResource, "ownerDepartment"> & {
      ownerDepartment: LegacyDepartment;
    }
  >;
  authorizationDecisions: Array<
    Omit<AuthorizationDecision, "humanDepartment"> & {
      humanDepartment: LegacyDepartment;
    }
  >;
}

function migrateDepartment(value: LegacyDepartment): Department {
  if (value === "finance") return "frontend";
  if (value === "hr") return "backend";
  if (value === "research") return "qa";
  if (value === "frontend" || value === "backend" || value === "qa") return value;
  throw new Error("Unsupported department in database");
}

function normalizeAgents(
  agents: Array<Omit<Agent, "revokedAt"> & { revokedAt?: string | null }>,
): Agent[] {
  return agents.map((agent) => ({ ...agent, revokedAt: agent.revokedAt ?? null }));
}

function parseDatabase(raw: string): { database: Database; migrated: boolean } {
  const parsed = JSON.parse(raw) as
    | Partial<Database>
    | VersionOneDatabase
    | VersionTwoDatabase;
  if (!Array.isArray(parsed.agents)) {
    throw new Error("Unsupported database format");
  }
  if (parsed.version === 1) {
    const legacy = parsed as VersionOneDatabase;
    return {
      migrated: true,
      database: {
        version: 3,
        agents: legacy.agents.map((agent) => ({
          ...agent,
          ownerId: agent.ownerId || DEFAULT_LEGACY_OWNER_ID,
          revokedAt: agent.revokedAt ?? null,
        })),
        messages: Array.isArray(legacy.messages) ? legacy.messages : [],
        runs: Array.isArray(legacy.runs) ? legacy.runs : [],
        protectedResources: [],
        authorizationDecisions: [],
      },
    };
  }
  if (parsed.version === 2) {
    const legacy = parsed as VersionTwoDatabase;
    if (
      !Array.isArray(legacy.messages) ||
      !Array.isArray(legacy.runs) ||
      !Array.isArray(legacy.protectedResources) ||
      !Array.isArray(legacy.authorizationDecisions)
    ) {
      throw new Error("Unsupported database format");
    }
    return {
      migrated: true,
      database: {
        version: 3,
        agents: normalizeAgents(legacy.agents),
        messages: legacy.messages,
        runs: legacy.runs,
        protectedResources: legacy.protectedResources.map((resource) => ({
          ...resource,
          ownerDepartment: migrateDepartment(resource.ownerDepartment),
        })),
        authorizationDecisions: legacy.authorizationDecisions.map((decision) => ({
          ...decision,
          humanDepartment: migrateDepartment(decision.humanDepartment),
        })),
      },
    };
  }
  if (
    parsed.version !== 3 ||
    !Array.isArray(parsed.messages) ||
    !Array.isArray(parsed.runs) ||
    !Array.isArray(parsed.protectedResources) ||
    !Array.isArray(parsed.authorizationDecisions)
  ) {
    throw new Error("Unsupported database format");
  }
  const database = parsed as Database;
  const agents = normalizeAgents(database.agents);
  return {
    database: { ...database, agents },
    migrated: database.agents.some((agent) => agent.revokedAt === undefined),
  };
}

export class JsonStore {
  private data: Database = emptyDatabase();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = await readFile(this.filePath, "utf8");
      const { database, migrated } = parseDatabase(raw);
      this.data = database;
      if (migrated) await this.persist(database);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      await this.persist();
    }
  }

  snapshot(): Database {
    return structuredClone(this.data);
  }

  async mutate<T>(mutation: (database: Database) => T | Promise<T>): Promise<T> {
    let result!: T;
    const operation = this.queue.then(async () => {
      const next = structuredClone(this.data);
      result = await mutation(next);
      await this.persist(next);
      this.data = next;
    });
    this.queue = operation.catch(() => undefined);
    await operation;
    return result;
  }

  private async persist(data: Database = this.data): Promise<void> {
    const temporaryPath = this.filePath + ".tmp";
    await writeFile(temporaryPath, JSON.stringify(data, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, this.filePath);
  }
}
