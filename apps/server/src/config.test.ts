import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodexRunner } from "./codex-runner.js";
import { ContainerCodexRunner } from "./container-codex-runner.js";
import {
  loadConfig,
  readPinnedCodexVersion,
  resolveCodexExecutable,
  resolveContainerCodexExecutable,
  writeCodexConfig,
} from "./config.js";
import { createRunner } from "./runner-factory.js";

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

describe("Codex executable configuration", () => {
  it("reads the exact Codex version shared by npm and both Docker images", async () => {
    await expect(readPinnedCodexVersion()).resolves.toBe("0.151.0");
  });

  it("uses codex.cmd by default on Windows", () => {
    expect(resolveCodexExecutable(undefined, "win32")).toEqual({
      executable: "codex.cmd",
      source: "platform-default",
    });
  });

  it("uses codex by default on non-Windows platforms", () => {
    expect(resolveCodexExecutable(undefined, "linux")).toEqual({
      executable: "codex",
      source: "platform-default",
    });
  });

  it("uses CODEX_BIN exactly when it overrides the platform default", () => {
    const executable = "custom-codex-command";
    expect(resolveCodexExecutable(executable, "win32")).toEqual({
      executable,
      source: "configured",
    });

    const config = loadConfig({ NODE_ENV: "test", CODEX_BIN: executable });
    expect(config.codexBin).toBe(executable);
    expect(config.codexBinSource).toBe("configured");
  });

  it("keeps a Windows local executable out of the container Runtime", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      RUNTIME_PROVIDER: "container",
      CODEX_BIN: "codex.cmd",
    });

    expect(config.codexBin).toBe("codex.cmd");
    expect(config.containerCodexBin).toBe("codex");
    expect(resolveContainerCodexExecutable("codex")).toMatchObject({
      executable: "codex",
    });
  });

  it("rejects Windows launchers for the Linux container Runtime", () => {
    expect(() => resolveContainerCodexExecutable("codex.cmd")).toThrow(
      "CONTAINER_CODEX_BIN must name a Linux executable",
    );
    expect(() => resolveContainerCodexExecutable("D:\\host\\codex.cmd")).toThrow(
      "CONTAINER_CODEX_BIN must name a Linux executable",
    );
  });

  it("keeps Ark Runtime credential passthrough disabled unless explicitly enabled", () => {
    expect(loadConfig({ NODE_ENV: "test" }).localInsecureRuntimeKeyPassthrough).toBe(
      false,
    );
    expect(
      loadConfig({
        NODE_ENV: "test",
        LOCAL_INSECURE_RUNTIME_KEY_PASSTHROUGH: "true",
      }).localInsecureRuntimeKeyPassthrough,
    ).toBe(true);
    expect(() =>
      loadConfig({
        NODE_ENV: "test",
        LOCAL_INSECURE_RUNTIME_KEY_PASSTHROUGH: "yes",
      }),
    ).toThrow();
  });

  it("keeps direct Runtime networking disabled unless explicitly enabled", () => {
    expect(loadConfig({ NODE_ENV: "test" }).localInsecureRuntimeNetwork).toBe(false);
    expect(
      loadConfig({
        NODE_ENV: "test",
        LOCAL_INSECURE_RUNTIME_NETWORK: "true",
      }).localInsecureRuntimeNetwork,
    ).toBe(true);
  });

  it("rejects local Runtime escape hatches in production", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        LOCAL_INSECURE_RUNTIME_KEY_PASSTHROUGH: "true",
      }),
    ).toThrow("loopback local-POC escape hatches");
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        LOCAL_INSECURE_RUNTIME_NETWORK: "true",
      }),
    ).toThrow("loopback local-POC escape hatches");
  });

  it("allows explicit Ark access only for the loopback disposable-container POC", () => {
    const config = loadConfig({
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      RUNTIME_PROVIDER: "container",
      LOCAL_POC_MODE: "true",
      LOCAL_INSECURE_RUNTIME_KEY_PASSTHROUGH: "true",
      LOCAL_INSECURE_RUNTIME_NETWORK: "true",
    });

    expect(config.localPocMode).toBe(true);
    expect(config.localInsecureRuntimeKeyPassthrough).toBe(true);
    expect(config.localInsecureRuntimeNetwork).toBe(true);
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        HOST: "0.0.0.0",
        RUNTIME_PROVIDER: "container",
        LOCAL_POC_MODE: "true",
      }),
    ).toThrow("LOCAL_POC_MODE requires a loopback HOST");
  });
});

describe("Runtime provider selection", () => {
  it("keeps host processes out of production while supporting the application image", () => {
    expect(() =>
      createRunner(loadConfig({
        NODE_ENV: "production",
        HOST: "127.0.0.1",
        RUNTIME_PROVIDER: "local-process",
      })),
    ).toThrow("not permitted");
    expect(
      createRunner(
        loadConfig({
          NODE_ENV: "production",
          HOST: "127.0.0.1",
          RUNTIME_PROVIDER: "application-container",
        }),
      ),
    ).toBeInstanceOf(CodexRunner);
    expect(
      createRunner(loadConfig({ NODE_ENV: "test", RUNTIME_PROVIDER: "container" })),
    ).toBeInstanceOf(ContainerCodexRunner);
  });
});
