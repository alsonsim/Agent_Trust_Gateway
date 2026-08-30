import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const childProcessMocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("node:child_process", () => childProcessMocks);

import { loadConfig } from "./config.js";
import {
  buildContainerCliEnvironment,
  buildContainerRunArgs,
  ContainerCodexRunner,
  ContainerRemovalUnverifiedError,
  containerName,
  createWorkspaceProjection,
} from "./container-codex-runner.js";

function missingContainerError(): Error & { stderr: string } {
  return Object.assign(new Error("No such container"), {
    stderr: "Error: No such container: delegated-test",
  });
}

function makeChild(): ChildProcess {
  return Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  }) as unknown as ChildProcess;
}

function runnerConfig() {
  return loadConfig({
    NODE_ENV: "test",
    ARK_API_KEY: "test-provider-key",
    ARK_MODEL: "ep-test",
    CODEX_HOME: "/tmp/codex-home",
    RUNTIME_PROVIDER: "container",
    CONTAINER_ENGINE: "docker",
    CONTAINER_RUNTIME_IMAGE: "runtime:test",
    RUNTIME_INSTANCE_ID: "settlement-test",
  });
}

const runnerRequest = {
  agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  workspaceProfileId: "department-frontend",
  workspacePath: "/tmp/delegated-workspace",
  prompt: "complete the approved task",
  threadId: null,
  codexHome: "/tmp/delegated-codex-home",
} as const;

