import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, setLegacyToken } from "./api";
import type {
  Agent,
  AgentRun,
  AuthConfiguration,
  AuthorizationDecision,
  Department,
  HumanPrincipal,
  Message,
  ProtectedResourceRead,
  ProtectedResourceSummary,
  SystemInfo,
} from "./types";

const starterPrompts = [
  "Create a small TypeScript CLI that prints a weather summary from sample JSON.",
  "Inspect this workspace and explain what you would improve first.",
  "Build a responsive single-page todo app with tests.",
];

const emptyForm = {
  name: "",
  description: "",
  instructions:
    "Help me build and test software in this workspace. Keep changes small and explain the result.",
};

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function departmentLabel(department: Department): string {
  if (department === "hr") return "HR";
  return department.slice(0, 1).toUpperCase() + department.slice(1);
}

function initials(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.slice(0, 1).toUpperCase())
    .join("");
}

function StatusPill({ status }: { status: Agent["status"] }) {
  return (
    <span className={"status status-" + status}>
      <span className="status-dot" />
      {status}
    </span>
  );
}

function Spinner() {
  return <span className="spinner" aria-label="Loading" />;
}

function DecisionPill({ decision }: { decision: AuthorizationDecision["decision"] }) {
  return (
    <span className={"decision-pill decision-" + decision}>
      <span />
      {decision.toUpperCase()}
    </span>
  );
}

