import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { RunCancelledError } from "./errors.js";
import type {
  AgentRunner,
  RunnerRequest,
  RunnerResult,
  RuntimeInspection,
} from "./types.js";
import {
  evaluateWorkspaceFileRead,
  evaluateWorkspaceFileWrite,
  isProtectedWorkspacePath,
  WorkspaceFileNotFoundError,
} from "./workspace-file-policy.js";

const NOTE_PATH = "reports/offline-demo-note.md";
const MAX_LISTED_FILES = 40;
const MAX_READ_CHARS = 2_000;

export class OfflineDemoRunner implements AgentRunner {
  private readonly activeAgents = new Set<string>();
  private readonly cancellationRequests = new Set<string>();

  async run(request: RunnerRequest): Promise<RunnerResult> {
    this.activeAgents.add(request.agentId);
    try {
      this.throwIfCancelled(request.agentId);
      const userPrompt = extractUserRequest(request.prompt);
      const lowerPrompt = userPrompt.toLowerCase();
      const sections = [
        "Offline demo run completed.",
        "No Ark, Codex cloud, Supabase, or network service was called.",
      ];

      if (looksUnsafe(lowerPrompt)) {
        sections.push(
          "I did not perform the unsafe action described in the prompt. In normal request flow, the Runtime Action Firewall denies these prompts before a Run is created and records the denial in the audit log.",
        );
      } else {
        if (requestsWorkspaceListing(lowerPrompt)) {
          sections.push(await this.listWorkspaceFiles(request.workspacePath));
        }
        if (requestsReadmeRead(lowerPrompt)) {
          sections.push(await this.readWorkspaceReadme(request.workspacePath));
        }
        if (requestsHarmlessWrite(lowerPrompt)) {
          this.throwIfCancelled(request.agentId);
          sections.push(await this.writeHarmlessNote(request.workspacePath));
        }
        if (sections.length === 2) {
          sections.push(
            "I can simulate safe demo actions such as reading README.md, listing workspace files, or creating reports/offline-demo-note.md.",
          );
        }
      }

      return {
        output: sections.join("\n\n"),
        threadId: request.threadId ?? offlineThreadId(request.workspaceProfileId),
        usage: {
          inputTokens: 0,
          outputTokens: sections.join(" ").split(/\s+/).filter(Boolean).length,
        },
      };
    } finally {
      this.activeAgents.delete(request.agentId);
      this.cancellationRequests.delete(request.agentId);
    }
  }

  async cancel(agentId: string): Promise<boolean> {
    if (!this.activeAgents.has(agentId)) return false;
    this.cancellationRequests.add(agentId);
    return true;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async inspect(): Promise<RuntimeInspection> {
    return { available: true, codexVersion: null };
  }

  private async listWorkspaceFiles(workspacePath: string): Promise<string> {
    const files = await collectWorkspaceFiles(workspacePath);
    if (files.length === 0) return "Workspace files: no visible files found.";
    return "Workspace files:\n" + files.map((file) => "- " + file).join("\n");
  }

  private async readWorkspaceReadme(workspacePath: string): Promise<string> {
    try {
      const decision = await evaluateWorkspaceFileRead(workspacePath, "README.md");
      if (!decision.allowed || !decision.resolvedPath) {
        return "README.md was not read: " + decision.reason;
      }
      const content = await readFile(decision.resolvedPath, "utf8");
      return "README.md excerpt:\n" + content.slice(0, MAX_READ_CHARS).trim();
    } catch (error) {
      if (error instanceof WorkspaceFileNotFoundError) {
        return "README.md was not found in this Agent workspace.";
      }
      throw error;
    }
  }

  private async writeHarmlessNote(workspacePath: string): Promise<string> {
    const decision = await evaluateWorkspaceFileWrite(workspacePath, NOTE_PATH);
    if (!decision.allowed || !decision.resolvedPath) {
      return NOTE_PATH + " was not written: " + decision.reason;
    }
    await mkdir(path.dirname(decision.resolvedPath), { recursive: true });
    await writeFile(
      decision.resolvedPath,
      [
        "# Offline Demo Note",
        "",
        "This file was created by the offline-demo Runtime provider.",
        "It contains no credentials and does not require network access.",
        "",
      ].join("\n"),
      { encoding: "utf8", mode: 0o600 },
    );
    return "Created " + NOTE_PATH + ".";
  }

  private throwIfCancelled(agentId: string): void {
    if (this.cancellationRequests.has(agentId)) {
      throw new RunCancelledError();
    }
  }
}

async function collectWorkspaceFiles(workspacePath: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string, depth: number): Promise<void> {
    if (depth > 3 || files.length >= MAX_LISTED_FILES) return;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (files.length >= MAX_LISTED_FILES) break;
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.relative(workspacePath, absolutePath);
      if (
        entry.isSymbolicLink() ||
        entry.name === "node_modules" ||
        entry.name === "dist" ||
        isProtectedWorkspacePath(relativePath)
      ) {
        continue;
      }
      const portablePath = relativePath.split(path.sep).join("/");
      if (entry.isDirectory()) {
        await visit(absolutePath, depth + 1);
      } else if (entry.isFile()) {
        files.push(portablePath);
      }
    }
  }
  await visit(workspacePath, 0);
  return files;
}

function extractUserRequest(prompt: string): string {
  const marker = "\nUser request:\n";
  const markerIndex = prompt.lastIndexOf(marker);
  return markerIndex === -1 ? prompt : prompt.slice(markerIndex + marker.length);
}

function requestsWorkspaceListing(prompt: string): boolean {
  return /\blist\b.*\b(files|workspace)\b/.test(prompt) ||
    /\bshow\b.*\b(workspace files|files)\b/.test(prompt);
}

function requestsReadmeRead(prompt: string): boolean {
  return /\bread\b.*\breadme\.md\b/.test(prompt) ||
    /\bopen\b.*\breadme\.md\b/.test(prompt) ||
    /\bview\b.*\breadme\.md\b/.test(prompt);
}

function requestsHarmlessWrite(prompt: string): boolean {
  return /\b(create|write|add)\b.*\b(harmless file|offline-demo-note\.md)\b/.test(prompt) ||
    prompt.includes(NOTE_PATH);
}

function looksUnsafe(prompt: string): boolean {
  return (
    prompt.includes(".env") ||
    prompt.includes("../") ||
    prompt.includes("..\\") ||
    /\brm\s+-[a-z]*r[a-z]*f\b/.test(prompt) ||
    /\b(curl|wget|ssh|scp|nc)\b/.test(prompt)
  );
}

function offlineThreadId(workspaceProfileId: string): string {
  return "offline-demo-" +
    createHash("sha256").update(workspaceProfileId).digest("hex").slice(0, 16);
}
