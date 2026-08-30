import { execFile, spawn, type ChildProcess } from "node:child_process";
import { copyFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import type { AppConfig } from "./config.js";
import {
  buildCodexArgs,
  parseCodexEventLine,
  resolveRunnerCodexHome,
} from "./codex-runner.js";
import { RunCancelledError } from "./errors.js";
import { isProtectedWorkspacePath } from "./workspace-file-policy.js";
import type {
  AgentRunner,
  RunUsage,
  RunnerRequest,
  RunnerResult,
} from "./types.js";

const execFileAsync = promisify(execFile);

interface ActiveContainer {
  child: ChildProcess;
  containerName: string;
  cancelled: boolean;
  timedOut: boolean;
  outputExceeded: boolean;
  settled: Promise<void>;
  termination: Promise<void> | null;
}

interface ParsedEvents {
  messages: string[];
  threadId: string | null;
  usage: RunUsage | null;
  errors: string[];
}

export class ContainerRemovalUnverifiedError extends Error {
  readonly code = "CONTAINER_REMOVAL_UNVERIFIED";

  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "ContainerRemovalUnverifiedError";
  }
}

export function containerName(agentId: string, instanceId = "default"): string {
  const safeInstance = instanceId.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 32);
  const safeAgent = agentId.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 48);
  return "launchpad-" + safeInstance + "-" + safeAgent;
}

export function buildContainerRunArgs(
  request: RunnerRequest,
  config: AppConfig,
): string[] {
  const name = containerName(request.agentId, config.runtimeInstanceId);
  const engineName = config.containerEngine.split(/[\\/]/).at(-1)?.toLowerCase();
  const codexHome = resolveRunnerCodexHome(request, config);
  return [
    "run",
    "--rm",
    "--init",
    "--name",
    name,
    "--label",
    "io.codejam.launchpad=agent-runtime",
    "--label",
    "io.codejam.agent-id=" + request.agentId,
    "--label",
    "io.codejam.instance-id=" + config.runtimeInstanceId,
    ...(engineName === "podman" ? ["--userns", "keep-id"] : []),
    ...(config.localInsecureRuntimeNetwork ? [] : ["--network", "none"]),
    "--security-opt",
    "no-new-privileges",
    "--cap-drop",
    "ALL",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=64m",
    "--cpus",
    String(config.containerCpuLimit),
    "--memory",
    config.containerMemoryLimit,
    "--pids-limit",
    String(config.containerPidsLimit),
    "--user",
    config.containerUser,
    "--env",
    "CODEX_HOME=/codex-home",
    "--env",
    "HOME=/tmp",
    "--env",
    "NO_COLOR=1",
    ...(config.localInsecureRuntimeKeyPassthrough
      ? ["--env", "ARK_API_KEY", "--env", "ARK_MODEL"]
      : []),
    "--mount",
    "type=bind,src=" + request.workspacePath + ",dst=/workspace",
    "--mount",
    "type=bind,src=" + codexHome + ",dst=/codex-home",
    "--workdir",
    "/workspace",
    config.containerRuntimeImage,
    config.containerCodexBin,
    ...buildCodexArgs(request, config.codexSandboxMode, "/workspace"),
  ];
}

export class ContainerCodexRunner implements AgentRunner {
  private readonly active = new Map<string, ActiveContainer>();

  constructor(private readonly config: AppConfig) {}