export default function App() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [prompt, setPrompt] = useState("");
  const [activeRun, setActiveRun] = useState<AgentRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authConfig, setAuthConfig] = useState<AuthConfiguration | null>(null);
  const [authChecking, setAuthChecking] = useState(true);
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [principal, setPrincipal] = useState<HumanPrincipal | null>(null);
  const [authInput, setAuthInput] = useState("");
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [activeView, setActiveView] = useState<"playground" | "access">("playground");
  const [resources, setResources] = useState<ProtectedResourceSummary[]>([]);
  const [decisions, setDecisions] = useState<AuthorizationDecision[]>([]);
  const [latestDecision, setLatestDecision] = useState<AuthorizationDecision | null>(null);
  const [resourceRead, setResourceRead] = useState<
    ProtectedResourceRead["resource"] | null
  >(null);
  const [securityBusyId, setSecurityBusyId] = useState<string | null>(null);
  const [securityError, setSecurityError] = useState<string | null>(null);
  const messageEnd = useRef<HTMLDivElement>(null);
  const selectedIdRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const pollingRunIds = useRef(new Set<string>());
  const sessionGenerationRef = useRef(0);
  selectedIdRef.current = selectedId;

  const selected = useMemo(
    () => agents.find((agent) => agent.id === selectedId) ?? null,
    [agents, selectedId],
  );

  const resetAuthenticatedState = useCallback(() => {
    selectedIdRef.current = null;
    setPrincipal(null);
    setAgents([]);
    setSelectedId(null);
    setMessages([]);
    setSystem(null);
    setActiveRun(null);
    setShowCreate(false);
    setShowSettings(false);
    setActiveView("playground");
    setResources([]);
    setDecisions([]);
    setLatestDecision(null);
    setResourceRead(null);
    setSecurityBusyId(null);
    setSecurityError(null);
  }, []);

  const invalidateSession = useCallback(
    (message: string) => {
      sessionGenerationRef.current += 1;
      resetAuthenticatedState();
      setLegacyToken("");
      setAuthError(message);
    },
    [resetAuthenticatedState],
  );

  const refreshAgents = useCallback(async () => {
    const generation = sessionGenerationRef.current;
    const { agents: next } = await api.listAgents();
    if (!mountedRef.current || generation !== sessionGenerationRef.current) return;
    setAgents(next);
    setSelectedId((current) =>
      current && next.some((agent) => agent.id === current)
        ? current
        : (next[0]?.id ?? null),
    );
  }, []);

  const refreshMessages = useCallback(async (agentId: string) => {
    const generation = sessionGenerationRef.current;
    const result = await api.messages(agentId);
    if (
      mountedRef.current &&
      generation === sessionGenerationRef.current &&
      selectedIdRef.current === agentId
    ) {
      setMessages(result.messages);
    }
  }, []);

  const refreshDecisions = useCallback(async () => {
    const generation = sessionGenerationRef.current;
    const result = await api.authorizationDecisions(50);
    if (mountedRef.current && generation === sessionGenerationRef.current) {
      setDecisions(result.decisions);
    }
  }, []);

  const loadPrincipalData = useCallback(
    async (nextPrincipal: HumanPrincipal) => {
      const generation = sessionGenerationRef.current + 1;
      sessionGenerationRef.current = generation;
      resetAuthenticatedState();
      const [agentResult, nextSystem, resourceResult, decisionResult] = await Promise.all([
        api.listAgents(),
        api.system(),
        api.resources(),
        api.authorizationDecisions(50),
      ]);
      if (!mountedRef.current || generation !== sessionGenerationRef.current) return;
      setPrincipal(nextPrincipal);
      setAgents(agentResult.agents);
      setSelectedId(agentResult.agents[0]?.id ?? null);
      setSystem(nextSystem);
      setResources(resourceResult.resources);
      setDecisions(decisionResult.decisions);
    },
    [resetAuthenticatedState],
  );

  const handleRequestError = useCallback(
    (reason: unknown, surface: "main" | "security" = "main") => {
      if (reason instanceof ApiError && reason.status === 401) {
        invalidateSession("Your session expired. Sign in again to continue.");
        return;
      }
      if (
        reason instanceof ApiError &&
        reason.status === 403 &&
        reason.code === "AUTHORIZATION_DENIED" &&
        reason.decision
      ) {
        setLatestDecision(reason.decision);
        setResourceRead(null);
        setSecurityError(null);
        setActiveView("access");
        void refreshDecisions().catch(() => undefined);
        return;
      }
      const message = reason instanceof Error ? reason.message : String(reason);
      if (surface === "security") setSecurityError(message);
      else setError(message);
    },
    [invalidateSession, refreshDecisions],
  );

  useEffect(() => {
    let cancelled = false;
    mountedRef.current = true;
    setAuthChecking(true);
    setAuthError(null);
    void (async () => {
      try {
        const nextAuthConfig = await api.auth();
        if (cancelled) return;
        setAuthConfig(nextAuthConfig);
        if (nextAuthConfig.mode === "legacy" && nextAuthConfig.legacyTokenRequired) {
          resetAuthenticatedState();
          return;
        }
        try {
          const { principal: restoredPrincipal } = await api.me();
          if (!cancelled) await loadPrincipalData(restoredPrincipal);
        } catch (reason) {
          if (reason instanceof ApiError && reason.status === 401) {
            if (!cancelled) resetAuthenticatedState();
          } else {
            throw reason;
          }
        }
      } catch (reason) {
        if (!cancelled) {
          setAuthError(reason instanceof Error ? reason.message : String(reason));
        }
      } finally {
        if (!cancelled) setAuthChecking(false);
      }
    })();
    return () => {
      cancelled = true;
      mountedRef.current = false;
      sessionGenerationRef.current += 1;
    };
  }, [loadPrincipalData, resetAuthenticatedState]);

  useEffect(() => {
    const generation = sessionGenerationRef.current;
    setActiveRun(null);
    setShowSettings(false);
    setLatestDecision(null);
    setResourceRead(null);
    setSecurityError(null);
    if (!principal || !selectedId) {
      setMessages([]);
      return;
    }
    void Promise.all([refreshMessages(selectedId), api.runs(selectedId)])
      .then(([, result]) => {
        if (
          generation !== sessionGenerationRef.current ||
          selectedIdRef.current !== selectedId
        ) {
          return;
        }
        const latest = result.runs[0] ?? null;
        setActiveRun(latest);
        if (latest && ["queued", "running"].includes(latest.status)) {
          void pollRun(latest.id, selectedId, generation).catch((reason) =>
            handleRequestError(reason),
          );
        }
      })
      .catch((reason) => handleRequestError(reason));
  }, [handleRequestError, principal, refreshMessages, selectedId]);

  useEffect(() => {
    if (selected) {
      setForm({
        name: selected.name,
        description: selected.description,
        instructions: selected.instructions,
      });
    }
  }, [selected]);

  useEffect(() => {
    messageEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, activeRun]);

  const createAgent = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { agent } = await api.createAgent(form);
      await refreshAgents();
      setSelectedId(agent.id);
      setShowCreate(false);
      setForm(emptyForm);
      void refreshDecisions().catch(() => undefined);
    } catch (reason) {
      handleRequestError(reason);
    } finally {
      setBusy(false);
    }
  };

  const saveAgent = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await api.updateAgent(selected.id, form);
      await refreshAgents();
      setShowSettings(false);
      void refreshDecisions().catch(() => undefined);
    } catch (reason) {
      handleRequestError(reason);
    } finally {
      setBusy(false);
    }
  };

  const toggleAgent = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      if (selected.status === "stopped") {
        await api.startAgent(selected.id);
      } else {
        await api.stopAgent(selected.id);
      }
      await refreshAgents();
      void refreshDecisions().catch(() => undefined);
    } catch (reason) {
      handleRequestError(reason);
    } finally {
      setBusy(false);
    }
  };

  const deleteAgent = async () => {
    if (!selected) return;
    if (!window.confirm("Delete " + selected.name + "? Its workspace will be archived.")) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.deleteAgent(selected.id);
      await refreshAgents();
      void refreshDecisions().catch(() => undefined);
    } catch (reason) {
      handleRequestError(reason);
    } finally {
      setBusy(false);
    }
  };

  const pollRun = async (
    runId: string,
    agentId: string,
    generation = sessionGenerationRef.current,
  ) => {
    if (pollingRunIds.current.has(runId)) return;
    pollingRunIds.current.add(runId);
    try {
      while (mountedRef.current && generation === sessionGenerationRef.current) {
        await new Promise((resolve) => window.setTimeout(resolve, 900));
        if (!mountedRef.current || generation !== sessionGenerationRef.current) return;
        const result = await api.run(runId);
        if (generation !== sessionGenerationRef.current) return;
        if (selectedIdRef.current === agentId) setActiveRun(result.run);
        if (!["queued", "running"].includes(result.run.status)) {
          await Promise.all([refreshMessages(agentId), refreshAgents()]);
          void refreshDecisions().catch(() => undefined);
          return;
        }
      }
    } finally {
      pollingRunIds.current.delete(runId);
    }
  };

  const sendMessage = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected || !prompt.trim()) return;
    const content = prompt.trim();
    const generation = sessionGenerationRef.current;
    setPrompt("");
    setError(null);
    try {
      const result = await api.sendMessage(selected.id, content);
      if (generation !== sessionGenerationRef.current) return;
      if (selectedIdRef.current === selected.id) {
        setMessages((current) => [...current, result.message]);
        setActiveRun(result.run);
      }
      setAgents((current) =>
        current.map((agent) =>
          agent.id === selected.id ? { ...agent, status: "busy" } : agent,
        ),
      );
      void refreshDecisions().catch(() => undefined);
      await pollRun(result.run.id, selected.id, generation);
    } catch (reason) {
      handleRequestError(reason);
      setActiveRun(null);
      if (!(reason instanceof ApiError && reason.status === 401)) {
        void refreshAgents().catch(() => undefined);
      }
    }
  };

  const attemptResourceRead = async (resourceId: string) => {
    if (!selected) return;
    const generation = sessionGenerationRef.current;
    const agentId = selected.id;
    setSecurityBusyId(resourceId);
    setSecurityError(null);
    setLatestDecision(null);
    setResourceRead(null);
    try {
      const result = await api.readResource(agentId, resourceId);
      if (
        generation !== sessionGenerationRef.current ||
        selectedIdRef.current !== agentId
      ) {
        return;
      }
      setResourceRead(result.resource);
      setLatestDecision(result.decision);
      void refreshDecisions().catch((reason) => handleRequestError(reason, "security"));
    } catch (reason) {
      if (generation === sessionGenerationRef.current) {
        handleRequestError(reason, "security");
      }
    } finally {
      if (generation === sessionGenerationRef.current) setSecurityBusyId(null);
    }
  };

  const refreshDecisionTimeline = async () => {
    const generation = sessionGenerationRef.current;
    setSecurityBusyId("audit");
    setSecurityError(null);
    try {
      await refreshDecisions();
    } catch (reason) {
      if (generation === sessionGenerationRef.current) {
        handleRequestError(reason, "security");
      }
    } finally {
      if (generation === sessionGenerationRef.current) setSecurityBusyId(null);
    }
  };

  const loginAs = async (email: string, password?: string) => {
    setAuthBusy(true);
    setAuthError(null);
    try {
      const { principal: nextPrincipal } = await api.login(email.trim(), password);
      await loadPrincipalData(nextPrincipal);
      setLoginEmail("");
      setLoginPassword("");
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) {
        setAuthError("The email or password is not valid.");
      } else {
        setAuthError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      setAuthBusy(false);
    }
  };

  const submitCredentials = async (event: React.FormEvent) => {
    event.preventDefault();
    await loginAs(loginEmail, loginPassword);
  };

  const unlockLegacy = async (event: React.FormEvent) => {
    event.preventDefault();
    setAuthBusy(true);
    setAuthError(null);
    setLegacyToken(authInput);
    try {
      const { principal: nextPrincipal } = await api.me();
      await loadPrincipalData(nextPrincipal);
      setAuthInput("");
    } catch (reason) {
      setLegacyToken("");
      if (reason instanceof ApiError && reason.status === 401) {
        setAuthError("The access token is not valid.");
      } else {
        setAuthError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      setAuthBusy(false);
    }
  };

  const logout = async () => {
    setAuthBusy(true);
    setAuthError(null);
    const logoutRequest = api.logout();
    sessionGenerationRef.current += 1;
    resetAuthenticatedState();
    try {
      await logoutRequest;
    } catch (reason) {
      setAuthError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLegacyToken("");
      setAuthBusy(false);
    }
  };

  if (authChecking || authConfig === null) {
    return (
      <main className="auth-screen">
        <section className="auth-card" aria-live="polite">
          <div className="brand-mark">A</div>
          <span className="eyebrow">Agent Launchpad</span>
          <h1>Connecting to the control plane</h1>
          {authError ? (
            <div className="error-banner" role="alert">{authError}</div>
          ) : (
            <Spinner />
          )}
        </section>
      </main>
    );
  }

  if (!principal && authConfig.mode === "legacy") {
    return (
      <main className="auth-screen">
        <form className="auth-card" onSubmit={unlockLegacy}>
          <div className="brand-mark">A</div>
          <span className="eyebrow">Agent Launchpad</span>
          <h1>Enter the access token</h1>
          <p>This shared demo token is configured by the platform operator.</p>
          {authError && <div className="error-banner" role="alert">{authError}</div>}
          <label>
            Access token
            <input
              autoFocus
              type="password"
              value={authInput}
              onChange={(event) => setAuthInput(event.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          <button
            className="button button-primary"
            disabled={authBusy || !authInput.trim()}
          >
            {authBusy ? <Spinner /> : "Open Launchpad"}
          </button>
        </form>
      </main>
    );
  }

  if (!principal && authConfig.mode === "demo") {
    return (
      <main className="auth-screen">
        <section className="auth-card auth-card-wide" aria-labelledby="team-picker-title">
          <div className="brand-mark">A</div>
          <span className="eyebrow">Agent Trust Gateway</span>
          <h1 id="team-picker-title">Choose a demo team</h1>
          <p>
            Each identity can create and use only its own Agents. Pick a team to test
            real allow and deny decisions.
          </p>
          {authError && <div className="error-banner" role="alert">{authError}</div>}
          <div className="demo-user-grid">
            {authConfig.demoUsers.map((user) => (
              <button
                type="button"
                className="demo-user-card"
                key={user.id}
                onClick={() => void loginAs(user.email)}
                disabled={authBusy}
                aria-label={"Sign in as " + user.displayName}
              >
                <span className={"team-avatar team-" + user.department}>
                  {initials(user.displayName)}
                </span>
                <strong>{user.displayName}</strong>
                <span>{departmentLabel(user.department)} identity</span>
                <small>{user.email}</small>
              </button>
            ))}
          </div>
          {authBusy && (
            <div className="auth-progress" aria-live="polite">
              <Spinner /> Signing in…
            </div>
          )}
        </section>
      </main>
    );
  }

  if (!principal) {
    return (
      <main className="auth-screen">
        <form className="auth-card" onSubmit={submitCredentials}>
          <div className="brand-mark">A</div>
          <span className="eyebrow">Agent Trust Gateway</span>
          <h1>Sign in to your team</h1>
          <p>Use the Finance, HR, or Research account created in Supabase.</p>
          {authError && <div className="error-banner" role="alert">{authError}</div>}
          <label>
            Email
            <input
              autoFocus
              type="email"
              value={loginEmail}
              onChange={(event) => setLoginEmail(event.target.value)}
              autoComplete="username"
              required
            />
          </label>
          <label>
            Password
            <input
              type="password"
              value={loginPassword}
              onChange={(event) => setLoginPassword(event.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          <button
            className="button button-primary"
            disabled={authBusy || !loginEmail.trim() || !loginPassword}
          >
            {authBusy ? <Spinner /> : "Sign in"}
          </button>
        </form>
      </main>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">A</div>
          <div>
            <strong>Agent Launchpad</strong>
            <span>
              {system?.runtimeProvider === "container"
                ? "Local container · Codex CLI"
                : "ECS / Docker · Codex CLI"}
            </span>
          </div>
        </div>

        <button
          className="button button-primary create-button"
          onClick={() => {
            setForm(emptyForm);
            setShowCreate(true);
          }}
        >
          <span>＋</span> Create Agent
        </button>

        <div className="sidebar-label">
          <span>Your Agents</span>
          <span>{agents.length}</span>
        </div>
        <nav className="agent-list">
          {agents.map((agent) => (
            <button
              className={"agent-card " + (agent.id === selectedId ? "selected" : "")}
              key={agent.id}
              onClick={() => setSelectedId(agent.id)}
            >
              <div className="agent-avatar">{agent.name.slice(0, 1).toUpperCase()}</div>
              <div className="agent-card-copy">
                <strong>{agent.name}</strong>
                <span>{agent.description || "Coding Agent"}</span>
              </div>
              <span className={"mini-dot mini-" + agent.status} />
            </button>
          ))}
          {agents.length === 0 && (
            <div className="empty-sidebar">
              <span>◇</span>
              Create your first coding Agent.
            </div>
          )}
        </nav>

        <div className="principal-card">
          <span className={"principal-avatar team-" + principal.department}>
            {initials(principal.displayName)}
          </span>
          <div className="principal-copy">
            <span className="eyebrow">Signed in</span>
            <strong>{principal.displayName}</strong>
            <span>{principal.email}</span>
          </div>
          <button
            type="button"
            className="principal-logout"
            onClick={() => void logout()}
            disabled={authBusy}
            aria-label="Sign out"
            title="Sign out"
          >
            ↪
          </button>
        </div>

        <div className="runtime-card">
          <span className="eyebrow">Runtime</span>
          <strong>{system?.runtime ?? "Checking…"}</strong>
          <span>
            {system?.arkModel ?? "Ark model not configured"}
            {system?.containerEngine ? " · " + system.containerEngine : ""}
          </span>
        </div>
      </aside>

      <main className="main">
        {!system?.arkConfigured || !system?.codexAvailable ? (
          <div className="config-banner">
            <span>!</span>
            <div>
              <strong>Runtime configuration needed</strong>
              <p>
                {!system?.arkConfigured
                  ? "Set ARK_API_KEY and ARK_MODEL in .env before using the Playground."
                  : system.runtimeProvider === "container"
                    ? "The local container engine or Agent Runtime image is unavailable. Rerun npm run poc."
                    : "Codex CLI was not found. Use the Docker image or install @openai/codex."}
              </p>
            </div>
          </div>
        ) : null}

        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button onClick={() => setError(null)}>×</button>
          </div>
        )}

        {selected ? (
          <>
            <header className="agent-header">
              <div>
                <div className="header-title-row">
                  <h1>{selected.name}</h1>
                  <StatusPill status={selected.status} />
                  <span className="owner-pill">
                    {departmentLabel(principal.department)} owned
                  </span>
                </div>
                <p>{selected.description || "A Codex coding Agent in an isolated workspace."}</p>
              </div>
              <div className="header-actions">
                <button
                  className="button button-ghost"
                  onClick={() => setShowSettings((value) => !value)}
                  disabled={busy || selected.status === "busy"}
                >
                  Settings
                </button>
                <button
                  className="button button-ghost"
                  onClick={toggleAgent}
                  disabled={busy}
                >
                  {selected.status === "stopped" ? "Start" : "Stop"}
                </button>
                <button
                  className="button button-danger"
                  onClick={deleteAgent}
                  disabled={busy || selected.status === "busy"}
                >
                  Delete
                </button>
              </div>
            </header>

            {showSettings && (
              <form className="settings-panel" onSubmit={saveAgent}>
                <div className="settings-title">
                  <div>
                    <span className="eyebrow">Agent configuration</span>
                    <h2>Instructions and identity</h2>
                  </div>
                  <button type="button" onClick={() => setShowSettings(false)}>×</button>
                </div>
                <div className="owner-note">
                  <span className={"team-avatar team-" + principal.department}>
                    {initials(principal.displayName)}
                  </span>
                  <div>
                    <strong>Owned by {principal.displayName}</strong>
                    <span>
                      Ownership is assigned from the signed-in identity and cannot be edited.
                    </span>
                  </div>
                </div>
                <div className="form-grid">
                  <label>
                    Name
                    <input
                      value={form.name}
                      onChange={(event) => setForm({ ...form, name: event.target.value })}
                      required
                      maxLength={80}
                    />
                  </label>
                  <label>
                    Description
                    <input
                      value={form.description}
                      onChange={(event) =>
                        setForm({ ...form, description: event.target.value })
                      }
                      maxLength={500}
                    />
                  </label>
                </div>
                <label>
                  System instructions
                  <textarea
                    value={form.instructions}
                    onChange={(event) =>
                      setForm({ ...form, instructions: event.target.value })
                    }
                    rows={5}
                    maxLength={10_000}
                  />
                </label>
                <div className="panel-footer">
                  <code>{selected.workspacePath}</code>
                  <button className="button button-primary" disabled={busy}>
                    {busy ? <Spinner /> : "Save changes"}
                  </button>
                </div>
              </form>
            )}

            <div className="agent-tabs" role="tablist" aria-label="Agent workspace views">
              <button
                type="button"
                role="tab"
                id="playground-tab"
                aria-selected={activeView === "playground"}
                aria-controls="playground-panel"
                className={activeView === "playground" ? "active" : ""}
                onClick={() => setActiveView("playground")}
              >
                Playground
              </button>
              <button
                type="button"
                role="tab"
                id="access-tab"
                aria-selected={activeView === "access"}
                aria-controls="access-panel"
                className={activeView === "access" ? "active" : ""}
                onClick={() => setActiveView("access")}
              >
                Access &amp; audit
                {decisions.some((decision) => decision.decision === "deny") && (
                  <span className="tab-indicator" aria-label="Denied decisions recorded" />
                )}
              </button>
            </div>

            {activeView === "playground" ? (
            <section
              className="playground"
              id="playground-panel"
              role="tabpanel"
              aria-labelledby="playground-tab"
            >
              <div className="playground-topbar">
                <div>
                  <span className="eyebrow">Playground</span>
                  <h2>Build something with your Agent</h2>
                </div>
                <div className="session-info">
                  <span className="pulse" />
                  {selected.codexThreadId ? "Session connected" : "New session"}
                </div>
              </div>

              <div className="messages">
                {messages.length === 0 && !activeRun ? (
                  <div className="welcome">
                    <div className="welcome-orbit">
                      <div>⌁</div>
                    </div>
                    <h3>What should {selected.name} build?</h3>
                    <p>
                      The Agent can inspect files, write code, run commands, and continue the
                      same Codex session across messages.
                    </p>
                    <div className="prompt-grid">
                      {starterPrompts.map((item) => (
                        <button key={item} onClick={() => setPrompt(item)}>
                          <span>↗</span>
                          {item}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  messages.map((message) => (
                    <article className={"message message-" + message.role} key={message.id}>
                      <div className="message-meta">
                        <strong>{message.role === "user" ? "You" : selected.name}</strong>
                        <span>{formatTime(message.createdAt)}</span>
                      </div>
                      <div className="message-body">{message.content}</div>
                    </article>
                  ))
                )}
                {activeRun && ["queued", "running"].includes(activeRun.status) && (
                  <article className="message message-assistant thinking">
                    <div className="message-meta">
                      <strong>{selected.name}</strong>
                      <span>working in the Agent workspace</span>
                    </div>
                    <div className="thinking-row">
                      <Spinner />
                      Codex is reading, editing, or running commands…
                    </div>
                  </article>
                )}
                {activeRun?.status === "failed" && (
                  <article className="run-error">
                    <strong>Run failed</strong>
                    <span>{activeRun.error}</span>
                  </article>
                )}
                <div ref={messageEnd} />
              </div>

              <form className="composer" onSubmit={sendMessage}>
                <textarea
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                  placeholder={
                    selected.status === "stopped"
                      ? "Start this Agent to continue…"
                      : "Describe what you want the Agent to do…"
                  }
                  disabled={
                    selected.status === "stopped" ||
                    selected.status === "busy" ||
                    activeRun != null && ["queued", "running"].includes(activeRun.status)
                  }
                  rows={3}
                />
                <div className="composer-footer">
                  <span>
                    Enter to send · Shift + Enter for newline · {system?.codexSandboxMode ?? "checking sandbox"}
                  </span>
                  <button
                    className="send-button"
                    disabled={
                      !prompt.trim() ||
                      selected.status === "stopped" ||
                      selected.status === "busy" ||
                      (activeRun != null && ["queued", "running"].includes(activeRun.status))
                    }
                    aria-label="Send message"
                  >
                    ↑
                  </button>
                </div>
              </form>
            </section>
            ) : (
              <section
                className="security-panel"
                id="access-panel"
                role="tabpanel"
                aria-labelledby="access-tab"
              >
                <div className="security-header">
                  <div>
                    <span className="eyebrow">Identity authorization middleware</span>
                    <h2>Test the trusted access boundary</h2>
                    <p>
                      Every read goes to the server. The interface displays the persisted
                      decision; it never grants access itself.
                    </p>
                  </div>
                  <span className="enforcement-badge">
                    <span /> Backend enforced
                  </span>
                </div>

                <div className="delegation-strip" aria-label="Authorization delegation path">
                  <div>
                    <span className={"team-avatar team-" + principal.department}>
                      {initials(principal.displayName)}
                    </span>
                    <span>
                      Human
                      <strong>{principal.displayName}</strong>
                    </span>
                  </div>
                  <span className="delegation-arrow">→</span>
                  <div>
                    <span className="agent-avatar">{selected.name.slice(0, 1).toUpperCase()}</span>
                    <span>
                      Agent
                      <strong>{selected.name}</strong>
                    </span>
                  </div>
                  <span className="delegation-arrow">→</span>
                  <div>
                    <span className="boundary-icon">◆</span>
                    <span>
                      Action
                      <strong>resource.read</strong>
                    </span>
                  </div>
                </div>

                {securityError && (
                  <div className="error-banner security-error" role="alert">
                    <span>{securityError}</span>
                    <button onClick={() => setSecurityError(null)} aria-label="Dismiss error">
                      ×
                    </button>
                  </div>
                )}

                <div className="security-layout">
                  <div className="resource-section">
                    <div className="section-heading">
                      <div>
                        <span className="eyebrow">Protected fixtures</span>
                        <h3>Finance, HR, and Research files</h3>
                      </div>
                      <span>{resources.length} resources</span>
                    </div>
                    <div className="resource-grid">
                      {resources.map((resource) => (
                        <article
                          className={"resource-card resource-" + resource.ownerDepartment}
                          key={resource.id}
                        >
                          <div className="resource-card-top">
                            <span className={"team-avatar team-" + resource.ownerDepartment}>
                              {departmentLabel(resource.ownerDepartment).slice(0, 1)}
                            </span>
                            <span className="resource-owner">
                              {departmentLabel(resource.ownerDepartment)}
                            </span>
                          </div>
                          <h4>{resource.name}</h4>
                          <p id={"resource-description-" + resource.id}>
                            {resource.description}
                          </p>
                          <code>{resource.fileName}</code>
                          <button
                            type="button"
                            className="button button-resource"
                            onClick={() => void attemptResourceRead(resource.id)}
                            disabled={securityBusyId !== null}
                            aria-describedby={"resource-description-" + resource.id}
                          >
                            {securityBusyId === resource.id ? <Spinner /> : "Read through middleware"}
                          </button>
                        </article>
                      ))}
                    </div>
                    {resources.length === 0 && (
                      <div className="security-empty">No protected resources are configured.</div>
                    )}
                  </div>

                  <aside className="decision-card" aria-live="polite" aria-atomic="true">
                    <div className="section-heading">
                      <div>
                        <span className="eyebrow">Latest result</span>
                        <h3>Policy decision</h3>
                      </div>
                      {latestDecision && <DecisionPill decision={latestDecision.decision} />}
                    </div>
                    {latestDecision ? (
                      <>
                        <dl className="decision-details">
                          <div>
                            <dt>Target</dt>
                            <dd>{latestDecision.targetLabel}</dd>
                          </div>
                          <div>
                            <dt>Actor</dt>
                            <dd>{latestDecision.agentName ?? principal.displayName}</dd>
                          </div>
                          <div>
                            <dt>Reason</dt>
                            <dd>{latestDecision.reason}</dd>
                          </div>
                          <div>
                            <dt>Decision ID</dt>
                            <dd><code>{latestDecision.id}</code></dd>
                          </div>
                        </dl>
                        {latestDecision.decision === "allow" && resourceRead && (
                          <div className="resource-content">
                            <span>
                              <strong>{resourceRead.summary.fileName}</strong>
                              Server-returned content
                            </span>
                            <pre>{resourceRead.content}</pre>
                          </div>
                        )}
                        {latestDecision.decision === "deny" && (
                          <div className="denial-proof">
                            Protected content was not returned. The denial was recorded by the
                            middleware.
                          </div>
                        )}
                      </>
                    ) : (
                      <div className="decision-placeholder">
                        <span>◇</span>
                        Choose any resource to produce a real ALLOW or DENY decision.
                      </div>
                    )}
                  </aside>
                </div>

                <div className="audit-section">
                  <div className="section-heading">
                    <div>
                      <span className="eyebrow">Persisted evidence</span>
                      <h3>Authorization decision timeline</h3>
                    </div>
                    <button
                      type="button"
                      className="button button-ghost audit-refresh"
                      onClick={() => void refreshDecisionTimeline()}
                      disabled={securityBusyId !== null}
                    >
                      {securityBusyId === "audit" ? <Spinner /> : "Refresh"}
                    </button>
                  </div>
                  {decisions.length > 0 ? (
                    <ol className="audit-list">
                      {decisions.map((decision) => (
                        <li key={decision.id}>
                          <span className={"audit-marker audit-marker-" + decision.decision} />
                          <div className="audit-main">
                            <div>
                              <DecisionPill decision={decision.decision} />
                              <strong>{decision.action}</strong>
                              <span>{decision.targetLabel}</span>
                            </div>
                            <p>{decision.reason}</p>
                            <small>
                              {decision.humanEmail}
                              {decision.agentName ? " · " + decision.agentName : ""}
                              {" · " + formatDateTime(decision.createdAt)}
                            </small>
                          </div>
                          <code title={decision.requestId}>{decision.requestId.slice(0, 8)}</code>
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <div className="security-empty">
                      No decisions yet. Read a protected fixture to create the first event.
                    </div>
                  )}
                </div>
              </section>
            )}
          </>
        ) : (
          <div className="no-agent">
            <div className="no-agent-art">A</div>
            <span className="eyebrow">Agent Launchpad</span>
            <h1>Your runtime is ready for an Agent.</h1>
            <p>Create a workspace, give Codex a job, and continue the conversation here.</p>
            <button
              className="button button-primary"
              onClick={() => {
                setForm(emptyForm);
                setShowCreate(true);
              }}
            >
              Create your first Agent
            </button>
          </div>
        )}
      </main>

      {showCreate && (
        <div className="modal-backdrop" onMouseDown={() => setShowCreate(false)}>
          <form
            className="modal"
            onSubmit={createAgent}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="modal-heading">
              <div>
                <span className="eyebrow">New workspace</span>
                <h2>Create an Agent</h2>
                <p>Each Agent gets a persistent folder and a resumable Codex session.</p>
              </div>
              <button type="button" onClick={() => setShowCreate(false)}>×</button>
            </div>
            <div className="owner-note owner-note-modal">
              <span className={"team-avatar team-" + principal.department}>
                {initials(principal.displayName)}
              </span>
              <div>
                <strong>{principal.displayName} will own this Agent</strong>
                <span>The backend derives ownership from your authenticated session.</span>
              </div>
            </div>
            <label>
              Name
              <input
                autoFocus
                placeholder="Frontend Builder"
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                required
                maxLength={80}
              />
            </label>
            <label>
              Description
              <input
                placeholder="Builds polished React prototypes"
                value={form.description}
                onChange={(event) =>
                  setForm({ ...form, description: event.target.value })
                }
                maxLength={500}
              />
            </label>
            <label>
              Instructions
              <textarea
                value={form.instructions}
                onChange={(event) =>
                  setForm({ ...form, instructions: event.target.value })
                }
                rows={6}
                maxLength={10_000}
              />
            </label>
            <div className="modal-footer">
              <button
                type="button"
                className="button button-ghost"
                onClick={() => setShowCreate(false)}
              >
                Cancel
              </button>
              <button className="button button-primary" disabled={busy}>
                {busy ? <Spinner /> : "Create Agent"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
