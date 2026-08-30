import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_LEGACY_OWNER_ID,
  type Agent,
  type AuthorizationDecision,
  type Database,
  type Department,
  type ProtectedResource,
  type WorkspaceProfile,
} from "./types.js";

const emptyDatabase = (): Database => ({
  version: 4,
  agents: [],
  workspaceProfiles: [],
  messages: [],
  runs: [],
  protectedResources: [],
  authorizationDecisions: [],
  knownHumans: [],
  delegationRequests: [],
  delegationContracts: [],
});

type LegacyDepartment = Department | "finance" | "hr" | "research";

type LegacyAgent = Omit<
  Agent,
  "ownerId" | "department" | "workspaceProfileId" | "revokedAt"
> & {
  ownerId?: string;
  department?: LegacyDepartment;
  workspaceProfileId?: string;
  revokedAt?: string | null;
};

type LegacyWorkspaceProfile = Omit<WorkspaceProfile, "id" | "department"> & {
  id?: string;
  department: LegacyDepartment;
};

type LegacyProtectedResource = Omit<ProtectedResource, "ownerDepartment"> & {
  ownerDepartment: LegacyDepartment;
};

type LegacyAuthorizationDecision = Omit<AuthorizationDecision, "humanDepartment"> & {
  humanDepartment: LegacyDepartment;
};

type LegacyKnownHuman = Omit<Database["knownHumans"][number], "department"> & {
  department: LegacyDepartment;
};

type LegacyDelegationRequest = Omit<
  Database["delegationRequests"][number],
  "requesterDepartment" | "personalInformation"
> & {
  requesterDepartment: LegacyDepartment;
  personalInformation: Database["delegationRequests"][number]["personalInformation"] | "none";
  requestedPrompt?: string;
};

type LegacyDelegationContract = Omit<
  Database["delegationContracts"][number],
  "granteeDepartment" | "personalInformation"
> & {
  granteeDepartment: LegacyDepartment;
  personalInformation: Database["delegationContracts"][number]["personalInformation"] | "none";
};

interface PersistedDatabaseShape {
  version?: number;
  agents?: LegacyAgent[];
  workspaceProfiles?: LegacyWorkspaceProfile[];
  messages?: Database["messages"];
  runs?: Database["runs"];
  protectedResources?: LegacyProtectedResource[];
  authorizationDecisions?: LegacyAuthorizationDecision[];
  knownHumans?: LegacyKnownHuman[];
  delegationRequests?: LegacyDelegationRequest[];
  delegationContracts?: LegacyDelegationContract[];
  // An incoming v3 briefly persisted this unused scaffold. Only an empty
  // array can be discarded without pretending the unimplemented feature exists.
  documentAccessRequests?: unknown[];
}

