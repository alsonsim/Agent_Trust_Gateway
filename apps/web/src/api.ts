import type {
  Agent,
  AgentRun,
  AuthConfiguration,
  AuthorizationDecision,
  HumanPrincipal,
  Message,
  ProtectedResourceRead,
  ProtectedResourceSummary,
  SystemInfo,
  WorkspaceFileRead,
} from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string | null = null,
    public readonly decision: AuthorizationDecision | null = null,
    public readonly details: unknown = null,
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
  const data = (await response.json().catch(() => ({}))) as T & {
    error?: string;
    code?: string;
    decision?: AuthorizationDecision;
    details?: unknown;
  };
  if (!response.ok) {
    throw new ApiError(
      data.error ?? "Request failed",
      response.status,
      data.code ?? null,
      data.decision ?? null,
      data.details ?? null,
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
  run: (id: string) => request<{ run: AgentRun }>("/api/runs/" + id),
  resources: () =>
    request<{ resources: ProtectedResourceSummary[] }>("/api/resources"),
  readResource: (agentId: string, resourceId: string) =>
    request<ProtectedResourceRead>(
      "/api/agents/" + agentId + "/resources/" + resourceId + "/read",
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
  authorizationDecisions: (limit = 50) =>
    request<{ decisions: AuthorizationDecision[] }>(
      "/api/authorization-decisions?limit=" + encodeURIComponent(String(limit)),
    ),
};
