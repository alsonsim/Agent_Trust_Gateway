import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DelegatedCodexHomeManager } from "./delegated-codex-home.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function makeHarness(): Promise<{
  root: string;
  dataDirectory: string;
  sourceCodexHome: string;
  manager: DelegatedCodexHomeManager;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "delegated-codex-home-test-"));
  temporaryDirectories.push(root);
  const dataDirectory = path.join(root, "data");
  const sourceCodexHome = path.join(root, "source-codex-home");
  await mkdir(sourceCodexHome, { recursive: true });
  const manager = new DelegatedCodexHomeManager(dataDirectory, sourceCodexHome);
  await manager.initialize();
  return { root, dataDirectory, sourceCodexHome, manager };
}

describe("delegated Codex homes", () => {
  it("copies only the runtime configuration allowlist", async () => {
    const { sourceCodexHome, manager } = await makeHarness();
    await mkdir(path.join(sourceCodexHome, "execpolicy"));
    await mkdir(path.join(sourceCodexHome, "sessions"));
    await writeFile(path.join(sourceCodexHome, "config.toml"), "model = 'safe'\n");
    await writeFile(
      path.join(sourceCodexHome, "execpolicy", "runtime-action-firewall.rules"),
      "deny dangerous-action\n",
    );
    await writeFile(
      path.join(sourceCodexHome, "sessions", "private-session.json"),
      "PRIVATE_SESSION_SENTINEL",
    );
    await writeFile(path.join(sourceCodexHome, "auth.json"), "PRIVATE_AUTH_SENTINEL");
    await writeFile(path.join(sourceCodexHome, "history.jsonl"), "PRIVATE_HISTORY");

    const home = await manager.create("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");

    expect((await readdir(home)).sort()).toEqual(["config.toml", "execpolicy"]);
    expect(await readdir(path.join(home, "execpolicy"))).toEqual([
      "runtime-action-firewall.rules",
    ]);
    expect(await readFile(path.join(home, "config.toml"), "utf8")).toBe(
      "model = 'safe'\n",
    );
    expect(
      await readFile(
        path.join(home, "execpolicy", "runtime-action-firewall.rules"),
        "utf8",
      ),
    ).toBe("deny dangerous-action\n");
    await expect(access(path.join(home, "sessions"))).rejects.toThrow();
    await expect(access(path.join(home, "auth.json"))).rejects.toThrow();
    if (process.platform !== "win32") {
      expect((await stat(home)).mode & 0o777).toBe(0o700);
      expect((await stat(path.join(home, "config.toml"))).mode & 0o777).toBe(0o600);
    }
  });

  it("creates an empty isolated home when optional allowlisted files are absent", async () => {
    const { manager } = await makeHarness();

    const home = await manager.create("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");

    expect(await readdir(home)).toEqual([]);
  });

  it("removes only a validated generated direct child, idempotently", async () => {
    const { root, dataDirectory, manager } = await makeHarness();
    const home = await manager.create("cccccccc-cccc-4ccc-8ccc-cccccccccccc");
    const managedRoot = path.join(dataDirectory, "delegated-codex-homes");
    const protectedFile = path.join(root, "keep.txt");
    await writeFile(protectedFile, "keep");

    await expect(manager.cleanup(managedRoot)).rejects.toThrow("direct children");
    await expect(manager.cleanup(protectedFile)).rejects.toThrow("direct children");
    await expect(manager.cleanup(path.join(home, "config.toml"))).rejects.toThrow(
      "direct children",
    );
    await expect(
      manager.cleanup(home + path.sep + ".." + path.sep + path.basename(home)),
    ).rejects.toThrow("direct children");

    await manager.cleanup(home);
    await manager.cleanup(home);
    await expect(access(home)).rejects.toThrow();
    expect(await readFile(protectedFile, "utf8")).toBe("keep");
  });

  it("rejects unsafe Run IDs before creating a home", async () => {
    const { root, manager } = await makeHarness();

    await expect(manager.create("../outside-home")).rejects.toThrow("safe path segment");
    await expect(access(path.join(root, "outside-home"))).rejects.toThrow();
  });

  it("preserves stale generated homes until container removal is verified", async () => {
    const { dataDirectory, sourceCodexHome, manager } = await makeHarness();
    const staleHome = await manager.create("dddddddd-dddd-4ddd-8ddd-dddddddddddd");
    const managedRoot = path.join(dataDirectory, "delegated-codex-homes");
    const unknownEntry = path.join(managedRoot, "operator-note.txt");
    await writeFile(unknownEntry, "preserve");

    const restarted = new DelegatedCodexHomeManager(dataDirectory, sourceCodexHome);
    await restarted.initialize();

    expect((await stat(staleHome)).isDirectory()).toBe(true);
    expect(await readFile(unknownEntry, "utf8")).toBe("preserve");
  });

  it("sweeps only validated stale delegated Codex home directories", async () => {
    const { dataDirectory, manager } = await makeHarness();
    const firstHome = await manager.create("abababab-abab-4aba-8aba-abababababab");
    const secondHome = await manager.create("bcbcbcbc-bcbc-4bcb-8bcb-bcbcbcbcbcbc");
    const managedRoot = path.join(dataDirectory, "delegated-codex-homes");
    const operatorNote = path.join(managedRoot, "operator-note.txt");
    const operatorDirectory = path.join(managedRoot, "operator-files");
    await writeFile(operatorNote, "preserve", "utf8");
    await mkdir(operatorDirectory);

    await manager.cleanupStale();

    await expect(access(firstHome)).rejects.toThrow();
    await expect(access(secondHome)).rejects.toThrow();
    expect(await readFile(operatorNote, "utf8")).toBe("preserve");
    expect((await lstat(operatorDirectory)).isDirectory()).toBe(true);
    await expect(manager.cleanupStale()).resolves.toBeUndefined();
  });

  it("rejects unsafe managed residue while attempting every eligible home", async () => {
    const { root, dataDirectory, manager } = await makeHarness();
    const firstHome = await manager.create("cdcdcdcd-cdcd-4cdc-8dcd-cdcdcdcdcdcd");
    const secondHome = await manager.create("dededede-dede-4ded-8ded-dededededede");
    const managedRoot = path.join(dataDirectory, "delegated-codex-homes");
    const protectedTarget = path.join(root, "protected-home-target");
    const symlinkEntry = path.join(managedRoot, "run-symlink-residue");
    const fileEntry = path.join(managedRoot, "run-file-residue");
    const invalidNameEntry = path.join(managedRoot, "run-unsafe name");
    await mkdir(protectedTarget);
    await writeFile(path.join(protectedTarget, "keep.txt"), "keep", "utf8");
    await symlink(protectedTarget, symlinkEntry);
    await writeFile(fileEntry, "preserve", "utf8");
    await mkdir(invalidNameEntry);

    let failure: unknown;
    try {
      await manager.cleanupStale();
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    const errors = (failure as AggregateError).errors;
    expect(errors).toHaveLength(3);
    expect(errors.map(String).join("\n")).toContain("unsafe managed");
    expect(errors.map(String).join("\n")).toContain("real directory");
    await expect(access(firstHome)).rejects.toThrow();
    await expect(access(secondHome)).rejects.toThrow();
    expect((await lstat(symlinkEntry)).isSymbolicLink()).toBe(true);
    expect(await readFile(fileEntry, "utf8")).toBe("preserve");
    expect((await lstat(invalidNameEntry)).isDirectory()).toBe(true);
    expect(await readFile(path.join(protectedTarget, "keep.txt"), "utf8")).toBe(
      "keep",
    );
  });

  it("refuses to copy a symlink masquerading as an allowed configuration file", async () => {
    const { root, sourceCodexHome, manager } = await makeHarness();
    const privateFile = path.join(root, "private-session-data");
    await writeFile(privateFile, "PRIVATE_SESSION_SENTINEL");
    await symlink(privateFile, path.join(sourceCodexHome, "config.toml"));

    await expect(
      manager.create("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"),
    ).rejects.toThrow();
    await expect(
      access(
        path.join(
          root,
          "data",
          "delegated-codex-homes",
          "run-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        ),
      ),
    ).rejects.toThrow();
    expect(await readFile(privateFile, "utf8")).toBe("PRIVATE_SESSION_SENTINEL");
  });
});
