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
  | "git push"
  | "unrecognized shell command";

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

  async evaluateShell(
    agent: Agent,
    command: string,
    context: RuntimeAuthorizationContext,
  ): Promise<AuthorizationDecision> {
    const normalizedCommand = normalizeShellCommand(command);
    const detectedCommand = detectShellCommand(normalizedCommand);
    const action: RuntimeAction =
      detectedCommand === "curl" || detectedCommand === "wget" || detectedCommand === "ssh"
        ? { kind: "network.request", client: detectedCommand }
        : {
            kind: "shell.execute",
            command: detectedCommand ?? "unrecognized shell command",
          };
    const policy = await evaluateRuntimeAction(agent.workspacePath, action);
    const decision = makeDecision(agent, context, policy);
    if (policy.allowed) {
      await this.appendAllowedDecision(decision);
      return decision;
    }
    await this.appendDeniedDecision(decision);
    throw new HttpError(403, "Runtime action denied by Agent Trust Gateway", {
      code: "RUNTIME_ACTION_DENIED",
      details: decision,
    });
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
    const candidate = match[2];
    if (candidate && looksLikePath(candidate)) add({ kind: "file.read", path: candidate });
  }
  for (const match of prompt.matchAll(/\b(write|edit|create|append|save)(?:\s+(?:to|into))?\s+(?:the\s+)?(?:file\s+)?[`"']?([^\s`"',;]+)/gi)) {
    const candidate = match[2];
    if (candidate && looksLikePath(candidate)) add({ kind: "file.write", path: candidate });
  }

  const normalizedShellInput = normalizeShellCommand(prompt);
  const shellCommand = detectBlockedShellCommand(normalizedShellInput);
  if (shellCommand === "curl" || shellCommand === "wget" || shellCommand === "ssh") {
    add({ kind: "network.request", client: shellCommand });
  } else if (shellCommand) {
    add({ kind: "shell.execute", command: shellCommand });
  }
  for (const [pattern, safeCommand] of safeShellCommands) {
    if (pattern.test(normalizedShellInput)) {
      add({ kind: "shell.execute", command: safeCommand });
    }
  }
  return actions;
}

export function normalizeShellCommand(command: string): string {
  return command
    .trim()
    .replace(/^```(?:bash|sh|shell|zsh)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .replace(/^(?:run|please\s+execute|execute|command)\s*:\s*/i, "")
    .replace(/^[`"']+|[`"']+$/g, "")
    .trim();
}

function detectShellCommand(command: string): SafeCommand | "curl" | "wget" | "ssh" | null {
  return detectBlockedShellCommand(command) ?? detectSafeShellCommand(command);
}

function detectBlockedShellCommand(command: string): SafeCommand | "curl" | "wget" | "ssh" | null {
  if (/\brm\s+(?:--\S+\s+)*-(?=[a-z]*r)(?=[a-z]*f)[a-z]+\b/i.test(command)) {
    return "rm -rf";
  }
  if (/\bsudo\b/i.test(command)) return "sudo";
  if (/\bchmod\s+777\b/i.test(command)) return "chmod 777";
  if (/\bdocker\s+run\b[\s\S]{0,160}?--privileged\b/i.test(command)) {
    return "docker run --privileged";
  }
  if (/\bgit\s+push\b/i.test(command)) return "git push";
  if (/\bcurl\b/i.test(command)) return "curl";
  if (/\bwget\b/i.test(command)) return "wget";
  if (/\bssh\b/i.test(command)) return "ssh";
  return null;
}

const safeShellCommands = [
  [/\bnpm\s+test\b/i, "npm test"],
  [/\bnpm\s+run\s+test\b/i, "npm run test"],
  [/\bnpm\s+run\s+build\b/i, "npm run build"],
  [/\bgit\s+status\b/i, "git status"],
  [/\bgit\s+diff\b/i, "git diff"],
] as const;

function detectSafeShellCommand(command: string): SafeCommand | null {
  for (const [pattern, safeCommand] of safeShellCommands) {
    if (pattern.test(command)) return safeCommand;
  }
  return null;
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

function safePathLabel(value: string): string {
  return value.replaceAll("\\", "/").replace(/[\r\n\t]/g, " ").slice(0, 200) || "(empty path)";
}
