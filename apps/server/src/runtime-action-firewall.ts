import { randomUUID } from "node:crypto";
import type { SecurityRepository } from "./security-repository.js";
import type {
  Agent,
  AuthorizationAction,
  AuthorizationDecision,
  RuntimeAuthorizationContext,
} from "./types.js";
import {
  evaluateWorkspaceFileRead,
  evaluateWorkspaceFileWrite,
  WorkspaceFileNotFoundError,
} from "./workspace-file-policy.js";
import { HttpError } from "./errors.js";

type RuntimeAction =
  | { kind: "file.read"; path: string }
  | { kind: "file.write"; path: string }
  | { kind: "shell.execute"; command: SafeCommand }
  | { kind: "network.request"; client: "curl" | "wget" | "ssh" };

type SafeCommand =
  | "npm test"
  | "npm run test"
  | "npm run build"
  | "git status"
  | "git diff"
  | "rm -rf"
  | "sudo"
  | "chmod 777"
  | "docker run --privileged"
  | "git push";

interface RuntimePolicyResult {
  action: AuthorizationAction;
  targetType: AuthorizationDecision["targetType"];
  targetLabel: string;
  allowed: boolean;
  reasonCode: AuthorizationDecision["reasonCode"];
  reason: string;
}

export class RuntimeActionFirewall {
  constructor(private readonly securityRepository: SecurityRepository) {}

  async authorize(
    agent: Agent,
    prompt: string,
    context: RuntimeAuthorizationContext,
  ): Promise<void> {
    for (const action of extractRuntimeActions(prompt)) {
      const policy = await evaluateRuntimeAction(agent.workspacePath, action);
      const decision = makeDecision(agent, context, policy);
      if (policy.allowed) {
        await this.appendAllowedDecision(decision);
        continue;
      }
      await this.appendDeniedDecision(decision);
      throw new HttpError(403, "Runtime action denied by Agent Trust Gateway", {
        code: "RUNTIME_ACTION_DENIED",
        details: decision,
      });
    }
  }

  private async appendAllowedDecision(decision: AuthorizationDecision): Promise<void> {
    try {
      await this.securityRepository.appendDecision(decision);
    } catch {
      throw new HttpError(
        503,
        "Runtime authorization evidence could not be persisted; execution failed closed",
        { code: "AUTHORIZATION_AUDIT_UNAVAILABLE" },
      );
    }
  }

  private async appendDeniedDecision(decision: AuthorizationDecision): Promise<void> {
    try {
      await this.securityRepository.appendDecision(decision);
    } catch {
      // Denial remains in force even if the evidence sink is unavailable.
    }
  }
}

