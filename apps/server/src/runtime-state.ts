import { createHash } from "node:crypto";
import { copyFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "./config.js";
import type { RunnerRequest } from "./types.js";

export function runtimeStateKey(request: RunnerRequest): string {
  const candidate = request.workspaceProfileId || request.agentId;
  if (/^[A-Za-z0-9_.-]{1,160}$/.test(candidate)) return candidate;
  return "state-" + createHash("sha256").update(candidate, "utf8").digest("hex");
}

export function scopedCodexHome(config: AppConfig, stateKey: string): string {
  return path.join(config.dataDirectory, "runtime-codex-homes", stateKey);
}

export async function prepareScopedCodexHome(
  config: AppConfig,
  stateKey: string,
): Promise<string> {
  const destination = scopedCodexHome(config, stateKey);
  await mkdir(destination, { recursive: true });
  for (const relativePath of ["config.toml", "execpolicy/runtime-action-firewall.rules"]) {
    const sourcePath = path.join(config.codexHome, relativePath);
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
  return destination;
}
