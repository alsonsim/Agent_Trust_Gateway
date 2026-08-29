export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type Department = "finance" | "hr" | "research";
export type AuthMode = "demo" | "supabase" | "legacy";
export type AuthorizationDecisionValue = "allow" | "deny";
export type AuthorizationAction =
  | "agent.create"
  | "agent.read"
  | "agent.update"
  | "agent.delete"
  | "agent.revoke"
  | "agent.start"
  | "agent.stop"
  | "agent.invoke"
  | "run.read"
  | "resource.read"
  | "file.read"
  | "file.write"
  | "shell.execute"
  | "network.request";

export interface HumanPrincipal {
  id: string;
  email: string;
  displayName: string;
  department: Department;
}

export interface AuthConfiguration {
  mode: AuthMode;
  legacyTokenRequired: boolean;
  demoUsers: HumanPrincipal[];
}

export interface Agent {
  id: string;
  ownerId: string;
  name: string;
  description: string;
  instructions: string;
  status: AgentStatus;
  revokedAt: string | null;
  workspacePath: string;
  codexThreadId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  agentId: string;
  runId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface AgentRun {
  id: string;
  agentId: string;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
  } | null;
  createdAt: string;
}

export interface SystemInfo {
  arkConfigured: boolean;
  arkBaseUrl: string;
  arkModel: string | null;
  codexAvailable: boolean;
  codexSandboxMode: string;
  runtimeProvider: "local-process" | "container";
  containerEngine: string | null;
  runtime: string;
}

export interface ProtectedResourceSummary {
  id: string;
  ownerId: string;
  ownerDepartment: Department;
  name: string;
  description: string;
  fileName: string;
  createdAt: string;
  ownedByCurrentUser: boolean;
}

export interface AuthorizationDecision {
  id: string;
  requestId: string;
  humanUserId: string;
  humanEmail: string;
  humanDepartment: Department;
  agentId: string | null;
  agentName: string | null;
  action: AuthorizationAction;
  targetType: "agent" | "run" | "resource" | "file" | "command" | "network";
  targetId: string;
  targetLabel: string;
  decision: AuthorizationDecisionValue;
  reasonCode:
    | "OWNER_MATCH"
    | "HUMAN_AGENT_OWNER_MISMATCH"
    | "AGENT_REVOKED"
    | "AGENT_RESOURCE_OWNER_MISMATCH"
    | "WORKSPACE_PATH_ALLOWED"
    | "PATH_OUTSIDE_WORKSPACE"
    | "PROTECTED_SECRET_FILE"
    | "FILE_TOO_LARGE"
    | "RUNTIME_COMMAND_ALLOWED"
    | "RUNTIME_COMMAND_DENIED"
    | "RUNTIME_NETWORK_DENIED";
  reason: string;
  createdAt: string;
}

export interface ProtectedResourceRead {
  resource: {
    summary: ProtectedResourceSummary;
    content: string;
  };
  decision: AuthorizationDecision;
}

export interface WorkspaceFileRead {
  path: string;
  content: string;
  decision: AuthorizationDecision;
}
