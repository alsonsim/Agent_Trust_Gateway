import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, writeCodexConfig } from "./config.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("generated Codex configuration", () => {
  it("strips secret variables from tool subprocesses and disables sandbox egress", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-codex-config-"));
    temporaryDirectories.push(root);
    const config = loadConfig({
      NODE_ENV: "test",
      CODEX_HOME: path.join(root, "codex-home"),
      ARK_API_KEY: "provider-secret-key-123456",
      ARK_MODEL: "ep-test",
    });

    await writeCodexConfig(config);
    const generated = await readFile(
      path.join(config.codexHome, "config.toml"),
      "utf8",
    );

    expect(generated).toContain("[shell_environment_policy]");
    expect(generated).toContain('inherit = "core"');
    expect(generated).toContain("ignore_default_excludes = false");
    expect(generated).toContain("[sandbox_workspace_write]");
    expect(generated).toContain("network_access = false");
    expect(generated).not.toContain(config.arkApiKey);
  });
});