  async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync(this.config.containerEngine, ["version"], {
        timeout: 5_000,
        env: buildContainerCliEnvironment(this.config, false),
      });
      await execFileAsync(
        this.config.containerEngine,
        ["image", "inspect", this.config.containerRuntimeImage],
        { timeout: 5_000, env: buildContainerCliEnvironment(this.config, false) },
      );
      return true;
    } catch {
      return false;
    }
  }

  async removeStaleContainers(): Promise<void> {
    let output: string;
    try {
      const result = await execFileAsync(
        this.config.containerEngine,
        [
          "ps",
          "--all",
          "--quiet",
          "--filter",
          "label=io.codejam.launchpad=agent-runtime",
          "--filter",
          "label=io.codejam.instance-id=" + this.config.runtimeInstanceId,
        ],
        {
          timeout: 8_000,
          env: buildContainerCliEnvironment(this.config, false),
        },
      );
      output =
        typeof result === "string"
          ? result
          : Buffer.isBuffer(result)
            ? result.toString("utf8")
            : Buffer.isBuffer(result.stdout)
              ? result.stdout.toString("utf8")
              : result.stdout;
    } catch (error) {
      throw new ContainerRemovalUnverifiedError(
        "Could not enumerate stale Runtime containers",
        error,
      );
    }

    const containerIds = output
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean);
    if (containerIds.some((value) => !/^[a-f0-9]{12,64}$/i.test(value))) {
      throw new ContainerRemovalUnverifiedError(
        "Container engine returned an unsafe stale container identifier",
      );
    }
    const outcomes = await Promise.allSettled(
      containerIds.map((containerId) => this.forceRemoveAndVerify(containerId)),
    );
    const failures = outcomes
      .filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected")
      .map((outcome) => outcome.reason);
    if (failures.length > 0) {
      throw new ContainerRemovalUnverifiedError(
        "One or more stale Runtime containers could not be proven removed",
        new AggregateError(failures),
      );
    }
  }

  async cancel(agentId: string): Promise<boolean> {
    const active = this.active.get(agentId);
    if (!active) return false;

    active.cancelled = true;
    await this.removeContainer(active);
    await active.settled;
    return true;
  }

  private removeContainer(active: ActiveContainer): Promise<void> {
    if (!active.termination) {
      active.termination = this.forceRemoveAndVerify(active.containerName);
    }
    return active.termination;
  }

  private async forceRemoveAndVerify(containerNameValue: string): Promise<void> {
    let removalError: unknown = null;
    try {
      await execFileAsync(
        this.config.containerEngine,
        ["rm", "--force", containerNameValue],
        {
          timeout: 8_000,
          env: buildContainerCliEnvironment(this.config, false),
        },
      );
    } catch (error) {
      removalError = error;
    }

    try {
      await execFileAsync(
        this.config.containerEngine,
        ["inspect", containerNameValue],
        {
          timeout: 5_000,
          env: buildContainerCliEnvironment(this.config, false),
        },
      );
    } catch (error) {
      if (isMissingContainerError(error)) return;
      throw new ContainerRemovalUnverifiedError(
        "Could not verify Runtime container removal",
        removalError ?? error,
      );
    }
    throw new ContainerRemovalUnverifiedError(
      "Runtime container still exists after forced removal",
      removalError ?? undefined,
    );
  }

  async run(request: RunnerRequest): Promise<RunnerResult> {
    if (this.active.has(request.agentId)) {
      throw new Error("Agent already has an active Runtime container");
    }

    const delegatedRun = request.codexHome !== undefined;
    const workspaceProfileId = request.workspaceProfileId || request.agentId;
    const runtimeWorkspace = delegatedRun
      ? request.workspacePath
      : path.join(
          this.config.dataDirectory,
          "runtime-projections",
          workspaceProfileId,
        );
    if (!delegatedRun) {
      await createWorkspaceProjection(request.workspacePath, runtimeWorkspace);
    }
    const runtimeCodexHome = delegatedRun
      ? resolveRunnerCodexHome(request, this.config)
      : path.join(
          this.config.dataDirectory,
          "runtime-codex-homes",
          workspaceProfileId,
        );
    if (!delegatedRun) {
      await prepareRuntimeCodexHome(this.config.codexHome, runtimeCodexHome);
    }
    const runtimeConfig = { ...this.config, codexHome: runtimeCodexHome };
    const runtimeRequest = {
      ...request,
      workspacePath: runtimeWorkspace,
      codexHome: runtimeCodexHome,
    };
    const child = spawn(
      this.config.containerEngine,
      buildContainerRunArgs(runtimeRequest, runtimeConfig),
      {
        cwd: runtimeWorkspace,
        env: buildContainerCliEnvironment(
          this.config,
          this.config.localInsecureRuntimeKeyPassthrough,
        ),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const settled = new Promise<void>((resolve) => {
      child.once("close", () => resolve());
      child.once("error", () => resolve());
    });
    const active: ActiveContainer = {
      child,
      containerName: containerName(request.agentId, this.config.runtimeInstanceId),
      cancelled: false,
      timedOut: false,
      outputExceeded: false,
      settled,
      termination: null,
    };
    this.active.set(request.agentId, active);

    const parsed: ParsedEvents = {
      messages: [],
      threadId: request.threadId,
      usage: null,
      errors: [],
    };
    let stdout = "";
    let stderr = "";
    let totalBytes = 0;

    const consume = (chunk: Buffer, target: "stdout" | "stderr") => {
      totalBytes += chunk.byteLength;
      if (totalBytes > this.config.codexMaxOutputBytes) {
        active.outputExceeded = true;
        void this.removeContainer(active).catch(() => undefined);
        return;
      }
      if (target === "stdout") {
        stdout += chunk.toString("utf8");
        const lines = stdout.split(/\r?\n/);
        stdout = lines.pop() ?? "";
        for (const line of lines) parseCodexEventLine(line, parsed);
      } else {
        stderr += chunk.toString("utf8");
        if (stderr.length > 16_384) stderr = stderr.slice(-16_384);
      }
    };

    child.stdout.on("data", (chunk: Buffer) => consume(chunk, "stdout"));
    child.stderr.on("data", (chunk: Buffer) => consume(chunk, "stderr"));

    const timeout = setTimeout(() => {
      active.timedOut = true;
      void this.removeContainer(active).catch(() => undefined);
    }, this.config.codexTimeoutMs);
    timeout.unref();

    try {
      const exitCode = await new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => resolve(code ?? 1));
      });
      if (stdout.trim()) parseCodexEventLine(stdout.trim(), parsed);
      if (active.cancelled) throw new RunCancelledError();
      if (active.timedOut) {
        throw new Error("Runtime timed out after " + this.config.codexTimeoutMs + " ms");
      }
      if (active.outputExceeded) {
        throw new Error("Codex output exceeded CODEX_MAX_OUTPUT_BYTES");
      }
      if (exitCode !== 0) {
        const detail = parsed.errors.at(-1) ?? stderr.trim() ?? "No error detail";
        throw new Error(
          this.config.containerEngine +
            " Runtime exited with code " +
            exitCode +
            ": " +
            detail,
        );
      }
      const output = parsed.messages.at(-1)?.trim();
      if (!output) throw new Error("Codex completed without an agent message");
      return { output, threadId: parsed.threadId, usage: parsed.usage };
    } finally {
      clearTimeout(timeout);
      try {
        // A client process can exit while its daemon-side container keeps running.
        // Do not let callers remove bind-mounted data until the daemon
        // has positively reported that this container no longer exists.
        await this.removeContainer(active);
        if (!delegatedRun) {
          await syncWorkspaceProjection(runtimeWorkspace, request.workspacePath);
          await rm(runtimeWorkspace, { recursive: true, force: true });
        }
      } finally {
        this.active.delete(request.agentId);
      }
    }
  }
}

