import type { AppConfig } from "./config.js";
import { ContainerCodexRunner } from "./container-codex-runner.js";
import { CodexRunner } from "./codex-runner.js";
import type { AgentRunner } from "./types.js";

export function createRunner(config: AppConfig): AgentRunner {
  if (config.runtimeProvider === "local-process" && config.nodeEnv === "production") {
    throw new Error(
      "RUNTIME_PROVIDER=local-process is not permitted for production department workspaces. Use the isolated container Runtime.",
    );
  }
  return config.runtimeProvider === "container"
    ? new ContainerCodexRunner(config)
    : new CodexRunner(config);
}