function parseDatabase(raw: string): { database: Database; migrated: boolean } {
  const parsed = JSON.parse(raw) as PersistedDatabaseShape;
  if (
    parsed.version !== 1 &&
    parsed.version !== 2 &&
    parsed.version !== 3 &&
    parsed.version !== 4
  ) {
    throw new Error("Unsupported database format");
  }
  if (!Array.isArray(parsed.agents)) {
    throw new Error("Unsupported database format");
  }
  if (
    parsed.version === 4 &&
    (!Array.isArray(parsed.workspaceProfiles) ||
      !Array.isArray(parsed.messages) ||
      !Array.isArray(parsed.runs) ||
      !Array.isArray(parsed.protectedResources) ||
      !Array.isArray(parsed.authorizationDecisions) ||
      !isOptionalArray(parsed.knownHumans) ||
      !isOptionalArray(parsed.delegationRequests) ||
      !isOptionalArray(parsed.delegationContracts))
  ) {
    throw new Error("Unsupported database format");
  }
  if (
    !isOptionalArray(parsed.knownHumans) ||
    !isOptionalArray(parsed.delegationRequests) ||
    !isOptionalArray(parsed.delegationContracts)
  ) {
    throw new Error("Unsupported database format");
  }
  if (
    parsed.documentAccessRequests !== undefined &&
    (!Array.isArray(parsed.documentAccessRequests) || parsed.documentAccessRequests.length > 0)
  ) {
    throw new Error(
      "Unsupported non-empty document access request state from an incomplete schema",
    );
  }

  const database: Database = {
    version: 4,
    agents: parsed.agents.map(normalizeAgent),
    workspaceProfiles: normalizeWorkspaceProfiles(parsed.workspaceProfiles ?? []),
    messages: arrayOrEmpty(parsed.messages),
    runs: arrayOrEmpty(parsed.runs),
    protectedResources: arrayOrEmpty(parsed.protectedResources).map((resource) => ({
      ...resource,
      ownerDepartment: migrateDepartment(resource.ownerDepartment),
    })),
    authorizationDecisions: arrayOrEmpty(parsed.authorizationDecisions).map(
      (decision) => ({
        ...decision,
        humanDepartment: migrateDepartment(decision.humanDepartment),
      }),
    ),
    knownHumans: arrayOrEmpty(parsed.knownHumans).map((human) => ({
      ...human,
      department: migrateDepartment(human.department),
    })),
    delegationRequests: arrayOrEmpty(parsed.delegationRequests).map(
      normalizeDelegationRequest,
    ),
    delegationContracts: arrayOrEmpty(parsed.delegationContracts).map((contract) => ({
      ...contract,
      requiredCapability: migrateCapability(contract.requiredCapability),
      granteeDepartment: migrateDepartment(contract.granteeDepartment),
      personalInformation: normalizePersonalInformation(contract.personalInformation),
    })),
  };

  const comparableSource = {
    version: parsed.version,
    agents: parsed.agents,
    workspaceProfiles: parsed.workspaceProfiles,
    messages: parsed.messages,
    runs: parsed.runs,
    protectedResources: parsed.protectedResources,
    authorizationDecisions: parsed.authorizationDecisions,
    knownHumans: parsed.knownHumans,
    delegationRequests: parsed.delegationRequests,
    delegationContracts: parsed.delegationContracts,
  };
  return {
    database,
    migrated:
      parsed.documentAccessRequests !== undefined ||
      JSON.stringify(comparableSource) !== JSON.stringify(database),
  };
}

function arrayOrEmpty<T>(value: T[] | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

function isOptionalArray(value: unknown): boolean {
  return value === undefined || Array.isArray(value);
}

function migrateDepartment(
  value: LegacyDepartment | undefined,
  ownerId?: string,
): Department {
  if (value === "finance") return "frontend";
  if (value === "hr") return "backend";
  if (value === "research") return "qa";
  if (value === "frontend" || value === "backend" || value === "qa") return value;
  if (value === undefined && ownerId) return departmentForOwner(ownerId);
  throw new Error("Unsupported department in database");
}

function departmentForOwner(ownerId: string): Department {
  if (ownerId === "22222222-2222-4222-8222-222222222222") return "backend";
  if (ownerId === "33333333-3333-4333-8333-333333333333") return "qa";
  return "frontend";
}

function normalizeAgent(agent: LegacyAgent): Agent {
  const ownerId = agent.ownerId || DEFAULT_LEGACY_OWNER_ID;
  const department = migrateDepartment(agent.department, ownerId);
  return {
    ...agent,
    ownerId,
    department,
    workspaceProfileId: "department-" + department,
    revokedAt: agent.revokedAt ?? null,
  };
}

function normalizeWorkspaceProfiles(
  profiles: LegacyWorkspaceProfile[],
): WorkspaceProfile[] {
  const normalized = new Map<string, WorkspaceProfile>();
  for (const profile of profiles) {
    const department = migrateDepartment(profile.department);
    const id = "department-" + department;
    if (!normalized.has(id)) {
      normalized.set(id, { ...profile, id, department });
    }
  }
  return [...normalized.values()];
}

function normalizeDelegationRequest(
  request: LegacyDelegationRequest,
): Database["delegationRequests"][number] {
  const { requestedPrompt: _requestedPrompt, ...sanitizedRequest } = request;
  return {
    ...sanitizedRequest,
    requiredCapability: migrateCapability(request.requiredCapability),
    requesterDepartment: migrateDepartment(request.requesterDepartment),
    personalInformation: normalizePersonalInformation(request.personalInformation),
  };
}

function normalizePersonalInformation(
  value: LegacyDelegationRequest["personalInformation"],
): Database["delegationRequests"][number]["personalInformation"] {
  return value === "none" ? "none_detected" : value;
}

function migrateCapability(value: string): string {
  if (value === "finance.cost-analysis") return "frontend.interface-implementation";
  if (value === "hr.people-operations") return "backend.service-implementation";
  if (value === "research.evidence-synthesis") return "qa.release-validation";
  return value;
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