export function buildContainerCliEnvironment(
  config: AppConfig,
  includeRuntimeCredentials = false,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    NO_COLOR: "1",
  };
  if (includeRuntimeCredentials) {
    environment.ARK_API_KEY = config.arkApiKey;
    environment.ARK_MODEL = config.arkModel;
  }
  for (const name of [
    "PATH",
    "HOME",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "XDG_RUNTIME_DIR",
  ] as const) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  return environment;
}

export async function createWorkspaceProjection(source: string, destination: string): Promise<void> {
  await rm(destination, { recursive: true, force: true });
  await copySafeTree(source, destination);
}

async function copySafeTree(source: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (isProtectedWorkspacePath(entry.name) || entry.isSymbolicLink()) continue;
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) await copySafeTree(sourcePath, destinationPath);
    else if (entry.isFile()) await copyFile(sourcePath, destinationPath);
  }
}

async function prepareRuntimeCodexHome(source: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  for (const relativePath of ["config.toml", "execpolicy/runtime-action-firewall.rules"]) {
    const sourcePath = path.join(source, relativePath);
    const destinationPath = path.join(destination, relativePath);
    try {
      const sourceStat = await stat(sourcePath);
      if (!sourceStat.isFile()) continue;
      await mkdir(path.dirname(destinationPath), { recursive: true });
      await copyFile(sourcePath, destinationPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

async function syncWorkspaceProjection(source: string, destination: string): Promise<void> {
  await copySafeTree(source, destination);
}

function isMissingContainerError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const stderr = "stderr" in error ? error.stderr : null;
  const detail = Buffer.isBuffer(stderr)
    ? stderr.toString("utf8")
    : typeof stderr === "string"
      ? stderr
      : "";
  return /no such (?:object|container)/i.test(detail);
}
