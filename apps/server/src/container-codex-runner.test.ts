import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "./config.js";
import {
  buildContainerRunArgs,
  containerName,
  createWorkspaceProjection,
} from "./container-codex-runner.js";

describe("Container Codex runner", () => {
  it("builds an isolated Docker/Podman-compatible invocation", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      ARK_API_KEY: "secret-that-must-not-appear-in-argv",
      ARK_MODEL: "ep-test",
      CODEX_HOME: "/tmp/codex-home",
      RUNTIME_PROVIDER: "container",
      CONTAINER_ENGINE: "podman",
      CONTAINER_RUNTIME_IMAGE: "runtime:test",
      CODEX_BIN: "codex.cmd",
      CONTAINER_CODEX_BIN: "codex-runtime-command",
      CONTAINER_USER: "501:20",
      RUNTIME_INSTANCE_ID: "test-instance",
    });
    const args = buildContainerRunArgs(
      {
        agentId: "agent/unsafe",
        workspacePath: "/tmp/agent-workspace",
        prompt: "write a small program",
        threadId: null,
      },
      config,
    );

    expect(containerName("agent/unsafe", "test-instance")).toBe(
      "launchpad-test-instance-agent-unsafe",
    );
    expect(args).toContain("runtime:test");
    expect(args).toContain("codex-runtime-command");
    expect(args).not.toContain("codex.cmd");
    expect(args).toContain("type=bind,src=/tmp/agent-workspace,dst=/workspace");
    expect(args).toContain(
      "type=bind,src=" + config.codexHome + ",dst=/codex-home",
    );
    expect(args).toContain("501:20");
    expect(args).toContain("workspace-write");
    expect(args).toContain("/workspace");
    expect(args).toContain("io.codejam.instance-id=test-instance");
    expect(args).toContain("keep-id");
    expect(args).not.toContain("secret-that-must-not-appear-in-argv");
    expect(args).not.toContain("ARK_API_KEY");
    expect(args).toContain("none");
    expect(args).toContain("--read-only");
  });

  it("does not pass the host workspace path into the Runtime projection contract", () => {
    const config = loadConfig({ NODE_ENV: "test", CODEX_HOME: "/tmp/codex-home", RUNTIME_PROVIDER: "container" });
    const args = buildContainerRunArgs({ agentId: "agent", workspacePath: "/safe/projection", prompt: "continue", threadId: null }, config);
    expect(args).toContain("type=bind,src=/safe/projection,dst=/workspace");
    expect(args).not.toContain(".env");
  });

  it("projects README.md but excludes protected workspace files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "launchpad-projection-"));
    const source = path.join(root, "workspace");
    const projection = path.join(root, "projection");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "README.md"), "safe");
    await writeFile(path.join(source, ".env"), "SECRET=must-not-mount");

    await createWorkspaceProjection(source, projection);

    await expect(readFile(path.join(projection, "README.md"), "utf8")).resolves.toBe("safe");
    await expect(readFile(path.join(projection, ".env"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("resumes a thread inside the mounted Runtime workspace", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      CODEX_HOME: "/tmp/codex-home",
      RUNTIME_PROVIDER: "container",
    });
    const args = buildContainerRunArgs(
      {
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        prompt: "continue",
        threadId: "thread-123",
      },
      config,
    );
    expect(args.slice(-3)).toEqual(["resume", "thread-123", "continue"]);
    expect(args).not.toContain("keep-id");
  });
});
