import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimeActionFirewall } from "./runtime-action-firewall.js";
import type { SecurityRepository } from "./security-repository.js";
import type { Agent, AuthorizationDecision } from "./types.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

function recordingRepository(decisions: AuthorizationDecision[]): SecurityRepository {
  return {
    initialize: async () => undefined,
    listResources: async () => [],
    readResource: async () => null,
    readResourceForDelegation: async () => null,
    appendDecision: async (decision) => {
      decisions.push(decision);
    },
    appendDecisions: async (next) => {
      decisions.push(...next);
    },
    listDecisions: async () => decisions,
  };
}

async function agentFixture(): Promise<Agent> {
  const root = await mkdtemp(path.join(tmpdir(), "runtime-firewall-"));
  temporaryDirectories.push(root);
  const workspacePath = path.join(root, "workspace");
  await mkdir(path.join(workspacePath, "src"), { recursive: true });
  await writeFile(path.join(workspacePath, "README.md"), "safe\n");
  return {
    id: "11111111-1111-4111-8111-111111111111",
    ownerId: "owner",
    name: "Firewall Agent",
    description: "",
    instructions: "",
    status: "ready",
    workspacePath,
    codexThreadId: null,
    lastError: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

const context = {
  humanUserId: "owner",
  humanEmail: "owner@example.test",
  humanDepartment: "finance" as const,
  requestId: "request-1",
};

describe("RuntimeActionFirewall", () => {
  it("allows safe workspace and shell actions with persisted evidence", async () => {
    const decisions: AuthorizationDecision[] = [];
    const firewall = new RuntimeActionFirewall(recordingRepository(decisions));
    const agent = await agentFixture();

    await expect(
      firewall.authorize(
        agent,
        "Read README.md, write src/output.ts, then run npm test, npm run build, git status, and git diff.",
        context,
      ),
    ).resolves.toBeUndefined();

    expect(decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "file.read", decision: "allow" }),
        expect.objectContaining({ action: "file.write", decision: "allow" }),
        expect.objectContaining({ targetLabel: "npm test", decision: "allow" }),
        expect.objectContaining({ targetLabel: "npm run build", decision: "allow" }),
        expect.objectContaining({ targetLabel: "git status", decision: "allow" }),
        expect.objectContaining({ targetLabel: "git diff", decision: "allow" }),
      ]),
    );
  });

  it("denies protected paths, traversal, commands, and network requests before execution", async () => {
    const cases = [
      ["Read .env.missing", "file.read", "PROTECTED_SECRET_FILE"],
      ["Write ../outside.txt", "file.write", "PATH_OUTSIDE_WORKSPACE"],
      ["Run sudo npm test", "shell.execute", "RUNTIME_COMMAND_DENIED"],
      ["Use curl https://example.test", "network.request", "RUNTIME_NETWORK_DENIED"],
    ] as const;

    for (const [prompt, action, reasonCode] of cases) {
      const decisions: AuthorizationDecision[] = [];
      const firewall = new RuntimeActionFirewall(recordingRepository(decisions));
      const agent = await agentFixture();

      await expect(firewall.authorize(agent, prompt, context)).rejects.toMatchObject({
        statusCode: 403,
        code: "RUNTIME_ACTION_DENIED",
      });
      expect(decisions.at(-1)).toMatchObject({ action, decision: "deny", reasonCode });
    }
  });
});
