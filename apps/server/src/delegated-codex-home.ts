import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MANAGED_HOME_PREFIX = "run-";
const ALLOWED_CODEX_HOME_FILES = [
  ["config.toml"],
  ["execpolicy", "runtime-action-firewall.rules"],
] as const;

export class DelegatedCodexHomeManager {
  private readonly managedRoot: string;
  private readonly sourceCodexHome: string;

  constructor(dataDirectory: string, sourceCodexHome: string) {
    const resolvedDataDirectory = path.resolve(dataDirectory);
    this.managedRoot = path.join(resolvedDataDirectory, "delegated-codex-homes");
    this.sourceCodexHome = path.resolve(sourceCodexHome);
  }

  /** Initialize once during process startup, before accepting delegated Runs. */
  async initialize(): Promise<void> {
    await this.ensureManagedRoot();
  }

  async create(runId: string): Promise<string> {
    assertSafeRunId(runId);
    await this.ensureManagedRoot();

    const homePath = path.join(this.managedRoot, MANAGED_HOME_PREFIX + runId);
    this.assertManagedHomePath(homePath);
    await mkdir(homePath, { recursive: false, mode: 0o700 });

    try {
      for (const relativeSegments of ALLOWED_CODEX_HOME_FILES) {
        await this.copyAllowedFile(homePath, relativeSegments);
      }
      return homePath;
    } catch (error) {
      await this.cleanup(homePath);
      throw error;
    }
  }

  async cleanup(homePath: string): Promise<void> {
    this.assertManagedHomePath(homePath);
    await this.ensureManagedRoot();
    await rm(homePath, { recursive: true, force: true });
  }

  async cleanupStale(): Promise<void> {
    await this.ensureManagedRoot();
    const entries = await readdir(this.managedRoot, { withFileTypes: true });
    const outcomes = await Promise.allSettled(
      entries
        .filter((entry) => entry.name.startsWith(MANAGED_HOME_PREFIX))
        .map(async (entry) => {
          const homePath = path.resolve(this.managedRoot, entry.name);
          if (
            path.dirname(homePath) !== this.managedRoot ||
            path.basename(homePath) !== entry.name ||
            !isManagedHomeName(entry.name)
          ) {
            throw new Error(
              `Refusing unsafe managed delegated Codex home entry: ${entry.name}`,
            );
          }

          const entryStat = await lstat(homePath);
          if (!entryStat.isDirectory() || entryStat.isSymbolicLink()) {
            throw new Error(
              `Managed delegated Codex home must be a real directory: ${entry.name}`,
            );
          }
          await rm(homePath, { recursive: true, force: false });
        }),
    );
    const failures = outcomes
      .filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected")
      .map((outcome) => outcome.reason);
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "One or more stale delegated Codex home entries were unsafe or could not be removed",
      );
    }
  }

  private async ensureManagedRoot(): Promise<void> {
    await mkdir(this.managedRoot, { recursive: true, mode: 0o700 });
    const rootStat = await lstat(this.managedRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error("Delegated Codex home root must be a real directory");
    }
    await chmod(this.managedRoot, 0o700);
  }

  private assertManagedHomePath(homePath: string): void {
    const resolvedHome = path.resolve(homePath);
    if (
      homePath !== resolvedHome ||
      path.dirname(resolvedHome) !== this.managedRoot ||
      !isManagedHomeName(path.basename(resolvedHome))
    ) {
      throw new Error(
        "Delegated Codex home cleanup is limited to generated direct children",
      );
    }
  }

  private async copyAllowedFile(
    destinationHome: string,
    relativeSegments: readonly string[],
  ): Promise<void> {
    if (relativeSegments.length > 1) {
      const sourceParent = path.join(
        this.sourceCodexHome,
        ...relativeSegments.slice(0, -1),
      );
      try {
        const parentStat = await lstat(sourceParent);
        if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
          throw new Error("Allowed Codex configuration parent must be a real directory");
        }
      } catch (error) {
        if (isMissingFileError(error)) return;
        throw error;
      }
    }

    const sourcePath = path.join(this.sourceCodexHome, ...relativeSegments);
    try {
      const pathStat = await lstat(sourcePath);
      if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
        throw new Error("Allowed Codex configuration source must be a real file");
      }
    } catch (error) {
      if (isMissingFileError(error)) return;
      throw error;
    }
    let sourceHandle;
    try {
      sourceHandle = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (isMissingFileError(error)) return;
      throw error;
    }

    let content: Buffer;
    try {
      const sourceStat = await sourceHandle.stat();
      if (!sourceStat.isFile()) {
        throw new Error("Allowed Codex configuration source must be a regular file");
      }
      content = await sourceHandle.readFile();
    } finally {
      await sourceHandle.close();
    }

    const destinationPath = path.join(destinationHome, ...relativeSegments);
    if (relativeSegments.length > 1) {
      await mkdir(path.dirname(destinationPath), {
        recursive: false,
        mode: 0o700,
      });
    }
    await writeFile(destinationPath, content, { flag: "wx", mode: 0o600 });
  }
}

function assertSafeRunId(runId: string): void {
  if (!SAFE_RUN_ID.test(runId) || runId === "." || runId === "..") {
    throw new Error("Run ID must be a safe path segment");
  }
}

function isManagedHomeName(name: string): boolean {
  return (
    name.startsWith(MANAGED_HOME_PREFIX) &&
    SAFE_RUN_ID.test(name.slice(MANAGED_HOME_PREFIX.length))
  );
}

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
