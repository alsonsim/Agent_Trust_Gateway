import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "../api";
import type {
  Agent,
  AuthorizationDecision,
  CapabilityDiscovery,
  CapabilityId,
  DelegatedRunView,
  DelegationContractStatus,
  DelegationRecipientView,
  DelegationRequestView,
  Department,
  GranteeDelegationContractView,
  HumanPrincipal,
  OwnerDelegationContractView,
  ProtectedResourceSummary,
} from "../types";

type TrustPassTab = "need-access" | "grant-access";

const trustPassTabOrder: readonly TrustPassTab[] = [
  "need-access",
  "grant-access",
];

export interface CapabilityRequestSeed {
  prompt: string;
  discovery: CapabilityDiscovery;
}

interface TrustPassCounts {
  pendingApprovals: number;
  approvedTasks: number;
}

interface TrustPassWorkspaceProps {
  principal: HumanPrincipal;
  agents: Agent[];
  resources: ProtectedResourceSummary[];
  requestSeed?: CapabilityRequestSeed | null;
  onRequestSeedCleared?: () => void;
  onCountsChange?: (counts: TrustPassCounts) => void;
  onUnauthorized: () => void;
}

interface ApprovalDraft {
  agentId: string;
  resourceIds: string[];
}

const emptyApprovalDraft: ApprovalDraft = { agentId: "", resourceIds: [] };

function scopedApprovalDraft(
  draft: ApprovalDraft | undefined,
  eligibleAgents: Agent[],
  ownedResources: ProtectedResourceSummary[],
): ApprovalDraft {
  const candidate = draft ?? emptyApprovalDraft;
  return {
    agentId: eligibleAgents.some((agent) => agent.id === candidate.agentId)
      ? candidate.agentId
      : "",
    resourceIds: candidate.resourceIds.filter((resourceId) =>
      ownedResources.some((resource) => resource.id === resourceId),
    ),
  };
}

const capabilityByDepartment: Record<Department, CapabilityId> = {
  frontend: "frontend.interface-implementation",
  backend: "backend.service-implementation",
  qa: "qa.release-validation",
};

const capabilityLabelByDepartment: Record<Department, string> = {
  frontend: "Frontend interface implementation",
  backend: "Backend service implementation",
  qa: "QA release validation",
};

const requestExampleByDepartment: Record<Department, string> = {
  frontend:
    "Implement the validated GET /api/profile backend service from the approved contract and include tests.",
  backend:
    "Implement an accessible profile page interface from the approved requirements, including loading and error states.",
  qa:
    "Implement an accessible profile page interface from the approved requirements, including loading and error states.",
};

function departmentLabel(department: Department): string {
  return department === "qa"
    ? "QA"
    : department.slice(0, 1).toUpperCase() + department.slice(1);
}

function countLabel(count: number, singular: string, plural = singular + "s"): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function formatRemaining(expiresAt: string, serverNowMs: number): string {
  const remainingSeconds = Math.max(
    0,
    Math.ceil((new Date(expiresAt).getTime() - serverNowMs) / 1_000),
  );
  if (remainingSeconds === 0) return "Expired";
  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = remainingSeconds % 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function isExpired(expiresAt: string, serverNowMs: number): boolean {
  return new Date(expiresAt).getTime() <= serverNowMs;
}

function StatusBadge({ status }: { status: DelegationContractStatus | DelegationRequestView["status"] }) {
  return <span className={"pass-status pass-status-" + status}>{status}</span>;
}

function DecisionBadge({ decision }: { decision: AuthorizationDecision["decision"] }) {
  return (
    <span className={"decision-pill decision-" + decision}>
      <span />
      {decision.toUpperCase()}
    </span>
  );
}

function Loading() {
  return <span className="spinner" aria-label="Loading" />;
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="trust-empty">
      <span aria-hidden="true">◇</span>
      <p>{children}</p>
    </div>
  );
}

function ScopeFacts({
  inputCount,
  expiresAt,
  serverNowMs,
}: {
  inputCount: number;
  expiresAt: string;
  serverNowMs: number;
}) {
  return (
    <dl className="trust-scope-grid">
      <div><dt>Action</dt><dd><code>agent.invoke</code></dd></div>
      <div><dt>Uses</dt><dd>One Run</dd></div>
      <div><dt>Inputs</dt><dd>{inputCount} owner-approved</dd></div>
      <div><dt>Result</dt><dd>Final output only</dd></div>
      <div className="trust-scope-wide">
        <dt>Valid for</dt>
        <dd>
          <time dateTime={expiresAt}>{formatRemaining(expiresAt, serverNowMs)}</time>
          <small> Backend expiry is authoritative</small>
        </dd>
      </div>
    </dl>
  );
}

function PolicyExplanation({
  status,
  reasonCode,
}: {
  status: DelegationContractStatus;
  reasonCode: string;
}) {
  const explanation =
    status === "active"
      ? "Eligible now. Before dispatch, the middleware verifies the grantee, exact prompt digest, approved inputs, action, expiry, and remaining use."
      : status === "consumed"
        ? "This one-use pass already admitted its approved Run. Every retry is denied before Runtime dispatch."
        : status === "revoked"
          ? "The capability owner revoked this pass before use. It cannot be restored or forwarded."
          : "The server-side expiry passed before a Run was admitted.";
  return (
    <div className={"policy-explanation policy-" + status}>
      <strong>{status === "active" ? "Policy ready" : "DENY"} — {reasonCode}</strong>
      <span>{explanation}</span>
    </div>
  );
}

