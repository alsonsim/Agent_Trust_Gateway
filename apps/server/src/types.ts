export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type MessageRole = "user" | "assistant";
export type Department = "finance" | "hr" | "research";
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
  | "network.request"
  | "delegation.request"
  | "delegation.approve"
  | "delegation.reject"
  | "delegation.revoke";
export type DelegationRequestStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "expired";
export type DelegationContractStatus =
  | "active"
  | "consumed"
  | "revoked"
  | "expired";
export type DelegationResultVisibility = "final_output_only";
export type PersonalInformationAssessment = "none_detected" | "possible";

export const DEFAULT_LEGACY_OWNER_ID = "11111111-1111-4111-8111-111111111111";

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
  role: MessageRole;
  content: string;
  createdAt: string;
}

export interface RunUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
}

export interface AgentRun {
  id: string;
  agentId: string;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: RunUsage | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface ProtectedResource {
  id: string;
  ownerId: string;
  ownerDepartment: Department;
  name: string;
  description: string;
  fileName: string;
  storageKey: string;
  createdAt: string;
}

export interface ProtectedResourceSummary extends Omit<ProtectedResource, "storageKey"> {
  ownedByCurrentUser: boolean;
}

export interface KnownHuman {
  id: string;
  email: string;
  displayName: string;
  department: Department;
  lastSeenAt: string;
}

export interface DelegationRequest {
  id: string;
  requesterHumanId: string;
  requesterEmail: string;
  requesterDisplayName: string;
  requesterDepartment: Department;
  requiredCapability: string;
  sanitizedTaskSummary: string;
  personalInformation: PersonalInformationAssessment;
  requestedPrompt: string;
  taskDigest: string;
  status: DelegationRequestStatus;
  createdAt: string;
  expiresAt: string;
  reviewedAt: string | null;
  contractId: string | null;
}

export interface DelegationContract {
  id: string;
  requestId: string | null;
  requiredCapability: string;
  sanitizedTaskSummary: string;
  personalInformation: PersonalInformationAssessment;
  approvingHumanId: string;
  granteeHumanId: string;
  granteeEmail: string;
  granteeDisplayName: string;
  granteeDepartment: Department;
  agentId: string;
  approvedPrompt: string;
  exactPromptDigest: string;
  approvedResourceIds: string[];
  approvedResourceDigests: Record<string, string>;
  allowedActions: ["agent.invoke"];
  resultVisibility: DelegationResultVisibility;
  maximumUses: 1;
  usesConsumed: number;
  expiresAt: string;
  status: DelegationContractStatus;
  runId: string | null;
  createdAt: string;
  consumedAt: string | null;
  revokedAt: string | null;
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
  targetType:
    | "agent"
    | "run"
    | "resource"
    | "file"
    | "command"
    | "network"
    | "delegation"
    | "capability";
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
    | "RUNTIME_NETWORK_DENIED"
    | "DELEGATION_REQUESTED"
    | "DELEGATION_APPROVED"
    | "DELEGATION_REJECTED"
    | "DELEGATION_ACTIVE"
    | "DELEGATION_CONSUMED"
    | "DELEGATION_REVOKED"
    | "DELEGATION_EXPIRED"
    | "DELEGATION_PROMPT_MISMATCH"
    | "DELEGATION_GRANTEE_MISMATCH"
    | "DELEGATION_ACTION_NOT_ALLOWED"
    | "DELEGATION_RESOURCE_CHANGED";
  reason: string;
  createdAt: string;
}

export interface Database {
  version: 3;
  agents: Agent[];
  messages: Message[];
  runs: AgentRun[];
  protectedResources: ProtectedResource[];
  authorizationDecisions: AuthorizationDecision[];
  knownHumans: KnownHuman[];
  delegationRequests: DelegationRequest[];
  delegationContracts: DelegationContract[];
}

export interface CreateAgentInput {
  name: string;
  description?: string | undefined;
  instructions?: string | undefined;
}

export interface UpdateAgentInput {
  name?: string | undefined;
  description?: string | undefined;
  instructions?: string | undefined;
}

export interface RunnerResult {
  output: string;
  threadId: string | null;
  usage: RunUsage | null;
}

export interface RunnerRequest {
  agentId: string;
  workspacePath: string;
  prompt: string;
  threadId: string | null;
}

export interface RuntimeAuthorizationContext {
  humanUserId: string;
  humanEmail: string;
  humanDepartment: Department;
  requestId: string;
}

export interface AgentRunner {
  run(request: RunnerRequest): Promise<RunnerResult>;
  cancel(agentId: string): Promise<boolean>;
  isAvailable(): Promise<boolean>;
}
