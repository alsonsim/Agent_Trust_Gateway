import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Agent, Department } from "./types.js";

const STANDARD_WORKSPACE_DIRECTORIES = ["src", "test", "reports"] as const;

export class WorkspaceManager {
  constructor(private readonly root: string) {}

  workspacePath(agentId: string): string {
    return path.join(this.root, agentId);
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await mkdir(path.join(this.root, ".deleted"), { recursive: true });
  }

  async create(agent: Agent, ownerDepartment: Department): Promise<void> {
    await mkdir(agent.workspacePath, { recursive: false });
    await this.ensureStandardDirectories(agent);
    await this.writeInstructions(agent);
    await writeFile(
      path.join(agent.workspacePath, ".gitignore"),
      [".codex/", "node_modules/", "dist/", ".env", "*.log", ""].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(agent.workspacePath, "README.md"),
      [
        "# " + agent.name + " workspace",
        "",
        "Files created or edited by the Agent live here.",
        "The platform-generated AGENTS.md contains the current Agent instructions.",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(agent.workspacePath, "PROJECT_BRIEF.md"),
      projectBrief(ownerDepartment),
      "utf8",
    );
  }

  async ensureStandardDirectories(agent: Agent): Promise<void> {
    await Promise.all(
      STANDARD_WORKSPACE_DIRECTORIES.map((directory) =>
        mkdir(path.join(agent.workspacePath, directory), { recursive: true }),
      ),
    );
  }

  async writeInstructions(agent: Agent): Promise<void> {
    const content = [
      "# Platform-managed Agent instructions",
      "",
      "You are the coding Agent named " + agent.name + ".",
      agent.description ? "Purpose: " + agent.description : "",
      "",
      "## Instructions",
      "",
      agent.instructions ||
        "Help the user complete coding tasks in this workspace. Explain material results concisely.",
      "",
      "## Workspace rules",
      "",
      "- Work only inside this workspace unless the user explicitly requests otherwise.",
      "- Preserve existing user files and avoid destructive operations.",
      "- Build and test changes when practical.",
      "- Never print environment variables or credentials.",
      "",
      "This file is regenerated when the Agent configuration is updated.",
      "",
    ]
      .filter((line, index, lines) => !(line === "" && lines[index - 1] === ""))
      .join("\n");
    await writeFile(path.join(agent.workspacePath, "AGENTS.md"), content, "utf8");
  }

  async archive(agent: Agent): Promise<string> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const destination = path.join(
      this.root,
      ".deleted",
      agent.id + "-" + timestamp,
    );
    await rename(agent.workspacePath, destination);
    return destination;
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
