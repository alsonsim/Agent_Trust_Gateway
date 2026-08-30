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
  await Promise.all(
    ["src", "test", "reports"].map((directory) =>
      mkdir(path.join(workspacePath, directory), { recursive: true }),
    ),
  );
  await writeFile(path.join(workspacePath, "README.md"), "safe\n");
  return {
    id: "11111111-1111-4111-8111-111111111111",
    ownerId: "owner",
    name: "Firewall Agent",
    description: "",
    instructions: "",
    status: "ready",
    revokedAt: null,
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
  humanDepartment: "frontend" as const,
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

  it.each([
    [
      "frontend",
      "Read README.md, then create package.json for node --test, create src/profile-view.js for an accessible Profile UI, and create test/profile-view.test.js. Run npm test; use no packages or network.",
      ["README.md", "package.json", "src/profile-view.js", "test/profile-view.test.js"],
    ],
    [
      "backend",
      "Read README.md, then create package.json for node --test, create src/profile-handler.js for validated GET /api/profile responses with id, displayName, biography, team, avatarUrl, and updatedAt, and create test/profile-handler.test.js. Run npm test; use only Node built-ins and no network.",
      ["README.md", "package.json", "src/profile-handler.js", "test/profile-handler.test.js"],
    ],
    [
      "qa",
      "Read README.md, then create package.json for node --test, create test/profile-release.test.js for the UI and API contract, and create reports/profile-release-summary.md. Run npm test; use only Node built-ins and no network.",
      [
        "README.md",
        "package.json",
        "test/profile-release.test.js",
        "reports/profile-release-summary.md",
      ],
    ],
  ] as const)(
    "allows the representative %s starter prompt",
    async (_department, prompt, fileTargets) => {
      const decisions: AuthorizationDecision[] = [];
      const firewall = new RuntimeActionFirewall(recordingRepository(decisions));
      const agent = await agentFixture();

      await expect(firewall.authorize(agent, prompt, context)).resolves.toBeUndefined();

      expect(decisions).toHaveLength(fileTargets.length + 1);
      expect(decisions[0]).toMatchObject({
        action: "file.read",
        targetLabel: fileTargets[0],
        decision: "allow",
      });
      for (const targetLabel of fileTargets.slice(1)) {
        expect(decisions).toContainEqual(
          expect.objectContaining({
            action: "file.write",
            targetLabel,
            decision: "allow",
          }),
        );
      }
      expect(decisions.at(-1)).toMatchObject({
        action: "shell.execute",
        targetLabel: "npm test",
        decision: "allow",
      });
    },
  );

  it("denies protected paths, traversal, commands, and network requests before execution", async () => {
    const cases = [
      ["Read .env.missing", "file.read", "PROTECTED_SECRET_FILE"],
      ["Read ..", "file.read", "PATH_OUTSIDE_WORKSPACE"],
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

  it("normalizes direct shell evaluation before denying dangerous commands", async () => {
    const decisions: AuthorizationDecision[] = [];
    const firewall = new RuntimeActionFirewall(recordingRepository(decisions));
    const agent = await agentFixture();

    await expect(
      firewall.evaluateShell(
        agent,
        "Please execute:\n```bash\nrm -rf ./demo-folder\n```",
        context,
      ),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: "RUNTIME_ACTION_DENIED",
      details: expect.objectContaining({
        action: "shell.execute",
        decision: "deny",
        reasonCode: "RUNTIME_COMMAND_DENIED",
      }),
    });
    expect(decisions).toEqual([
      expect.objectContaining({
        targetLabel: "rm -rf",
        decision: "deny",
        reasonCode: "RUNTIME_COMMAND_DENIED",
      }),
    ]);
  });
});