export function TrustPassWorkspace({
  principal,
  agents,
  resources,
  requestSeed = null,
  onRequestSeedCleared,
  onCountsChange,
  onUnauthorized,
}: TrustPassWorkspaceProps) {
  const [tab, setTab] = useState<TrustPassTab>("need-access");
  const [outgoingRequests, setOutgoingRequests] = useState<DelegationRequestView[]>([]);
  const [incomingRequests, setIncomingRequests] = useState<DelegationRequestView[]>([]);
  const [approvedTasks, setApprovedTasks] = useState<GranteeDelegationContractView[]>([]);
  const [issuedPasses, setIssuedPasses] = useState<OwnerDelegationContractView[]>([]);
  const [recipients, setRecipients] = useState<DelegationRecipientView[]>([]);
  const [results, setResults] = useState<Record<string, DelegatedRunView | null>>({});
  const [approvalDrafts, setApprovalDrafts] = useState<Record<string, ApprovalDraft>>({});
  const [requestPrompt, setRequestPrompt] = useState(
    requestExampleByDepartment[principal.department],
  );
  const [discovery, setDiscovery] = useState<CapabilityDiscovery | null>(null);
  const [discoveryPrompt, setDiscoveryPrompt] = useState<string | null>(null);
  const [directPrompt, setDirectPrompt] = useState("");
  const [directRecipientId, setDirectRecipientId] = useState("");
  const [directAgentId, setDirectAgentId] = useState("");
  const [directResourceIds, setDirectResourceIds] = useState<string[]>([]);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [latestDecision, setLatestDecision] = useState<AuthorizationDecision | null>(null);
  const [serverOffsetMs, setServerOffsetMs] = useState(0);
  const [clockMs, setClockMs] = useState(Date.now());
  const mountedRef = useRef(true);
  const pollingRef = useRef(new Set<string>());
  const discoveryRequestRef = useRef(0);
  const requestPromptRef = useRef(requestExampleByDepartment[principal.department]);
  const tabButtonRefs = useRef<Partial<Record<TrustPassTab, HTMLButtonElement | null>>>({});

  const eligibleAgents = useMemo(
    () =>
      agents.filter(
        (agent) =>
          agent.ownerId === principal.id &&
          agent.revokedAt === null &&
          agent.status === "ready",
      ),
    [agents, principal.id],
  );
  const ownedResources = useMemo(
    () =>
      resources.filter(
        (resource) =>
          resource.ownedByCurrentUser && resource.ownerId === principal.id,
      ),
    [principal.id, resources],
  );
  const serverNowMs = clockMs + serverOffsetMs;

  const setServerClock = useCallback((serverNow: string) => {
    const parsed = new Date(serverNow).getTime();
    if (Number.isFinite(parsed)) setServerOffsetMs(parsed - Date.now());
  }, []);

  const handleError = useCallback(
    (reason: unknown) => {
      if (reason instanceof ApiError && reason.status === 401) {
        onUnauthorized();
        return;
      }
      if (reason instanceof ApiError && reason.decision) {
        setLatestDecision(reason.decision);
      }
      setError(reason instanceof Error ? reason.message : String(reason));
    },
    [onUnauthorized],
  );

  const refreshAll = useCallback(
    async (showLoading = false) => {
      if (showLoading) setLoading(true);
      try {
        const [outgoing, incoming, grantee, owner, recipientResult] = await Promise.all([
          api.delegationRequests("outgoing"),
          api.delegationRequests("incoming"),
          api.delegationContracts("incoming"),
          api.delegationContracts("outgoing"),
          api.delegationRecipients(),
        ]);
        if (!mountedRef.current) return;
        setOutgoingRequests(outgoing.requests);
        setIncomingRequests(incoming.requests);
        setApprovedTasks(
          grantee.contracts.filter(
            (contract): contract is GranteeDelegationContractView =>
              contract.box === "incoming",
          ),
        );
        setIssuedPasses(
          owner.contracts.filter(
            (contract): contract is OwnerDelegationContractView =>
              contract.box === "outgoing",
          ),
        );
        setRecipients(recipientResult.recipients);
        setServerClock(grantee.serverNow);
      } catch (reason) {
        if (mountedRef.current) handleError(reason);
      } finally {
        if (mountedRef.current && showLoading) setLoading(false);
      }
    },
    [handleError, setServerClock],
  );

  const pollResult = useCallback(
    async (contractId: string) => {
      if (pollingRef.current.has(contractId)) return;
      pollingRef.current.add(contractId);
      try {
        const response = await api.delegatedResult(contractId);
        if (!mountedRef.current) return;
        setServerClock(response.serverNow);
        setResults((current) => {
          const previous = current[contractId];
          const next = response.result;
          if (
            previous === next ||
            (previous !== undefined &&
              previous?.id === next?.id &&
              previous?.status === next?.status &&
              previous?.output === next?.output &&
              previous?.error === next?.error &&
              previous?.startedAt === next?.startedAt &&
              previous?.completedAt === next?.completedAt)
          ) {
            return current;
          }
          return { ...current, [contractId]: next };
        });
      } catch (reason) {
        if (mountedRef.current) handleError(reason);
      } finally {
        pollingRef.current.delete(contractId);
      }
    },
    [handleError, setServerClock],
  );

  useEffect(() => {
    mountedRef.current = true;
    void refreshAll(true);
    return () => {
      mountedRef.current = false;
    };
  }, [refreshAll]);

  useEffect(() => {
    const timer = window.setInterval(() => setClockMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!requestSeed) return;
    const seededPrompt = requestSeed.prompt.trim();
    discoveryRequestRef.current += 1;
    requestPromptRef.current = seededPrompt;
    setTab("need-access");
    setRequestPrompt(seededPrompt);
    setDiscovery(requestSeed.discovery);
    setDiscoveryPrompt(seededPrompt);
    onRequestSeedCleared?.();
  }, [onRequestSeedCleared, requestSeed]);

  useEffect(() => {
    onCountsChange?.({
      pendingApprovals: incomingRequests.filter(
        (request) =>
          request.status === "pending" && !isExpired(request.expiresAt, serverNowMs),
      ).length,
      approvedTasks: approvedTasks.filter(
        (contract) =>
          contract.status === "active" && !isExpired(contract.expiresAt, serverNowMs),
      ).length,
    });
  }, [approvedTasks, incomingRequests, onCountsChange, serverNowMs]);

  useEffect(() => {
    const pollable = approvedTasks.filter((contract) => {
      if (contract.status !== "consumed") return false;
      const result = results[contract.id];
      return result === undefined || result === null || ["queued", "running"].includes(result.status);
    });
    if (pollable.length === 0) return;
    for (const contract of pollable) void pollResult(contract.id);
    const timer = window.setInterval(() => {
      for (const contract of pollable) void pollResult(contract.id);
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [approvedTasks, pollResult, results]);

  useEffect(() => {
    if (
      directRecipientId &&
      !recipients.some((recipient) => recipient.id === directRecipientId)
    ) {
      setDirectRecipientId("");
    }
  }, [directRecipientId, recipients]);

  useEffect(() => {
    if (
      directAgentId &&
      !eligibleAgents.some((agent) => agent.id === directAgentId)
    ) {
      setDirectAgentId("");
    }
  }, [directAgentId, eligibleAgents]);

  useEffect(() => {
    setDirectResourceIds((current) => {
      const next = current.filter((resourceId) =>
        ownedResources.some((resource) => resource.id === resourceId),
      );
      return next.length === current.length ? current : next;
    });
  }, [ownedResources]);

  const handleTabKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    currentTab: TrustPassTab,
  ) => {
    const currentIndex = trustPassTabOrder.indexOf(currentTab);
    if (currentIndex < 0) return;
    let nextTab: TrustPassTab | null = null;
    if (event.key === "ArrowRight") {
      nextTab = trustPassTabOrder[(currentIndex + 1) % trustPassTabOrder.length];
    } else if (event.key === "ArrowLeft") {
      nextTab =
        trustPassTabOrder[
          (currentIndex - 1 + trustPassTabOrder.length) % trustPassTabOrder.length
        ];
    } else if (event.key === "Home") {
      nextTab = trustPassTabOrder[0];
    } else if (event.key === "End") {
      nextTab = trustPassTabOrder[trustPassTabOrder.length - 1];
    }
    if (!nextTab) return;
    event.preventDefault();
    setTab(nextTab);
    tabButtonRefs.current[nextTab]?.focus();
  };

  const discoverRequest = async () => {
    const exactPrompt = requestPrompt.trim();
    if (!exactPrompt) return;
    const requestSequence = ++discoveryRequestRef.current;
    setBusyKey("discover");
    setError(null);
    setNotice(null);
    try {
      const nextDiscovery = await api.discoverCapability(exactPrompt);
      if (
        !mountedRef.current ||
        requestSequence !== discoveryRequestRef.current ||
        requestPromptRef.current.trim() !== exactPrompt
      ) {
        return;
      }
      setDiscovery(nextDiscovery);
      setDiscoveryPrompt(exactPrompt);
    } catch (reason) {
      if (mountedRef.current && requestSequence === discoveryRequestRef.current) {
        handleError(reason);
      }
    } finally {
      if (mountedRef.current) {
        setBusyKey((current) => (current === "discover" ? null : current));
      }
    }
  };

  const createRequest = async () => {
    const exactPrompt = requestPrompt.trim();
    if (
      !discovery?.required ||
      !discovery.capability ||
      !exactPrompt ||
      discoveryPrompt !== exactPrompt
    ) {
      return;
    }
    setBusyKey("create-request");
    setError(null);
    setNotice(null);
    try {
      const response = await api.createDelegationRequest({
        requiredCapability: discovery.capability,
        prompt: discoveryPrompt,
      });
      setLatestDecision(response.decision);
      setNotice("Permission request sent privately to the capability-owning team.");
      setDiscovery(null);
      setDiscoveryPrompt(null);
      const examplePrompt = requestExampleByDepartment[principal.department];
      requestPromptRef.current = examplePrompt;
      setRequestPrompt(examplePrompt);
      onRequestSeedCleared?.();
      await refreshAll();
    } catch (reason) {
      handleError(reason);
    } finally {
      setBusyKey(null);
    }
  };

  const updateApprovalAgent = (requestId: string, agentId: string) => {
    if (!eligibleAgents.some((agent) => agent.id === agentId)) return;
    setApprovalDrafts((current) => ({
      ...current,
      [requestId]: {
        agentId,
        resourceIds: current[requestId]?.resourceIds ?? [],
      },
    }));
  };

  const toggleApprovalResource = (requestId: string, resourceId: string) => {
    if (!ownedResources.some((resource) => resource.id === resourceId)) return;
    setApprovalDrafts((current) => {
      const draft = scopedApprovalDraft(
        current[requestId],
        eligibleAgents,
        ownedResources,
      );
      const resourceIds = draft.resourceIds.includes(resourceId)
        ? draft.resourceIds.filter((id) => id !== resourceId)
        : [...draft.resourceIds, resourceId];
      return { ...current, [requestId]: { ...draft, resourceIds } };
    });
  };

  const approveRequest = async (request: DelegationRequestView) => {
    const draft = scopedApprovalDraft(
      approvalDrafts[request.id],
      eligibleAgents,
      ownedResources,
    );
    if (!draft.agentId) return;
    setBusyKey("approve-" + request.id);
    setError(null);
    setNotice(null);
    try {
      const response = await api.approveDelegationRequest(request.id, {
        agentId: draft.agentId,
        approvedResourceIds: draft.resourceIds,
        expiresInSeconds: 600,
      });
      setLatestDecision(response.decision);
      setNotice("One-use Trust Pass issued. The underlying Agent remains private.");
      await refreshAll();
    } catch (reason) {
      handleError(reason);
    } finally {
      setBusyKey(null);
    }
  };

  const rejectRequest = async (request: DelegationRequestView) => {
    if (!window.confirm(`Reject ${request.requester?.displayName ?? "this"} request?`)) return;
    setBusyKey("reject-" + request.id);
    setError(null);
    setNotice(null);
    try {
      const response = await api.rejectDelegationRequest(request.id);
      setLatestDecision(response.decision);
      setNotice("The permission request was rejected. No Trust Pass was issued.");
      await refreshAll();
    } catch (reason) {
      handleError(reason);
    } finally {
      setBusyKey(null);
    }
  };

  const invokeContract = async (
    contract: GranteeDelegationContractView,
    content = contract.approvedPrompt,
  ) => {
    setBusyKey("invoke-" + contract.id);
    setError(null);
    setNotice(null);
    try {
      const response = await api.invokeDelegationContract(contract.id, content);
      setLatestDecision(response.decision);
      setResults((current) => ({ ...current, [contract.id]: response.result }));
      setNotice("The middleware admitted one scoped Run and atomically consumed the pass.");
      await refreshAll();
    } catch (reason) {
      handleError(reason);
      await refreshAll();
    } finally {
      setBusyKey(null);
    }
  };

  const createDirectPass = async (event: React.FormEvent) => {
    event.preventDefault();
    const selectedRecipient = recipients.find(
      (recipient) => recipient.id === directRecipientId,
    );
    const selectedAgent = eligibleAgents.find((agent) => agent.id === directAgentId);
    if (!directPrompt.trim() || !selectedRecipient || !selectedAgent) return;
    const approvedResourceIds = directResourceIds.filter((resourceId) =>
      ownedResources.some((resource) => resource.id === resourceId),
    );
    setBusyKey("direct-pass");
    setError(null);
    setNotice(null);
    try {
      const response = await api.createDelegationContract({
        requiredCapability: capabilityByDepartment[principal.department],
        granteeHumanId: selectedRecipient.id,
        agentId: selectedAgent.id,
        exactPrompt: directPrompt.trim(),
        approvedResourceIds,
        expiresInSeconds: 600,
      });
      setLatestDecision(response.decision);
      setDirectPrompt("");
      setDirectRecipientId("");
      setDirectAgentId("");
      setDirectResourceIds([]);
      setNotice("One-use Trust Pass issued directly to the selected user.");
      await refreshAll();
    } catch (reason) {
      handleError(reason);
    } finally {
      setBusyKey(null);
    }
  };

  const revokePass = async (contract: OwnerDelegationContractView) => {
    if (!window.confirm(`Revoke the Trust Pass issued to ${contract.grantee.displayName}?`)) return;
    setBusyKey("revoke-" + contract.id);
    setError(null);
    setNotice(null);
    try {
      const response = await api.revokeDelegationContract(contract.id);
      setLatestDecision(response.decision);
      setNotice("Trust Pass revoked. Future invocation attempts will be denied.");
      await refreshAll();
    } catch (reason) {
      handleError(reason);
    } finally {
      setBusyKey(null);
    }
  };

  const toggleDirectResource = (resourceId: string) => {
    if (!ownedResources.some((resource) => resource.id === resourceId)) return;
    setDirectResourceIds((current) =>
      current.includes(resourceId)
        ? current.filter((id) => id !== resourceId)
        : [...current, resourceId],
    );
  };

  const pendingApprovalCount = incomingRequests.filter(
    (request) =>
      request.status === "pending" && !isExpired(request.expiresAt, serverNowMs),
  ).length;
  const activeTaskCount = approvedTasks.filter(
    (contract) =>
      contract.status === "active" && !isExpired(contract.expiresAt, serverNowMs),
  ).length;
  const pendingOutgoingRequestCount = outgoingRequests.filter(
    (request) =>
      request.status === "pending" && !isExpired(request.expiresAt, serverNowMs),
  ).length;
  const activeIssuedPassCount = issuedPasses.filter(
    (contract) =>
      contract.status === "active" && !isExpired(contract.expiresAt, serverNowMs),
  ).length;
  const trustPassTabs = [
    {
      value: "need-access",
      label: "Access I need",
      description: "My requests and approved tasks",
      firstMetric: countLabel(pendingOutgoingRequestCount, "pending", "pending"),
      secondMetric: countLabel(activeTaskCount, "approved", "approved"),
      ariaLabel:
        `Access I need. ${countLabel(pendingOutgoingRequestCount, "pending request")}. ` +
        `${countLabel(activeTaskCount, "approved task")} ready.`,
    },
    {
      value: "grant-access",
      label: "Access I grant",
      description: "Requests to review and passes I’ve issued",
      firstMetric: countLabel(pendingApprovalCount, "to review", "to review"),
      secondMetric: countLabel(activeIssuedPassCount, "issued", "issued"),
      ariaLabel:
        `Access I grant. ${countLabel(pendingApprovalCount, "request to review", "requests to review")}. ` +
        `${countLabel(activeIssuedPassCount, "active issued pass", "active issued passes")}.`,
    },
  ] satisfies Array<{
    value: TrustPassTab;
    label: string;
    description: string;
    firstMetric: string;
    secondMetric: string;
    ariaLabel: string;
  }>;

  return (
    <section className="trust-pass-panel" aria-labelledby="trust-pass-title">
      <header className="trust-pass-header">
        <div>
          <span className="eyebrow">Consent-based Agent delegation</span>
          <h1 id="trust-pass-title">Agent Trust Pass</h1>
          <p>
            Discover a missing capability, request owner consent, and run one exact
            approved task without exposing or sharing the underlying Agent.
          </p>
        </div>
        <span className="enforcement-badge"><span /> Backend enforced</span>
      </header>

      <nav
        className="trust-pass-tabs"
        role="tablist"
        aria-label="Trust Pass views"
        aria-orientation="horizontal"
      >
        {trustPassTabs.map((view) => (
          <button
            type="button"
            role="tab"
            key={view.value}
            id={`trust-${view.value}-tab`}
            aria-controls="trust-pass-content-panel"
            aria-label={view.ariaLabel}
            aria-selected={tab === view.value}
            tabIndex={tab === view.value ? 0 : -1}
            className={tab === view.value ? "active" : ""}
            onClick={() => setTab(view.value)}
            onKeyDown={(event) => handleTabKeyDown(event, view.value)}
            ref={(node) => {
              tabButtonRefs.current[view.value] = node;
            }}
          >
            <span className="trust-tab-copy">
              <strong>{view.label}</strong>
              <small>{view.description}</small>
            </span>
            <span className="trust-tab-metrics" aria-hidden="true">
              <span>{view.firstMetric}</span>
              <span>{view.secondMetric}</span>
            </span>
          </button>
        ))}
      </nav>

      <div
        className="trust-pass-scroll"
        role="tabpanel"
        id="trust-pass-content-panel"
        aria-labelledby={`trust-${tab}-tab`}
      >
        {error && (
          <div className="error-banner trust-banner" role="alert">
            <span>{error}</span>
            <button onClick={() => setError(null)} aria-label="Dismiss error">×</button>
          </div>
        )}
        {notice && (
          <div className="trust-notice" role="status">
            <span>✓</span>{notice}
            <button onClick={() => setNotice(null)} aria-label="Dismiss message">×</button>
          </div>
        )}
        {latestDecision && (
          <div className={"trust-decision trust-decision-" + latestDecision.decision}>
            <DecisionBadge decision={latestDecision.decision} />
            <div>
              <strong>{latestDecision.decision.toUpperCase()} — {latestDecision.reasonCode}</strong>
              <span>{latestDecision.reason}</span>
            </div>
            <code title={latestDecision.requestId}>req {latestDecision.requestId.slice(0, 8)}</code>
          </div>
        )}

        {loading ? (
          <div className="trust-loading"><Loading /> Loading Trust Passes…</div>
        ) : tab === "need-access" ? (
          <div className="trust-grouped-view">
            <div className="trust-view-grid request-view-grid">
            <article className="trust-card trust-form-card">
              <div className="trust-card-heading">
                <div>
                  <span className="eyebrow">Capability broker</span>
                  <h2>Ask without exposing an Agent</h2>
                </div>
                <span className="privacy-chip">Private discovery</span>
              </div>
              <p className="trust-card-intro">
                The broker recommends a capability only. It cannot approve a request or
                issue a pass.
              </p>
              <label>
                Task to evaluate
                <textarea
                  value={requestPrompt}
                  onChange={(event) => {
                    const nextPrompt = event.target.value;
                    discoveryRequestRef.current += 1;
                    requestPromptRef.current = nextPrompt;
                    setRequestPrompt(nextPrompt);
                    setDiscovery(null);
                    setDiscoveryPrompt(null);
                    onRequestSeedCleared?.();
                  }}
                  rows={5}
                  maxLength={50_000}
                  disabled={busyKey !== null}
                />
              </label>
              <button
                type="button"
                className="button button-primary trust-primary-action"
                onClick={() => void discoverRequest()}
                disabled={busyKey !== null || !requestPrompt.trim()}
              >
                {busyKey === "discover" ? <Loading /> : "Check required capability"}
              </button>

              {discovery && (
                <div className={"discovery-card " + (discovery.required ? "discovery-required" : "discovery-clear")}>
                  <div className="discovery-title">
                    <span aria-hidden="true">{discovery.required ? "◆" : "✓"}</span>
                    <div>
                      <strong>
                        {discovery.required
                          ? `This task may require ${discovery.capabilityLabel ?? "another capability"}.`
                          : "No cross-team capability is recommended."}
                      </strong>
                      <span>
                        {discovery.required
                          ? "Request permission from the privately managed capability owner?"
                          : "You can continue with your own Agent."}
                      </span>
                    </div>
                  </div>
                  <dl>
                    <div><dt>Sanitized summary</dt><dd>{discovery.sanitizedTaskSummary}</dd></div>
                    <div>
                      <dt>Personal information</dt>
                      <dd>{discovery.personalInformation === "possible" ? "Possible — review before sending" : "None detected"}</dd>
                    </div>
                    <div><dt>Requested uses</dt><dd>One</dd></div>
                  </dl>
                  {discovery.required && (
                    <>
                      <div className="privacy-proof">
                        No owner, Agent name, settings, workspace, or history has been disclosed.
                      </div>
                      <button
                        type="button"
                        className="button button-primary trust-primary-action"
                        onClick={() => void createRequest()}
                        disabled={
                          busyKey !== null ||
                          discoveryPrompt !== requestPrompt.trim()
                        }
                      >
                        {busyKey === "create-request" ? <Loading /> : "Request permission"}
                      </button>
                    </>
                  )}
                </div>
              )}
            </article>

            <section className="trust-list-section" aria-labelledby="outgoing-request-title">
              <div className="trust-section-heading">
                <div><span className="eyebrow">Your requests</span><h2 id="outgoing-request-title">Permission status</h2></div>
                <button className="button button-ghost trust-refresh" onClick={() => void refreshAll()} disabled={busyKey !== null}>Refresh</button>
              </div>
              {outgoingRequests.length === 0 ? (
                <EmptyState>No permission requests yet.</EmptyState>
              ) : (
                <div className="trust-card-list">
                  {outgoingRequests.map((request) => {
                    const visuallyExpired =
                      request.status === "pending" &&
                      isExpired(request.expiresAt, serverNowMs);
                    const effectiveStatus: DelegationRequestView["status"] =
                      visuallyExpired ? "expired" : request.status;
                    return (
                      <article className="trust-card compact-trust-card" key={request.id}>
                        <div className="trust-card-heading">
                          <div><span className="eyebrow">{request.capabilityLabel}</span><h3>{request.sanitizedTaskSummary}</h3></div>
                          <StatusBadge status={effectiveStatus} />
                        </div>
                        <div className="request-meta">
                          <span>{departmentLabel(request.providerDepartment)} capability</span>
                          <span><time dateTime={request.expiresAt}>{formatRemaining(request.expiresAt, serverNowMs)}</time></span>
                          <span>digest {request.taskDigest.slice(0, 10)}</span>
                        </div>
                        {effectiveStatus === "pending" && <p className="pending-copy">No Agent access exists until the owner approves this exact task.</p>}
                        {effectiveStatus === "approved" && <p className="allowed-copy">Approved. Use the one-use pass in Approved tasks below.</p>}
                        {effectiveStatus === "rejected" && <p className="denied-copy">The owner declined this request. No pass was issued.</p>}
                        {effectiveStatus === "expired" && <p className="denied-copy">The request expired before approval.</p>}
                      </article>
                    );
                  })}
                </div>
              )}
            </section>
            </div>

            <section className="trust-list-section full-trust-section" aria-labelledby="approved-task-title">
            <div className="trust-section-heading">
              <div><span className="eyebrow">Approved tasks</span><h2 id="approved-task-title">Run only what the owner approved</h2></div>
              <button className="button button-ghost trust-refresh" onClick={() => void refreshAll()} disabled={busyKey !== null}>Refresh</button>
            </div>
            {approvedTasks.length === 0 ? (
              <EmptyState>Approved one-use tasks will appear here without exposing the underlying Agent.</EmptyState>
            ) : (
              <div className="approved-task-list">
                {approvedTasks.map((contract) => {
                  const result = results[contract.id];
                  const visuallyExpired = isExpired(contract.expiresAt, serverNowMs);
                  const canRun = contract.status === "active" && !visuallyExpired;
                  return (
                    <article className="trust-card approved-task-card" key={contract.id}>
                      <div className="trust-card-heading">
                        <div>
                          <span className="eyebrow">{contract.providerLabel}</span>
                          <h3>{contract.capabilityLabel}</h3>
                        </div>
                        <StatusBadge status={visuallyExpired && contract.status === "active" ? "expired" : contract.status} />
                      </div>
                      <div className="private-agent-note">
                        <span aria-hidden="true">◆</span>
                        <div><strong>Underlying Agent remains private</strong><span>You cannot open its settings, workspace, history, resources, or other Runs.</span></div>
                      </div>
                      <label className="locked-prompt">
                        Exact owner-approved task
                        <textarea value={contract.approvedPrompt} readOnly rows={4} />
                        <span>Locked to the backend prompt digest</span>
                      </label>
                      <ScopeFacts inputCount={contract.approvedInputCount} expiresAt={contract.expiresAt} serverNowMs={serverNowMs} />
                      <PolicyExplanation status={visuallyExpired && contract.status === "active" ? "expired" : contract.status} reasonCode={visuallyExpired && contract.status === "active" ? "DELEGATION_EXPIRED" : contract.policyReasonCode} />
                      <button
                        type="button"
                        className="button button-primary trust-primary-action run-approved-button"
                        onClick={() => void invokeContract(contract)}
                        disabled={busyKey !== null || !canRun}
                      >
                        {busyKey === "invoke-" + contract.id ? <Loading /> : canRun ? "Run approved task" : "Pass unavailable"}
                      </button>

                      {((contract.status === "active" && !visuallyExpired) ||
                        contract.status === "consumed" ||
                        contract.status === "revoked") && (
                        <details className="denial-test-details">
                          <summary>Demo denial checks</summary>
                          <p>These controls intentionally submit a changed, reused, or revoked task. The middleware must deny them before dispatch.</p>
                          {contract.status === "active" ? (
                            <button type="button" className="button button-ghost" onClick={() => void invokeContract(contract, contract.approvedPrompt + "\nChanged after approval.")} disabled={busyKey !== null}>Try altered prompt</button>
                          ) : contract.status === "consumed" ? (
                            <button type="button" className="button button-ghost" onClick={() => void invokeContract(contract)} disabled={busyKey !== null}>Try used pass again</button>
                          ) : (
                            <button type="button" className="button button-ghost" onClick={() => void invokeContract(contract)} disabled={busyKey !== null}>Try revoked pass</button>
                          )}
                        </details>
                      )}

                      {contract.status === "consumed" && (
                        <div className="delegated-result" aria-live="polite">
                          <div className="delegated-result-heading">
                            <div><span className="eyebrow">Permitted result</span><h4>Approved Run only</h4></div>
                            {result && <span className={"run-result-status run-result-" + result.status}>{result.status}</span>}
                          </div>
                          {!result || ["queued", "running"].includes(result.status) ? (
                            <div className="result-loading"><Loading /> The one approved Run is in progress…</div>
                          ) : result.status === "completed" ? (
                            <>
                              <div className="result-proof">Final output only · no Agent workspace, history, settings, thread, or usage returned</div>
                              <pre>{result.output ?? "The Run completed without output."}</pre>
                              <small>Run {result.id.slice(0, 8)} · completed {result.completedAt ? formatDateTime(result.completedAt) : "recently"}</small>
                            </>
                          ) : (
                            <div className="result-error"><strong>Run {result.status}</strong><span>{result.error ?? "No output was returned."}</span></div>
                          )}
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>
            )}
            </section>
          </div>
        ) : (
          <div className="trust-grouped-view">
            <section className="trust-list-section full-trust-section" aria-labelledby="approval-inbox-title">
            <div className="trust-section-heading">
              <div><span className="eyebrow">Owner approval</span><h2 id="approval-inbox-title">Review capability requests</h2></div>
              <button className="button button-ghost trust-refresh" onClick={() => void refreshAll()} disabled={busyKey !== null}>Refresh</button>
            </div>
            {incomingRequests.length === 0 ? (
              <EmptyState>Requests for {departmentLabel(principal.department)} capabilities will arrive here.</EmptyState>
            ) : (
              <div className="approval-list">
                {incomingRequests.map((request) => {
                  const draft = scopedApprovalDraft(
                    approvalDrafts[request.id],
                    eligibleAgents,
                    ownedResources,
                  );
                  const pending = request.status === "pending" && !isExpired(request.expiresAt, serverNowMs);
                  return (
                    <article className="trust-card approval-card" key={request.id}>
                      <div className="trust-card-heading">
                        <div>
                          <span className="eyebrow">{request.capabilityLabel}</span>
                          <h3>{request.requester?.displayName ?? "Authenticated requester"} requests {departmentLabel(request.providerDepartment)} capability</h3>
                        </div>
                        <StatusBadge status={pending ? request.status : request.status === "pending" ? "expired" : request.status} />
                      </div>
                      <div className="approval-summary">
                        <strong>Exact executable task · redacted</strong>
                        <p>{request.sanitizedTaskSummary}</p>
                        <small>The issued pass will execute exactly the text shown above—no hidden suffix.</small>
                        <span>Personal information: {request.personalInformation === "possible" ? "possible — review carefully" : "none detected"}</span>
                      </div>
                      <div className="approval-facts">
                        <span>Requested uses <strong>one</strong></span>
                        <span>Result <strong>final output only</strong></span>
                        <span>Request expires <strong>{formatRemaining(request.expiresAt, serverNowMs)}</strong></span>
                      </div>
                      <details className="request-technical"><summary>Task digest</summary><code>{request.taskDigest}</code></details>

                      {pending && (
                        <div className="approval-controls">
                          <label>
                            Agent used privately
                            <select value={draft.agentId} onChange={(event) => updateApprovalAgent(request.id, event.target.value)} disabled={busyKey !== null}>
                              <option value="" disabled>Select your ready Agent</option>
                              {eligibleAgents.map((agent) => <option value={agent.id} key={agent.id}>{agent.name}</option>)}
                            </select>
                          </label>
                          <fieldset className="resource-selector">
                            <legend>Approved protected inputs</legend>
                            {ownedResources.length === 0 ? <span>No protected inputs selected.</span> : ownedResources.map((resource) => (
                              <label className="trust-checkbox" key={resource.id}>
                                <input type="checkbox" checked={draft.resourceIds.includes(resource.id)} onChange={() => toggleApprovalResource(request.id, resource.id)} disabled={busyKey !== null} />
                                <span><strong>{resource.name}</strong><small>{resource.fileName}</small></span>
                              </label>
                            ))}
                          </fieldset>
                          <div className="locked-scope-note">
                            Locked scope: <code>agent.invoke</code> · one Run · ten minutes · final output only
                          </div>
                          {eligibleAgents.length === 0 && <div className="denied-copy">Create or start a ready {departmentLabel(principal.department)} Agent before approving.</div>}
                          <div className="approval-actions">
                            <button type="button" className="button button-danger" onClick={() => void rejectRequest(request)} disabled={busyKey !== null}>{busyKey === "reject-" + request.id ? <Loading /> : "Reject"}</button>
                            <button type="button" className="button button-primary" onClick={() => void approveRequest(request)} disabled={busyKey !== null || !draft.agentId}>{busyKey === "approve-" + request.id ? <Loading /> : "Approve one-use pass"}</button>
                          </div>
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>
            )}
            </section>

            <div className="issued-view-grid">
            <form className="trust-card trust-form-card" onSubmit={createDirectPass}>
              <div className="trust-card-heading">
                <div><span className="eyebrow">Owner initiated</span><h2>Issue a one-use pass</h2></div>
                <span className="privacy-chip">Same contract</span>
              </div>
              <p className="trust-card-intro">Proactively approve one exact {capabilityLabelByDepartment[principal.department]} task for another authenticated user.</p>
              <label>
                Grantee
                <select value={directRecipientId} onChange={(event) => setDirectRecipientId(event.target.value)} disabled={busyKey !== null} required>
                  <option value="" disabled>Select an authenticated user</option>
                  {recipients.map((recipient) => <option value={recipient.id} key={recipient.id}>{recipient.displayName} · {departmentLabel(recipient.department)}</option>)}
                </select>
              </label>
              <label>
                Private Agent
                <select value={directAgentId} onChange={(event) => setDirectAgentId(event.target.value)} disabled={busyKey !== null} required>
                  <option value="" disabled>Select your ready Agent</option>
                  {eligibleAgents.map((agent) => <option value={agent.id} key={agent.id}>{agent.name}</option>)}
                </select>
              </label>
              <label>
                Exact approved task
                <textarea value={directPrompt} onChange={(event) => setDirectPrompt(event.target.value)} rows={5} maxLength={50_000} placeholder="Allow this exact task once…" disabled={busyKey !== null} required />
              </label>
              <fieldset className="resource-selector direct-resources">
                <legend>Approved inputs</legend>
                {ownedResources.length === 0 ? <span>No protected inputs available.</span> : ownedResources.map((resource) => (
                  <label className="trust-checkbox" key={resource.id}>
                    <input type="checkbox" checked={directResourceIds.includes(resource.id)} onChange={() => toggleDirectResource(resource.id)} disabled={busyKey !== null} />
                    <span><strong>{resource.name}</strong><small>{resource.fileName}</small></span>
                  </label>
                ))}
              </fieldset>
              <div className="locked-scope-note">One Run · ten minutes · final output only · no forwarding</div>
              {recipients.length === 0 && <div className="pending-copy">Another authenticated user must sign in once before they can receive a direct pass.</div>}
              {eligibleAgents.length === 0 && <div className="denied-copy">Create or start a ready Agent before issuing a pass.</div>}
              <button
                className="button button-primary trust-primary-action"
                disabled={
                  busyKey !== null ||
                  !directPrompt.trim() ||
                  !recipients.some((recipient) => recipient.id === directRecipientId) ||
                  !eligibleAgents.some((agent) => agent.id === directAgentId)
                }
              >
                {busyKey === "direct-pass" ? <Loading /> : "Issue one-use pass"}
              </button>
            </form>

            <section className="trust-list-section" aria-labelledby="issued-pass-title">
              <div className="trust-section-heading">
                <div><span className="eyebrow">Owner controls</span><h2 id="issued-pass-title">Issued passes</h2></div>
                <button className="button button-ghost trust-refresh" onClick={() => void refreshAll()} disabled={busyKey !== null}>Refresh</button>
              </div>
              {issuedPasses.length === 0 ? (
                <EmptyState>Approved and owner-initiated passes will appear here.</EmptyState>
              ) : (
                <div className="trust-card-list">
                  {issuedPasses.map((contract) => {
                    const visuallyExpired =
                      contract.status === "active" &&
                      isExpired(contract.expiresAt, serverNowMs);
                    const effectiveStatus: DelegationContractStatus = visuallyExpired
                      ? "expired"
                      : contract.status;
                    return (
                      <article className="trust-card compact-trust-card issued-pass-card" key={contract.id}>
                      <div className="trust-card-heading">
                        <div><span className="eyebrow">{contract.capabilityLabel}</span><h3>{contract.grantee.displayName}</h3></div>
                        <StatusBadge status={effectiveStatus} />
                      </div>
                      <dl className="issued-details">
                        <div><dt>Private Agent</dt><dd>{contract.agent.name}</dd></div>
                        <div><dt>Approved inputs</dt><dd>{contract.approvedResources.length || "None"}</dd></div>
                        <div><dt>Remaining uses</dt><dd>{contract.remainingUses}</dd></div>
                        <div><dt>Expires</dt><dd>{formatRemaining(contract.expiresAt, serverNowMs)}</dd></div>
                      </dl>
                      <p>{contract.sanitizedTaskSummary}</p>
                      {contract.approvedResources.length > 0 && <div className="approved-resource-chips">{contract.approvedResources.map((resource) => <span key={resource.id}>{resource.name}</span>)}</div>}
                      <PolicyExplanation status={effectiveStatus} reasonCode={visuallyExpired ? "DELEGATION_EXPIRED" : contract.policyReasonCode} />
                      {contract.status === "active" && !visuallyExpired && (
                        <button type="button" className="button button-danger revoke-pass-button" onClick={() => void revokePass(contract)} disabled={busyKey !== null}>{busyKey === "revoke-" + contract.id ? <Loading /> : "Revoke pass"}</button>
                      )}
                      </article>
                    );
                  })}
                </div>
              )}
            </section>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
