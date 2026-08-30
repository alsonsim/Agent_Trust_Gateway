import { describe, expect, it } from "vitest";
import {
  buildCodexArgs,
  buildCodexChildEnvironment,
  buildWindowsCmdCommand,
  parseCodexEventLine,
} from "./codex-runner.js";
import { loadConfig } from "./config.js";
import { scopedCodexHome } from "./runtime-state.js";
import { runtimeWorkspaceStateId } from "./workspace.js";

describe("Codex runner protocol", () => {
  it("builds a new-session invocation", () => {
    const args = buildCodexArgs(
      {
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        prompt: "build a calculator",
        threadId: null,
      },
      "workspace-write",
    );
    expect(args).toEqual([
      "exec",
      "--json",
      "--sandbox",
      "workspace-write",
      "--skip-git-repo-check",
      "-C",
      "/tmp/workspace",
      "build a calculator",
    ]);
  });

  it("resumes a stored Codex thread", () => {
    const args = buildCodexArgs(
      {
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        prompt: "add tests",
        threadId: "thread-123",
      },
      "workspace-write",
    );
    expect(args.slice(-3)).toEqual(["resume", "thread-123", "add tests"]);
  });

  it("extracts the session, final message and usage", () => {
    const parsed = {
      messages: [] as string[],
      threadId: null as string | null,
      usage: null as {
        inputTokens?: number;
        cachedInputTokens?: number;
        outputTokens?: number;
      } | null,
      errors: [] as string[],
    };
    parseCodexEventLine(
      JSON.stringify({ type: "thread.started", thread_id: "thread-123" }),
      parsed,
    );
    parseCodexEventLine(
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "Done." },
      }),
      parsed,
    );
    parseCodexEventLine(
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 10, output_tokens: 4 },
      }),
      parsed,
    );
    expect(parsed.threadId).toBe("thread-123");
    expect(parsed.messages).toEqual(["Done."]);
    expect(parsed.usage).toEqual({ inputTokens: 10, outputTokens: 4 });
  });

  it("quotes Windows .cmd arguments before invoking the command shell", () => {
    const command = buildWindowsCmdCommand("codex.cmd", [
      "exec",
      "message with & a percent % and a quote \"",
    ]);

    expect(command).toContain('"codex.cmd"');
    expect(command).toContain("^&");
    expect(command).toContain("%%");
    expect(command).toContain('^"');
  });

  it("uses distinct local Codex homes for distinct owners in the same role", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: "C:/tmp/agent-gateway-data",
      ARK_API_KEY: "test-key",
    });
    const firstState = runtimeWorkspaceStateId(
      "frontend",
      "11111111-1111-4111-8111-111111111111",
    );
    const secondState = runtimeWorkspaceStateId(
      "frontend",
      "44444444-4444-4444-8444-444444444444",
    );
    const firstHome = scopedCodexHome(config, firstState);
    const secondHome = scopedCodexHome(config, secondState);
    const firstEnvironment = buildCodexChildEnvironment(config, firstHome, {
      PATH: "C:/Windows/System32",
    });
    const secondEnvironment = buildCodexChildEnvironment(config, secondHome, {
      PATH: "C:/Windows/System32",
    });

    expect(firstState).not.toBe(secondState);
    expect(firstEnvironment.CODEX_HOME).toBe(firstHome);
    expect(secondEnvironment.CODEX_HOME).toBe(secondHome);
    expect(firstEnvironment.CODEX_HOME).not.toBe(secondEnvironment.CODEX_HOME);
    expect(firstEnvironment.ARK_API_KEY).toBe("test-key");
  });
});
