export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type Department = "frontend" | "backend" | "qa";
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
  | "network.request"
  | "delegation.request"
  | "delegation.approve"
  | "delegation.reject"
  | "delegation.revoke";
export type CapabilityId =
  | "frontend.interface-implementation"
  | "backend.service-implementation"
  | "qa.release-validation";
export type PersonalInformationAssessment = "none_detected" | "possible";
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
  department: Department;
  workspaceProfileId: string;
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
  codexExecutable: string;
  codexExecutableSource: "configured" | "platform-default";
  codexAvailable: boolean;
  codexVersion: string | null;
  codexExpectedVersion: string;
  codexSandboxMode: string;
  runtimeProvider:
    | "offline-demo"
    | "local-process"
    | "application-container"
    | "container";
  containerEngine: string | null;
  containerRuntimeImage: string | null;
  executionReady: boolean;
  delegatedRunsAvailable: boolean;
  blockers: RuntimeBlocker[];
  capabilities: RuntimeCapabilities;
  runtime: string;
}

export interface RuntimeBlocker {
  code: string;
  message: string;
}

export interface RuntimeCapabilities {
  executionBoundary:
    | "offline-demo"
    | "host-process"
    | "application-container"
    | "disposable-container";
  workspaceIsolation: "logical-owner-directory" | "filtered-owner-projection";
  networkPolicy:
    | "offline-demo-network-disabled"
    | "middleware-and-codex-policy"
    | "application-container-network"
    | "container-network-blocked"
    | "local-debug-network";
  credentialPolicy:
    | "offline-demo-no-credentials"
    | "server-process-environment"
    | "application-container-environment"
    | "not-forwarded"
    | "local-debug-forwarded";
  readOnlyRoot: boolean;
  capabilitiesDropped: boolean;
  noNewPrivileges: boolean;
  resourceLimits: boolean;
  protectedFileProjection: boolean;
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

export interface CapabilityDiscovery {
  required: boolean;
  capability: CapabilityId | null;
  capabilityLabel: string | null;
  providerDepartment: Department | null;
  sanitizedTaskSummary: string;
  taskDigest: string;
  personalInformation: PersonalInformationAssessment;
}

export interface DelegationRecipientView {
  id: string;
  displayName: string;
  department: Department;
}

export interface DelegationRequestView {
  id: string;
  box: "incoming" | "outgoing";
  requiredCapability: CapabilityId;
  capabilityLabel: string;
  providerDepartment: Department;
  sanitizedTaskSummary: string;
  personalInformation: PersonalInformationAssessment;
  taskDigest: string;
  status: DelegationRequestStatus;
  createdAt: string;
  expiresAt: string;
  contractId: string | null;
  requester?: {
    displayName: string;
    department: Department;
  };
}

interface DelegationContractViewBase {
  id: string;
  source: "owner" | "request";
  requiredCapability: CapabilityId;
  capabilityLabel: string;
  providerDepartment: Department;
  sanitizedTaskSummary: string;
  personalInformation: PersonalInformationAssessment;
  allowedActions: ["agent.invoke"];
  resultVisibility: "final_output_only";
  maximumUses: 1;
  usesConsumed: number;
  remainingUses: number;
  approvedInputCount: number;
  status: DelegationContractStatus;
  policyReasonCode:
    | "DELEGATION_ACTIVE"
    | "DELEGATION_CONSUMED"
    | "DELEGATION_REVOKED"
    | "DELEGATION_EXPIRED";
  createdAt: string;
  expiresAt: string;
  consumedAt: string | null;
  revokedAt: string | null;
}

export interface GranteeDelegationContractView
  extends DelegationContractViewBase {
  box: "incoming";
  providerLabel: string;
  approvedPrompt: string;
}

export interface OwnerDelegationContractView
  extends DelegationContractViewBase {
  box: "outgoing";
  grantee: DelegationRecipientView;
  agent: { id: string; name: string };
  approvedResources: Array<{ id: string; name: string; fileName: string }>;
}

export type DelegationContractView =
  | GranteeDelegationContractView
  | OwnerDelegationContractView;

export interface DelegatedRunView {
  id: string;
  status: RunStatus;
  output: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
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
