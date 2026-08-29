import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateWorkspaceFileRead } from "./workspace-file-policy.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function workspaceFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "workspace-file-policy-"));
  temporaryDirectories.push(root);
  const workspace = path.join(root, "agent-workspace");
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await writeFile(path.join(workspace, "src", "app.ts"), "export const ok = true;\n");
  await writeFile(path.join(workspace, ".env"), "API_KEY=must-not-leak\n");
  await writeFile(path.join(root, "outside.txt"), "outside\n");
  return { root, workspace };
}

describe("workspace file policy", () => {
  it("allows an ordinary file inside the assigned workspace", async () => {
    const { workspace } = await workspaceFixture();

    await expect(evaluateWorkspaceFileRead(workspace, "src/app.ts")).resolves.toMatchObject({
      allowed: true,
      reasonCode: "WORKSPACE_PATH_ALLOWED",
      targetLabel: "src/app.ts",
    });
  });

  it("denies .env files", async () => {
    const { workspace } = await workspaceFixture();

    await expect(evaluateWorkspaceFileRead(workspace, ".env")).resolves.toMatchObject({
      allowed: false,
      reasonCode: "PROTECTED_SECRET_FILE",
    });
  });

  it("denies a nonexistent protected-looking path before filesystem resolution", async () => {
    const { workspace } = await workspaceFixture();

    await expect(evaluateWorkspaceFileRead(workspace, ".env.missing")).resolves.toMatchObject({
      allowed: false,
      reasonCode: "PROTECTED_SECRET_FILE",
    });
  });

  it("denies traversal outside the workspace", async () => {
    const { workspace } = await workspaceFixture();

    await expect(
      evaluateWorkspaceFileRead(workspace, "../outside.txt"),
    ).resolves.toMatchObject({
      allowed: false,
      reasonCode: "PATH_OUTSIDE_WORKSPACE",
    });
  });

  it.skipIf(process.platform === "win32")(
    "denies a symlink that resolves to a protected file",
    async () => {
      const { workspace } = await workspaceFixture();
      await symlink(path.join(workspace, ".env"), path.join(workspace, "src", "config.txt"));

      await expect(
        evaluateWorkspaceFileRead(workspace, "src/config.txt"),
      ).resolves.toMatchObject({
        allowed: false,
        reasonCode: "PROTECTED_SECRET_FILE",
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "denies a symlink that escapes the workspace",
    async () => {
      const { root, workspace } = await workspaceFixture();
      await symlink(path.join(root, "outside.txt"), path.join(workspace, "src", "outside.txt"));

      await expect(
        evaluateWorkspaceFileRead(workspace, "src/outside.txt"),
      ).resolves.toMatchObject({
        allowed: false,
        reasonCode: "PATH_OUTSIDE_WORKSPACE",
      });
    },
  );

  it("denies files larger than 256 KiB", async () => {
    const { workspace } = await workspaceFixture();
    await writeFile(path.join(workspace, "large.txt"), Buffer.alloc(256 * 1024 + 1));

    await expect(evaluateWorkspaceFileRead(workspace, "large.txt")).resolves.toMatchObject({
      allowed: false,
      reasonCode: "FILE_TOO_LARGE",
    });
  });
});
