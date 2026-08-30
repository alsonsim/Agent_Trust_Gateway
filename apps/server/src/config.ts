import { mkdir, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { z } from "zod";

const booleanEnvironmentValue = z
  .enum(["true", "false"])
  .transform((value) => value === "true");

const envSchema = z.object({
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.string().default("info"),
  APP_DATA_DIR: z.string().default(path.resolve(".data")),
  AGENT_WORKSPACE_ROOT: z.string().default(path.resolve("workspaces")),
  CODEX_HOME: z.string().default(path.resolve("codex-home")),
  CODEX_BIN: z.string().optional(),
  CONTAINER_CODEX_BIN: z.string().optional(),
  CODEX_SANDBOX_MODE: z
    .enum(["read-only", "workspace-write", "danger-full-access"])
    .default("workspace-write"),
  CODEX_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(600_000),
  CODEX_MAX_OUTPUT_BYTES: z.coerce.number().int().min(65_536).default(2_097_152),
  RUNTIME_PROVIDER: z.enum(["local-process", "container"]).default("local-process"),
  CONTAINER_ENGINE: z.string().min(1).default("docker"),
  CONTAINER_RUNTIME_IMAGE: z.string().min(1).default("volc-agent-runtime:local"),
  CONTAINER_CPU_LIMIT: z.coerce.number().positive().default(2),
  CONTAINER_MEMORY_LIMIT: z
    .string()
    .regex(/^\d+(?:\.\d+)?[bkmg]$/i)
    .default("2g"),
  CONTAINER_PIDS_LIMIT: z.coerce.number().int().positive().default(256),
  CONTAINER_USER: z.string().optional(),
  RUNTIME_INSTANCE_ID: z
    .string()
    .trim()
    .min(1)
    .max(48)
    .regex(/^[a-zA-Z0-9_.-]+$/)
    .default("default"),
  APP_AUTH_TOKEN: z
    .string()
    .trim()
    .max(128)
    .regex(/^[A-Za-z0-9._~-]*$/, "APP_AUTH_TOKEN must use URL-safe characters")
    .optional(),
  AUTH_MODE: z.enum(["demo", "supabase", "legacy"]).default("demo"),
  AUTH_SESSION_SECRET: z.string().trim().min(32).optional(),
  AUTH_SESSION_TTL_SECONDS: z.coerce.number().int().min(300).max(86_400).default(28_800),
  AUTH_COOKIE_SECURE: booleanEnvironmentValue.default(false),
  ALLOW_INSECURE_DEMO_AUTH: booleanEnvironmentValue.default(false),
  LOCAL_INSECURE_RUNTIME_KEY_PASSTHROUGH: booleanEnvironmentValue.default(false),
  LOCAL_INSECURE_RUNTIME_NETWORK: booleanEnvironmentValue.default(false),
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_PUBLISHABLE_KEY: z.string().trim().min(1).optional(),
  SUPABASE_ANON_KEY: z.string().trim().min(1).optional(),
  SUPABASE_SECRET_KEY: z.string().trim().min(1).optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().trim().min(1).optional(),
  ARK_API_KEY: z.string().optional(),
  ARK_MODEL: z.string().optional(),
  ARK_BASE_URL: z
    .string()
    .url()
    .default("https://ark.cn-beijing.volces.com/api/v3"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export type AppConfig = ReturnType<typeof loadConfig>;

export type CodexExecutableSource = "configured" | "platform-default";

export interface CodexExecutableResolution {
  executable: string;
  source: CodexExecutableSource;
}

export function resolveCodexExecutable(
  configuredValue: string | undefined,
  platform = process.platform,
): CodexExecutableResolution {
  if (!configuredValue) {
    return {
      executable: platform === "win32" ? "codex.cmd" : "codex",
      source: "platform-default",
    };
  }
  return { executable: configuredValue, source: "configured" };
}

export function resolveContainerCodexExecutable(
  configuredValue: string | undefined,
): CodexExecutableResolution {
  const executable = configuredValue || "codex";
  if (/\.cmd$/i.test(executable) || /^[a-z]:[\\/]/i.test(executable) || executable.includes("\\")) {
    throw new Error(
      "CONTAINER_CODEX_BIN must name a Linux executable inside the Runtime image, such as codex. Windows paths and .cmd launchers are not supported.",
    );
  }
  return {
    executable,
    source: configuredValue ? "configured" : "platform-default",
  };
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env) {
  const env = envSchema.parse(environment);
  const codexExecutable = resolveCodexExecutable(env.CODEX_BIN);
  const containerCodexExecutable = resolveContainerCodexExecutable(env.CONTAINER_CODEX_BIN);
  const authToken = env.APP_AUTH_TOKEN?.trim() ?? "";
  const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);
  if (env.NODE_ENV === "production" && !loopbackHosts.has(env.HOST)) {
    if (
      env.AUTH_MODE === "legacy" &&
      (authToken.length < 24 || authToken.startsWith("replace-"))
    ) {
      throw new Error(
        "APP_AUTH_TOKEN must contain at least 24 characters for a non-loopback production server",
      );
    }
    if (env.AUTH_MODE === "demo" && !env.ALLOW_INSECURE_DEMO_AUTH) {
      throw new Error(
        "AUTH_MODE=demo is loopback-only. Use Supabase or explicitly set ALLOW_INSECURE_DEMO_AUTH=true for a disposable demo.",
      );
    }
  }
  const supabaseSecretKey =
    env.SUPABASE_SECRET_KEY?.trim() ?? env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
  const supabasePublicKey =
    env.SUPABASE_PUBLISHABLE_KEY?.trim() ?? env.SUPABASE_ANON_KEY?.trim() ?? "";
  if (env.AUTH_MODE === "supabase") {
    if (!env.SUPABASE_URL || !supabasePublicKey || !supabaseSecretKey) {
      throw new Error(
        "AUTH_MODE=supabase requires SUPABASE_URL, a publishable/anon key, and a secret/service-role key",
      );
    }
  }
  const defaultContainerUser =
    typeof process.getuid === "function" && typeof process.getgid === "function"
      ? process.getuid() + ":" + process.getgid()
      : "1000:1000";
  return {
    host: env.HOST,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    dataDirectory: path.resolve(env.APP_DATA_DIR),
    workspaceRoot: path.resolve(env.AGENT_WORKSPACE_ROOT),
    codexHome: path.resolve(env.CODEX_HOME),
    codexBin: codexExecutable.executable,
    codexBinSource: codexExecutable.source,
    containerCodexBin: containerCodexExecutable.executable,
    containerCodexBinSource: containerCodexExecutable.source,
    codexSandboxMode: env.CODEX_SANDBOX_MODE,
    codexTimeoutMs: env.CODEX_TIMEOUT_MS,
    codexMaxOutputBytes: env.CODEX_MAX_OUTPUT_BYTES,
    runtimeProvider: env.RUNTIME_PROVIDER,
    containerEngine: env.CONTAINER_ENGINE,
    containerRuntimeImage: env.CONTAINER_RUNTIME_IMAGE,
    containerCpuLimit: env.CONTAINER_CPU_LIMIT,
    containerMemoryLimit: env.CONTAINER_MEMORY_LIMIT,
    containerPidsLimit: env.CONTAINER_PIDS_LIMIT,
    containerUser: env.CONTAINER_USER?.trim() || defaultContainerUser,
    runtimeInstanceId: env.RUNTIME_INSTANCE_ID,
    authToken,
    authMode: env.AUTH_MODE,
    authSessionSecret:
      env.AUTH_SESSION_SECRET?.trim() ?? randomBytes(32).toString("base64url"),
    authSessionTtlSeconds: env.AUTH_SESSION_TTL_SECONDS,
    authCookieSecure: env.AUTH_COOKIE_SECURE,
    allowInsecureDemoAuth: env.ALLOW_INSECURE_DEMO_AUTH,
    localInsecureRuntimeKeyPassthrough: env.LOCAL_INSECURE_RUNTIME_KEY_PASSTHROUGH,
    localInsecureRuntimeNetwork: env.LOCAL_INSECURE_RUNTIME_NETWORK,
    supabaseUrl: env.SUPABASE_URL?.replace(/\/+$/, "") ?? "",
    supabasePublicKey,
    supabaseSecretKey,
    arkApiKey: env.ARK_API_KEY?.trim() ?? "",
    arkModel: env.ARK_MODEL?.trim() ?? "",
    arkBaseUrl: env.ARK_BASE_URL.replace(/\/+$/, ""),
    nodeEnv: env.NODE_ENV,
  };
}

export function isArkConfigured(config: AppConfig): boolean {
  return (
    config.arkApiKey.length > 0 &&
    !config.arkApiKey.startsWith("replace-") &&
    config.arkModel.length > 0 &&
    !config.arkModel.includes("replace-")
  );
}

export async function writeCodexConfig(config: AppConfig): Promise<void> {
  await mkdir(config.codexHome, { recursive: true });
  const toml = [
    "# Generated by Volc Agent Launchpad. Edit environment variables, not this file.",
    "model = " + JSON.stringify(config.arkModel || "ep-not-configured"),
    'model_provider = "volcengine_ark"',
    "",
    "[model_providers.volcengine_ark]",
    'name = "Volcengine Ark"',
    "base_url = " + JSON.stringify(config.arkBaseUrl),
    'env_key = "ARK_API_KEY"',
    'wire_api = "responses"',
    "requires_openai_auth = false",
    "",
  ].join("\n");
  await writeFile(path.join(config.codexHome, "config.toml"), toml, {
    encoding: "utf8",
    mode: 0o600,
  });
}

export async function ensureWritableDataDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  const probePath = path.join(
    directory,
    ".agent-trust-gateway-write-probe-" + process.pid + "-" + randomBytes(8).toString("hex"),
  );
  try {
    await writeFile(probePath, "ok\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
  } finally {
    await rm(probePath, { force: true });
  }
}
