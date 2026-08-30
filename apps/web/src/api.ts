import type {
  Agent,
  AgentRun,
  AuthConfiguration,
  AuthorizationDecision,
  CapabilityDiscovery,
  CapabilityId,
  DelegatedRunView,
  DelegationContractStatus,
  DelegationContractView,
  DelegationRecipientView,
  DelegationRequestView,
  GranteeDelegationContractView,
  HumanPrincipal,
  Message,
  OwnerDelegationContractView,
  ProtectedResourceRead,
  ProtectedResourceSummary,
  SystemInfo,
  WorkspaceFileRead,
} from "./types";

export interface ApiErrorBody {
  error?: string;
  code?: string;
  decision?: AuthorizationDecision;
  details?: unknown;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string | null = null,
    public readonly decision: AuthorizationDecision | null = null,
    public readonly details: unknown = null,
    public readonly body: ApiErrorBody = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
}

let legacyToken = "";

export function setLegacyToken(token: string): void {
  legacyToken = token.trim();
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const headers = {
    ...(options?.body ? { "Content-Type": "application/json" } : {}),
    ...(legacyToken ? { Authorization: "Bearer " + legacyToken } : {}),
    ...options?.headers,
  };
  const response = await fetch(url, {
    ...options,
    headers,
    credentials: "same-origin",
  });
  const data = (await response.json().catch(() => ({}))) as T & ApiErrorBody;
  if (!response.ok) {
    throw new ApiError(
      data.error ?? "Request failed",
      response.status,
      data.code ?? null,
      data.decision ?? null,
      data.details ?? null,
      data,
    );
  }
  return data;
}