export function extractRuntimeActions(prompt: string): RuntimeAction[] {
  const actions: RuntimeAction[] = [];
  const seen = new Set<string>();
  const add = (action: RuntimeAction) => {
    const key = action.kind + ":" + ("path" in action ? action.path : "command" in action ? action.command : action.client);
    if (!seen.has(key)) {
      seen.add(key);
      actions.push(action);
    }
  };

  for (const match of prompt.matchAll(/\b(read|cat|open|view|inspect)\s+(?:the\s+)?(?:file\s+)?[`"']?([^\s`"',;]+)/gi)) {
    const candidate = normalizeExtractedPath(match[2]);
    if (candidate && looksLikePath(candidate)) add({ kind: "file.read", path: candidate });
  }
  for (const match of prompt.matchAll(/\b(write|edit|create|append|save)(?:\s+(?:to|into))?\s+(?:the\s+)?(?:file\s+)?[`"']?([^\s`"',;]+)/gi)) {
    const candidate = normalizeExtractedPath(match[2]);
    if (candidate && looksLikePath(candidate)) add({ kind: "file.write", path: candidate });
  }

  if (/\brm\s+-(?=[a-z]*r)(?=[a-z]*f)[a-z]+\b/i.test(prompt)) {
    add({ kind: "shell.execute", command: "rm -rf" });
  }
  if (/\bsudo\b/i.test(prompt)) add({ kind: "shell.execute", command: "sudo" });
  if (/\bchmod\s+777\b/i.test(prompt)) {
    add({ kind: "shell.execute", command: "chmod 777" });
  }
  if (/\bdocker\s+run\b[\s\S]{0,160}?--privileged\b/i.test(prompt)) {
    add({ kind: "shell.execute", command: "docker run --privileged" });
  }
  if (/\bgit\s+push\b/i.test(prompt)) add({ kind: "shell.execute", command: "git push" });
  if (/\bcurl\b/i.test(prompt)) add({ kind: "network.request", client: "curl" });
  if (/\bwget\b/i.test(prompt)) add({ kind: "network.request", client: "wget" });
  if (/\bssh\b/i.test(prompt)) add({ kind: "network.request", client: "ssh" });

  for (const [pattern, command] of [
    [/\bnpm\s+test\b/i, "npm test"],
    [/\bnpm\s+run\s+test\b/i, "npm run test"],
    [/\bnpm\s+run\s+build\b/i, "npm run build"],
    [/\bgit\s+status\b/i, "git status"],
    [/\bgit\s+diff\b/i, "git diff"],
  ] as const) {
    if (pattern.test(prompt)) add({ kind: "shell.execute", command });
  }
  return actions;
}

async function evaluateRuntimeAction(
  workspacePath: string,
  action: RuntimeAction,
): Promise<RuntimePolicyResult> {
  if (action.kind === "file.read" || action.kind === "file.write") {
    try {
      const result = await (action.kind === "file.read"
        ? evaluateWorkspaceFileRead(workspacePath, action.path)
        : evaluateWorkspaceFileWrite(workspacePath, action.path));
      return {
        action: action.kind,
        targetType: "file",
        targetLabel: result.targetLabel,
        allowed: result.allowed,
        reasonCode: result.reasonCode,
        reason: result.reason,
      };
    } catch (error) {
      if (error instanceof WorkspaceFileNotFoundError) {
        return {
          action: action.kind,
          targetType: "file",
          targetLabel: safePathLabel(action.path),
          allowed: false,
          reasonCode: "PATH_OUTSIDE_WORKSPACE",
          reason: "The requested workspace file could not be resolved safely.",
        };
      }
      throw error;
    }
  }
  if (action.kind === "network.request") {
    return {
      action: "network.request",
      targetType: "network",
      targetLabel: action.client + " (network request)",
      allowed: false,
      reasonCode: "RUNTIME_NETWORK_DENIED",
      reason: "Direct network requests are blocked by the Runtime Action Firewall.",
    };
  }
  const allowed = ["npm test", "npm run test", "npm run build", "git status", "git diff"].includes(
    action.command,
  );
  return {
    action: "shell.execute",
    targetType: "command",
    targetLabel: action.command,
    allowed,
    reasonCode: allowed ? "RUNTIME_COMMAND_ALLOWED" : "RUNTIME_COMMAND_DENIED",
    reason: allowed
      ? "The command is permitted by the Runtime Action Firewall."
      : "The command is blocked by the Runtime Action Firewall.",
  };
}

function makeDecision(
  agent: Agent,
  context: RuntimeAuthorizationContext,
  policy: RuntimePolicyResult,
): AuthorizationDecision {
  return {
    id: randomUUID(),
    requestId: context.requestId,
    humanUserId: context.humanUserId,
    humanEmail: context.humanEmail,
    humanDepartment: context.humanDepartment,
    agentId: agent.id,
    agentName: agent.name,
    action: policy.action,
    targetType: policy.targetType,
    targetId: policy.targetLabel,
    targetLabel: policy.targetLabel,
    decision: policy.allowed ? "allow" : "deny",
    reasonCode: policy.reasonCode,
    reason: policy.reason,
    createdAt: new Date().toISOString(),
  };
}

function looksLikePath(value: string): boolean {
  return value.startsWith(".") || value.includes("/") || value.includes("\\") || value.includes(".");
}

function normalizeExtractedPath(value: string | undefined): string | undefined {
  if (!value) return value;
  return /[A-Za-z0-9_\])}][.!?]$/.test(value) ? value.slice(0, -1) : value;
}

function safePathLabel(value: string): string {
  return value.replaceAll("\\", "/").replace(/[\r\n\t]/g, " ").slice(0, 200) || "(empty path)";
}