beforeEach(() => {
  childProcessMocks.execFile.mockReset();
  childProcessMocks.spawn.mockReset();
  childProcessMocks.execFile.mockImplementation(
    (
      _file: string,
      args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout?: string, stderr?: string) => void,
    ) => {
      if (args[0] === "inspect") {
        callback(missingContainerError());
        return;
      }
      callback(null, "", "");
    },
  );
});

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
        workspaceProfileId: "department-frontend",
        workspacePath: "/tmp/agent-workspace",
        prompt: "write a small program",
        threadId: null,
        codexHome: "/tmp/delegated-codex-home",
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
      "type=bind,src=/tmp/delegated-codex-home,dst=/codex-home",
    );
    expect(args).not.toContain(
      "type=bind,src=" + config.codexHome + ",dst=/codex-home",
    );
    expect(args).toContain("501:20");
    expect(args).toContain("workspace-write");
    expect(args).toContain("/workspace");
    expect(args).toContain("io.codejam.instance-id=test-instance");
    expect(args).toContain("keep-id");
    expect(args.join(" ")).not.toContain("secret-that-must-not-appear-in-argv");
    expect(args).not.toContain("ARK_API_KEY");
    expect(args).not.toContain("ARK_MODEL");
    expect(args.join(" ")).not.toContain("ep-test");
    expect(args).toContain("none");
    expect(args).toContain("--read-only");
    const environment = buildContainerCliEnvironment(config, false);
    expect(environment.ARK_API_KEY).toBeUndefined();
    expect(environment.ARK_MODEL).toBeUndefined();
  });

  it("forwards Ark environment names only when the insecure local passthrough is enabled", () => {
    const secret = "secret-that-must-stay-out-of-docker-argv";
    const model = "ep-secret-model-id";
    const config = loadConfig({
      NODE_ENV: "test",
      ARK_API_KEY: secret,
      ARK_MODEL: model,
      CODEX_HOME: "/tmp/codex-home",
      RUNTIME_PROVIDER: "container",
      CONTAINER_ENGINE: "docker",
      CONTAINER_RUNTIME_IMAGE: "runtime:test",
      LOCAL_INSECURE_RUNTIME_KEY_PASSTHROUGH: "true",
    });
    const args = buildContainerRunArgs(
      {
        agentId: "agent",
        workspaceProfileId: "department-frontend",
        workspacePath: "/tmp/agent-workspace",
        prompt: "write a small program",
        threadId: null,
      },
      config,
    );

    expect(args).toContain("ARK_API_KEY");
    expect(args).toContain("ARK_MODEL");
    expect(args.join(" ")).not.toContain(secret);
    expect(args.join(" ")).not.toContain(model);
    expect(args.join(" ")).not.toContain("ARK_API_KEY=" + secret);
    expect(args.join(" ")).not.toContain("ARK_MODEL=" + model);

    const environment = buildContainerCliEnvironment(
      config,
      config.localInsecureRuntimeKeyPassthrough,
    );
    expect(environment.ARK_API_KEY).toBe(secret);
    expect(environment.ARK_MODEL).toBe(model);
  });

  it("does not pass the host workspace path into the Runtime projection contract", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      CODEX_HOME: "/tmp/codex-home",
      RUNTIME_PROVIDER: "container",
    });
    const args = buildContainerRunArgs(
      {
        agentId: "agent",
        workspaceProfileId: "department-frontend",
        workspacePath: "/safe/projection",
        prompt: "continue",
        threadId: null,
      },
      config,
    );
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

    await expect(readFile(path.join(projection, "README.md"), "utf8")).resolves.toBe(
      "safe",
    );
    await expect(
      readFile(path.join(projection, ".env"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
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
        workspaceProfileId: "department-frontend",
        workspacePath: "/tmp/workspace",
        prompt: "continue",
        threadId: "thread-123",
      },
      config,
    );
    expect(args.slice(-3)).toEqual(["resume", "thread-123", "continue"]);
    expect(args).not.toContain("keep-id");
    expect(args).toContain(
      "type=bind,src=" + config.codexHome + ",dst=/codex-home",
    );
  });

  it("rejects a relative per-Run Codex home before invoking the container engine", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      CODEX_HOME: "/tmp/codex-home",
      RUNTIME_PROVIDER: "container",
    });

    expect(() =>
      buildContainerRunArgs(
        {
          agentId: "agent",
          workspaceProfileId: "department-frontend",
          workspacePath: "/tmp/workspace",
          prompt: "run once",
          threadId: null,
          codexHome: "relative/home",
        },
        config,
      ),
    ).toThrow("absolute path");
  });

  it.each([
    { name: "successful completion", settlement: "success" as const },
    { name: "a child-process error", settlement: "error" as const },
    { name: "a non-zero exit", settlement: "nonzero" as const },
  ])("force-removes and inspects after $name", async ({ settlement }) => {
    const child = makeChild();
    childProcessMocks.spawn.mockReturnValue(child);
    const runner = new ContainerCodexRunner(runnerConfig());
    const result = runner.run(runnerRequest);

    queueMicrotask(() => {
      if (settlement === "success") {
        child.stdout!.write(
          JSON.stringify({
            type: "item.completed",
            item: { type: "agent_message", text: "approved result" },
          }) + "\n",
        );
        child.emit("close", 0);
      } else if (settlement === "error") {
        child.emit("error", new Error("container client failed"));
      } else {
        child.stderr!.write("runtime failure");
        child.emit("close", 17);
      }
    });

    if (settlement === "success") {
      await expect(result).resolves.toMatchObject({ output: "approved result" });
    } else if (settlement === "error") {
      await expect(result).rejects.toThrow("container client failed");
    } else {
      await expect(result).rejects.toThrow("Runtime exited with code 17");
    }

    const lifecycleArguments = childProcessMocks.execFile.mock.calls.map(
      (call) => call[1],
    );
    const expectedName = containerName(runnerRequest.agentId, "settlement-test");
    expect(lifecycleArguments).toContainEqual(["rm", "--force", expectedName]);
    expect(lifecycleArguments).toContainEqual(["inspect", expectedName]);
  });

  it("surfaces an unverified removal instead of reporting a settled Run", async () => {
    const child = makeChild();
    childProcessMocks.spawn.mockReturnValue(child);
    childProcessMocks.execFile.mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout?: string, stderr?: string) => void,
      ) => callback(null, "", ""),
    );
    const runner = new ContainerCodexRunner(runnerConfig());
    const result = runner.run(runnerRequest);

    queueMicrotask(() => {
      child.stdout!.write(
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "must not escape" },
        }) + "\n",
      );
      child.emit("close", 0);
    });

    await expect(result).rejects.toBeInstanceOf(ContainerRemovalUnverifiedError);
  });

  it("removes and verifies every labeled stale container before recovery", async () => {
    const staleIds = ["a".repeat(64), "b".repeat(64)];
    childProcessMocks.execFile.mockImplementation(
      (
        _file: string,
        args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout?: string, stderr?: string) => void,
      ) => {
        if (args[0] === "ps") {
          callback(null, staleIds.join("\n") + "\n", "");
          return;
        }
        if (args[0] === "inspect") {
          callback(missingContainerError());
          return;
        }
        callback(null, "", "");
      },
    );
    const runner = new ContainerCodexRunner(runnerConfig());

    await runner.removeStaleContainers();

    const lifecycleArguments = childProcessMocks.execFile.mock.calls.map(
      (call) => call[1],
    );
    expect(lifecycleArguments[0]).toEqual([
      "ps",
      "--all",
      "--quiet",
      "--filter",
      "label=io.codejam.launchpad=agent-runtime",
      "--filter",
      "label=io.codejam.instance-id=settlement-test",
    ]);
    for (const staleId of staleIds) {
      expect(lifecycleArguments).toContainEqual(["rm", "--force", staleId]);
      expect(lifecycleArguments).toContainEqual(["inspect", staleId]);
    }
  });
});