export const api = {
  auth: () => request<AuthConfiguration>("/api/auth"),
  login: (email: string, password?: string) =>
    request<{ principal: HumanPrincipal }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({
        email,
        ...(password === undefined ? {} : { password }),
      }),
    }),
  logout: () =>
    request<Record<string, never>>("/api/auth/logout", {
      method: "POST",
    }),
  me: () => request<{ principal: HumanPrincipal }>("/api/me"),
  system: () => request<SystemInfo>("/api/system"),
  discoverCapability: (prompt: string) =>
    request<CapabilityDiscovery>("/api/capability-discovery", {
      method: "POST",
      body: JSON.stringify({ prompt }),
    }),
  delegationRecipients: () =>
    request<{ recipients: DelegationRecipientView[] }>(
      "/api/delegation-recipients",
    ),
  createDelegationRequest: (body: {
    requiredCapability: CapabilityId;
    prompt: string;
  }) =>
    request<{ request: DelegationRequestView; decision: AuthorizationDecision }>(
      "/api/delegation-requests",
      { method: "POST", body: JSON.stringify(body) },
    ),
  delegationRequests: (box: "incoming" | "outgoing") =>
    request<{ requests: DelegationRequestView[]; serverNow: string }>(
      "/api/delegation-requests?box=" + encodeURIComponent(box),
    ),
  approveDelegationRequest: (
    id: string,
    body: {
      agentId: string;
      approvedResourceIds: string[];
      expiresInSeconds: number;
    },
  ) =>
    request<{ contract: OwnerDelegationContractView; decision: AuthorizationDecision }>(
      "/api/delegation-requests/" + id + "/approve",
      { method: "POST", body: JSON.stringify(body) },
    ),
  rejectDelegationRequest: (id: string) =>
    request<{ request: DelegationRequestView; decision: AuthorizationDecision }>(
      "/api/delegation-requests/" + id + "/reject",
      { method: "POST" },
    ),
  createDelegationContract: (body: {
    requiredCapability: CapabilityId;
    granteeHumanId: string;
    agentId: string;
    exactPrompt: string;
    approvedResourceIds: string[];
    expiresInSeconds: number;
  }) =>
    request<{ contract: OwnerDelegationContractView; decision: AuthorizationDecision }>(
      "/api/delegation-contracts",
      { method: "POST", body: JSON.stringify(body) },
    ),
  delegationContracts: (box: "incoming" | "outgoing") =>
    request<{ contracts: DelegationContractView[]; serverNow: string }>(
      "/api/delegation-contracts?box=" + encodeURIComponent(box),
    ),
  revokeDelegationContract: (id: string) =>
    request<{ contract: OwnerDelegationContractView; decision: AuthorizationDecision }>(
      "/api/delegation-contracts/" + id + "/revoke",
      { method: "POST" },
    ),
  invokeDelegationContract: (id: string, content: string) =>
    request<{
      contract: GranteeDelegationContractView;
      decision: AuthorizationDecision;
      result: DelegatedRunView;
    }>("/api/delegation-contracts/" + id + "/invoke", {
      method: "POST",
      body: JSON.stringify({ content }),
    }),
  delegatedResult: (id: string) =>
    request<{
      contractStatus: DelegationContractStatus;
      result: DelegatedRunView | null;
      serverNow: string;
    }>("/api/delegation-contracts/" + id + "/result"),
  listAgents: () => request<{ agents: Agent[] }>("/api/agents"),
  createAgent: (body: {
    name: string;
    description: string;
    instructions: string;
  }) =>
    request<{ agent: Agent }>("/api/agents", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateAgent: (
    id: string,
    body: { name: string; description: string; instructions: string },
  ) =>
    request<{ agent: Agent }>("/api/agents/" + id, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteAgent: (id: string) =>
    request<{ archivedWorkspace: string }>("/api/agents/" + id, {
      method: "DELETE",
    }),
  startAgent: (id: string) =>
    request<{ agent: Agent }>("/api/agents/" + id + "/start", {
      method: "POST",
    }),
  stopAgent: (id: string) =>
    request<{ agent: Agent }>("/api/agents/" + id + "/stop", {
      method: "POST",
    }),
  messages: (id: string) =>
    request<{ messages: Message[] }>("/api/agents/" + id + "/messages"),
  runs: (id: string) =>
    request<{ runs: AgentRun[] }>("/api/agents/" + id + "/runs"),
  sendMessage: (id: string, content: string) =>
    request<{ run: AgentRun; message: Message }>(
      "/api/agents/" + id + "/messages",
      {
        method: "POST",
        body: JSON.stringify({ content }),
      },
    ),
  evaluateRuntimeShellAction: (id: string, command: string) =>
    request<{ decision: AuthorizationDecision }>(
      "/api/agents/" + id + "/runtime-actions/evaluate",
      {
        method: "POST",
        body: JSON.stringify({ type: "shell", command }),
      },
    ),
  run: (id: string) => request<{ run: AgentRun }>("/api/runs/" + id),
  resources: () =>
    request<{ resources: ProtectedResourceSummary[] }>("/api/resources"),
  readResource: (agentId: string, resourceId: string) =>
    request<ProtectedResourceRead>(
      "/api/agents/" + agentId + "/resources/" + resourceId + "/read",
      { method: "POST" },
    ),
  demonstrateCrossOwnerResourceDenial: (agentId: string) =>
    request<never>(
      "/api/agents/" + agentId + "/resources/cross-owner-demo",
      { method: "POST" },
    ),
  readWorkspaceFile: (agentId: string, path: string) =>
    request<WorkspaceFileRead>("/api/agents/" + agentId + "/files/read", {
      method: "POST",
      body: JSON.stringify({ path }),
    }),
  revokeAgent: (id: string) =>
    request<{ agent: Agent; decision: AuthorizationDecision }>(
      "/api/agents/" + id + "/revoke",
      { method: "POST" },
    ),
  probeCrossOwnerAgent: () =>
    request<{ decision: AuthorizationDecision }>(
      "/api/authorization-probes/cross-owner-agent",
      { method: "POST" },
    ),
  authorizationDecisions: (limit = 50) =>
    request<{ decisions: AuthorizationDecision[] }>(
      "/api/authorization-decisions?limit=" + encodeURIComponent(String(limit)),
    ),
};
