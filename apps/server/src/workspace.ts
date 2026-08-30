import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Agent, Department, WorkspaceProfile } from "./types.js";

const STANDARD_WORKSPACE_DIRECTORIES = ["src", "test", "reports"] as const;

export function workspaceProfileId(department: Department): string {
  return "department-" + department;
}

export function workspaceOwnerKey(ownerId: string): string {
  return "owner-" + createHash("sha256").update(ownerId, "utf8").digest("hex").slice(0, 24);
}

export function runtimeWorkspaceStateId(
  department: Department,
  ownerId: string,
): string {
  return workspaceProfileId(department) + "-" + workspaceOwnerKey(ownerId);
}

export class WorkspaceManager {
  constructor(private readonly root: string) {}

  workspacePath(department: Department): string {
    return path.join(this.root, department);
  }

  ownerWorkspacePath(department: Department, ownerId: string): string {
    return path.join(
      this.workspacePath(department),
      ".owners",
      workspaceOwnerKey(ownerId),
    );
  }

  profile(department: Department): WorkspaceProfile {
    const timestamp = new Date().toISOString();
    return {
      id: workspaceProfileId(department),
      department,
      workspacePath: this.workspacePath(department),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await mkdir(path.join(this.root, ".deleted"), { recursive: true });
  }

  async ensureProfile(profile: WorkspaceProfile): Promise<void> {
    await this.ensureWorkspace(profile, profile.workspacePath, "role template");
  }

  async ensureOwnerWorkspace(
    profile: WorkspaceProfile,
    ownerId: string,
  ): Promise<string> {
    const workspacePath = this.ownerWorkspacePath(profile.department, ownerId);
    await this.ensureWorkspace(profile, workspacePath, "owner-scoped");
    return workspacePath;
  }

  private async ensureWorkspace(
    profile: WorkspaceProfile,
    workspacePath: string,
    scopeLabel: "role template" | "owner-scoped",
  ): Promise<void> {
    await mkdir(workspacePath, { recursive: true });
    await this.ensureStandardDirectories(workspacePath);
    await writeOnce(
      path.join(workspacePath, ".gitignore"),
      [".codex/", "node_modules/", "dist/", ".env", "*.log", ""].join("\n"),
    );
    await writeOnce(
      path.join(workspacePath, "README.md"),
      [
        "# " + profile.department + " engineering " + scopeLabel + " workspace",
        "",
        scopeLabel === "owner-scoped"
          ? "This persistent workspace is private to one authenticated owner within the " +
            profile.department +
            " role."
          : "This directory provides the managed template for the " +
            profile.department +
            " role.",
        scopeLabel === "owner-scoped"
          ? "Only this owner's workspace is projected into the Agent Runtime."
          : "Writable Agent workspaces are created in owner-scoped child directories.",
        "",
      ].join("\n"),
    );
    await writeOnce(
      path.join(workspacePath, "PROJECT_BRIEF.md"),
      projectBrief(profile.department),
    );
    await this.writeProfileInstructions(profile, workspacePath);
  }

  async importLegacyWorkspace(
    agent: Agent,
    profile: WorkspaceProfile,
  ): Promise<void> {
    const source = path.resolve(agent.workspacePath);
    const root = path.resolve(this.root);
    const destinationRoot = path.resolve(
      this.ownerWorkspacePath(profile.department, agent.ownerId),
    );
    if (source === destinationRoot || !isInside(root, source) || source === root) return;

    try {
      if (!(await stat(source)).isDirectory()) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }

    const ownersRoot = path.resolve(profile.workspacePath, ".owners");
    const copyOptions = {
      recursive: true,
      force: false,
      errorOnExist: false,
      preserveTimestamps: true,
      filter: (sourcePath: string) => {
        const candidate = path.resolve(sourcePath);
        return !isSameOrInside(ownersRoot, candidate) &&
          !isSameOrInside(destinationRoot, candidate);
      },
    } as const;
    if (isSameOrInside(source, destinationRoot)) {
      const stagingRoot = await mkdtemp(path.join(root, ".workspace-migration-"));
      const stagedWorkspace = path.join(stagingRoot, "workspace");
      try {
        await cp(source, stagedWorkspace, copyOptions);
        await cp(stagedWorkspace, destinationRoot, {
          recursive: true,
          force: false,
          errorOnExist: false,
          preserveTimestamps: true,
        });
      } finally {
        await rm(stagingRoot, { recursive: true, force: true });
      }
    } else {
      await cp(source, destinationRoot, copyOptions);
    }
  }

  async writeInstructions(agent: Agent): Promise<void> {
    // Shared AGENTS.md contains only role-safe rules. AgentService injects the
    // selected Agent's own identity and instructions into every Runtime prompt.
    await this.writeProfileInstructions(
      {
        id: agent.workspaceProfileId,
        department: agent.department,
        workspacePath: this.workspacePath(agent.department),
        createdAt: agent.createdAt,
        updatedAt: agent.updatedAt,
      },
      agent.workspacePath,
    );
  }

  private async ensureStandardDirectories(workspacePath: string): Promise<void> {
    await Promise.all(
      STANDARD_WORKSPACE_DIRECTORIES.map((directory) =>
        mkdir(path.join(workspacePath, directory), { recursive: true }),
      ),
    );
  }

  private async writeProfileInstructions(
    profile: WorkspaceProfile,
    workspacePath: string,
  ): Promise<void> {
    const content = [
      "# Platform-managed engineering workspace rules",
      "",
      "This is the " + profile.department + " engineering role workspace.",
      "",
      "## Workspace rules",
      "",
      "- Work only inside this role workspace.",
      "- Other role workspaces and application source are not mounted.",
      "- Preserve existing user files and avoid destructive operations.",
      "- Build and test changes when practical.",
      "- Never print environment variables or credentials.",
      "",
      "Agent-specific instructions are supplied separately by the control plane.",
      "",
    ]
      .filter((line, index, lines) => !(line === "" && lines[index - 1] === ""))
      .join("\n");
    await writeFile(path.join(workspacePath, "AGENTS.md"), content, "utf8");
  }
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(".." + path.sep);
}

function isSameOrInside(root: string, candidate: string): boolean {
  if (root === candidate) return true;
  const relative = path.relative(root, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(".." + path.sep);
}

async function writeOnce(filePath: string, content: string): Promise<void> {
  try {
    await writeFile(filePath, content, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

function projectBrief(department: Department): string {
  const briefs: Record<Department, string[]> = {
    frontend: [
      "# Profile Page Frontend Project Brief",
      "",
      "## Objective",
      "",
      "Implement an accessible, responsive profile page that consumes the agreed profile API without exposing protected data.",
      "",
      "## Deliverables",
      "",
      "- Profile header, biography, team, and safe avatar fallback components.",
      "- Loading, empty, forbidden, not-found, validation, and retryable error states.",
      "- Edit and cancel interactions with keyboard-accessible labelled controls.",
      "- Component and browser tests for the critical user journeys.",
      "",
      "## Acceptance criteria",
      "",
      "- The layout works at 360, 768, and 1440 px widths.",
      "- User-provided fields are rendered as text, never raw HTML.",
      "- The implementation follows the backend contract and handles every documented status.",
    ],
    backend: [
      "# Profile API Backend Project Brief",
      "",
      "## Objective",
      "",
      "Implement authenticated profile read and update endpoints with explicit ownership checks and a stable JSON contract.",
      "",
      "## Deliverables",
      "",
      "- `GET /api/profile` with authentication and error behavior that does not leak protected data.",
      "- `PATCH /api/profile` with an allowlist schema and optimistic concurrency.",
      "- Parameterized persistence operations and bounded, sanitized error responses.",
      "- Unit and integration tests for authorization, validation, and concurrent updates.",
      "",
      "## Acceptance criteria",
      "",
      "- Only the authenticated owner can update a profile.",
      "- Unknown fields and biographies over 500 characters are rejected.",
      "- Logs and errors contain no credentials or profile content.",
    ],
    qa: [
      "# Profile Release QA Project Brief",
      "",
      "## Objective",
      "",
      "Prove that the profile page and API meet their shared contract, accessibility expectations, and authorization boundary before release.",
      "",
      "## Deliverables",
      "",
      "- API contract coverage for success, validation, forbidden, not-found, timeout, and retry cases.",
      "- Browser coverage for load, edit, save, cancel, refresh, and concurrent-edit behavior.",
      "- Keyboard-only, responsive, and safe-rendering checks.",
      "- A concise release report with reproducible failures and regression evidence.",
      "",
      "## Acceptance criteria",
      "",
      "- Cross-user reads and updates are denied without content leakage.",
      "- Critical checks run automatically and pass on a clean checkout.",
      "- Any release blocker includes exact steps, expected behavior, and observed evidence.",
    ],
  };
  return briefs[department].join("\n") + "\n";
}
