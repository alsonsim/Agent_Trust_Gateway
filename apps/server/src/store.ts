import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_LEGACY_OWNER_ID,
  type Agent,
  type Database,
  type Department,
} from "./types.js";

const emptyDatabase = (): Database => ({
  version: 3,
  agents: [],
  workspaceProfiles: [],
  messages: [],
  runs: [],
  protectedResources: [],
  authorizationDecisions: [],
  knownHumans: [],
  delegationRequests: [],
  delegationContracts: [],
  documentAccessRequests: [],
});

type LegacyAgent = Omit<
  Agent,
  "ownerId" | "department" | "workspaceProfileId" | "revokedAt"
> & {
  ownerId?: string;
  department?: Department;
  workspaceProfileId?: string;
  revokedAt?: string | null;
};

interface VersionOneDatabase {
  version: 1;
  agents: LegacyAgent[];
  messages: Database["messages"];
  runs: Database["runs"];
}

interface VersionTwoDatabase {
  version: 2;
  agents: LegacyAgent[];
  messages: Database["messages"];
  runs: Database["runs"];
  protectedResources: Database["protectedResources"];
  authorizationDecisions: Database["authorizationDecisions"];
}

type StoredVersionThreeDatabase = Omit<
  Partial<Database>,
  "version" | "agents"
> & {
  version: 3;
  agents: LegacyAgent[];
};

function parseDatabase(raw: string): { database: Database; migrated: boolean } {
  const parsed = JSON.parse(raw) as
    | StoredVersionThreeDatabase
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
        ...emptyDatabase(),
        agents: legacy.agents.map((agent) => migrateAgent(agent)),
        messages: Array.isArray(legacy.messages) ? legacy.messages : [],
        runs: Array.isArray(legacy.runs) ? legacy.runs : [],
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
        ...emptyDatabase(),
        agents: legacy.agents.map((agent) => migrateAgent(agent)),
        messages: legacy.messages,
        runs: legacy.runs,
        protectedResources: legacy.protectedResources,
        authorizationDecisions: legacy.authorizationDecisions,
      },
    };
  }
  if (
    parsed.version !== 3 ||
    !Array.isArray(parsed.messages) ||
    !Array.isArray(parsed.runs) ||
    !Array.isArray(parsed.protectedResources) ||
    !Array.isArray(parsed.authorizationDecisions) ||
    !isOptionalArray(parsed.workspaceProfiles) ||
    !isOptionalArray(parsed.documentAccessRequests) ||
    !isOptionalArray(parsed.knownHumans) ||
    !isOptionalArray(parsed.delegationRequests) ||
    !isOptionalArray(parsed.delegationContracts)
  ) {
    throw new Error("Unsupported database format");
  }
  const agents = parsed.agents.map((agent) => migrateAgent(agent));
  let removedLegacyRequesterPrompt = false;
  const delegationRequests = (parsed.delegationRequests ?? []).map((request) => {
    if (!("requestedPrompt" in request)) return request;
    removedLegacyRequesterPrompt = true;
    const { requestedPrompt: _requestedPrompt, ...sanitizedRequest } = request as
      DelegationRequestWithLegacyPrompt;
    return sanitizedRequest;
  });
  const database: Database = {
    version: 3,
    agents,
    workspaceProfiles: parsed.workspaceProfiles ?? [],
    messages: parsed.messages,
    runs: parsed.runs,
    protectedResources: parsed.protectedResources,
    authorizationDecisions: parsed.authorizationDecisions,
    knownHumans: parsed.knownHumans ?? [],
    delegationRequests,
    delegationContracts: parsed.delegationContracts ?? [],
    documentAccessRequests: parsed.documentAccessRequests ?? [],
  };
  return {
    database,
    migrated:
      parsed.agents.some(
        (agent) =>
          agent.revokedAt === undefined ||
          agent.department === undefined ||
          agent.workspaceProfileId === undefined,
      ) ||
      parsed.workspaceProfiles === undefined ||
      parsed.documentAccessRequests === undefined ||
      parsed.knownHumans === undefined ||
      parsed.delegationRequests === undefined ||
      parsed.delegationContracts === undefined ||
      removedLegacyRequesterPrompt,
  };
}

function isOptionalArray(value: unknown): boolean {
  return value === undefined || Array.isArray(value);
}

function legacyDepartment(ownerId: string): Department {
  if (ownerId === "22222222-2222-4222-8222-222222222222") return "hr";
  if (ownerId === "33333333-3333-4333-8333-333333333333") return "research";
  return "finance";
}

function migrateAgent(
  agent: LegacyAgent,
): Agent {
  const ownerId = agent.ownerId || DEFAULT_LEGACY_OWNER_ID;
  const department = agent.department ?? legacyDepartment(ownerId);
  return {
    ...agent,
    ownerId,
    department,
    workspaceProfileId: agent.workspaceProfileId ?? "department-" + department,
    revokedAt: agent.revokedAt ?? null,
  };
}

type DelegationRequestWithLegacyPrompt = Database["delegationRequests"][number] & {
  requestedPrompt: string;
};

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
