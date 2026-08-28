import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_LEGACY_OWNER_ID, type Agent, type Database } from "./types.js";

const emptyDatabase = (): Database => ({
  version: 2,
  agents: [],
  messages: [],
  runs: [],
  protectedResources: [],
  authorizationDecisions: [],
});

interface LegacyDatabase {
  version: 1;
  agents: Array<Omit<Agent, "ownerId"> & { ownerId?: string }>;
  messages: Database["messages"];
  runs: Database["runs"];
}

function parseDatabase(raw: string): { database: Database; migrated: boolean } {
  const parsed = JSON.parse(raw) as Partial<Database> | LegacyDatabase;
  if (!Array.isArray(parsed.agents)) {
    throw new Error("Unsupported database format");
  }
  if (parsed.version === 1) {
    const legacy = parsed as LegacyDatabase;
    return {
      migrated: true,
      database: {
        version: 2,
        agents: legacy.agents.map((agent) => ({
          ...agent,
          ownerId: agent.ownerId || DEFAULT_LEGACY_OWNER_ID,
        })),
        messages: Array.isArray(legacy.messages) ? legacy.messages : [],
        runs: Array.isArray(legacy.runs) ? legacy.runs : [],
        protectedResources: [],
        authorizationDecisions: [],
      },
    };
  }
  if (
    parsed.version !== 2 ||
    !Array.isArray(parsed.messages) ||
    !Array.isArray(parsed.runs) ||
    !Array.isArray(parsed.protectedResources) ||
    !Array.isArray(parsed.authorizationDecisions)
  ) {
    throw new Error("Unsupported database format");
  }
  return { database: parsed as Database, migrated: false };
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
