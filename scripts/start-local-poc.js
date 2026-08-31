import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(
  new URL("./start-local-poc.sh", import.meta.url),
);
const repositoryRoot = dirname(dirname(scriptPath));

function findWindowsBash() {
  const candidates = [];
  const configuredBash = process.env.LOCAL_POC_BASH?.trim();
  if (configuredBash) candidates.push(resolve(configuredBash));

  const whereGit = spawnSync("where.exe", ["git.exe"], {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  if (whereGit.status === 0) {
    for (const gitPath of whereGit.stdout.split(/\r?\n/).filter(Boolean)) {
      const gitDirectory = dirname(gitPath.trim());
      const gitRoot = dirname(gitDirectory);
      candidates.push(join(gitRoot, "bin", "bash.exe"));
    }
  }

  for (const root of [
    process.env.ProgramFiles,
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Programs"),
    process.env["ProgramFiles(x86)"],
  ].filter(Boolean)) {
    candidates.push(join(root, "Git", "bin", "bash.exe"));
  }

  return [...new Set(candidates)].find((candidate) => existsSync(candidate));
}

const bashExecutable =
  process.platform === "win32" ? findWindowsBash() : "bash";

if (!bashExecutable) {
  console.error(
    "[local-poc] Git for Windows Bash was not found. Install Git for Windows or set LOCAL_POC_BASH to bash.exe.",
  );
  process.exit(2);
}

const bashScript =
  process.platform === "win32"
    ? scriptPath.replaceAll("\\", "/")
    : scriptPath;
const result = spawnSync(
  bashExecutable,
  [bashScript, ...process.argv.slice(2)],
  {
    cwd: repositoryRoot,
    env: process.env,
    shell: false,
    stdio: "inherit",
    windowsHide: false,
  },
);

if (result.error) {
  console.error(`[local-poc] Unable to start Bash: ${result.error.message}`);
  process.exit(2);
}

if (result.signal === "SIGINT") process.exit(130);
if (result.signal === "SIGTERM") process.exit(143);
process.exit(result.status ?? 1);
