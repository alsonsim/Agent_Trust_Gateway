import { randomUUID } from "node:crypto";
import type { AgentService } from "./agent-service.js";
import {
  assessPersonalInformation,
  discoverCapability,
  getCapabilityDefinition,
  sanitizeTaskSummary,
} from "./capability-broker.js";
import { digestExactPrompt } from "./delegation-digest.js";
import { digestResourceContent } from "./delegation-digest.js";
import { HttpError } from "./errors.js";
import type { HumanPrincipal } from "./identity-provider.js";
import type { SecurityRepository } from "./security-repository.js";
import { JsonStore } from "./store.js";
import type {
  AuthorizationDecision,
  Agent,
  AgentRun,
  Database,
  DelegationContract,
  DelegationContractStatus,
  DelegationRequest,
  DelegationRequestStatus,
  Department,
  KnownHuman,
} from "./types.js";

const REQUEST_TTL_MS = 30 * 60 * 1_000;
const MIN_CONTRACT_TTL_SECONDS = 60;
const MAX_CONTRACT_TTL_SECONDS = 10 * 60;

export interface DelegationRecipientView {
  id: string;
  displayName: string;
  department: Department;
}

export interface DelegationRequestView {
  id: string;
  box: "incoming" | "outgoing";
  requiredCapability: string;
  capabilityLabel: string;
  providerDepartment: Department;
  sanitizedTaskSummary: string;
  personalInformation: DelegationRequest["personalInformation"];
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
  requiredCapability: string;
  capabilityLabel: string;
  providerDepartment: Department;
  sanitizedTaskSummary: string;
  personalInformation: DelegationContract["personalInformation"];
  allowedActions: ["agent.invoke"];
  resultVisibility: DelegationContract["resultVisibility"];
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
  status: AgentRun["status"];
  output: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export class DelegationService {
  private transitionTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: JsonStore,
    private readonly securityRepository: SecurityRepository,
    private readonly agents: AgentService,
    private readonly now: () => number = () => Date.now(),
  ) {}

  discover(principal: HumanPrincipal, prompt: string) {
    return discoverCapability(prompt, principal.department);
  }

  async observePrincipals(principals: readonly HumanPrincipal[]): Promise<void> {
    if (principals.length === 0) return;
    const timestamp = this.nowIso();
    await this.store.mutate((database) => {
      for (const principal of principals) {
        const existing = database.knownHumans.find(
          (candidate) => candidate.id === principal.id,
        );
        if (existing) {
          existing.email = principal.email;
          existing.displayName = principal.displayName;
          existing.department = principal.department;
          existing.lastSeenAt = timestamp;
        } else {
          database.knownHumans.push({ ...principal, lastSeenAt: timestamp });
        }
      }
    });
  }

  async observePrincipal(principal: HumanPrincipal): Promise<void> {
    const existing = this.store
      .snapshot()
      .knownHumans.find((candidate) => candidate.id === principal.id);
    const fiveMinutesAgo = this.now() - 5 * 60 * 1_000;
    if (
      existing &&
      existing.email === principal.email &&
      existing.displayName === principal.displayName &&
      existing.department === principal.department &&
      new Date(existing.lastSeenAt).getTime() >= fiveMinutesAgo
    ) {
      return;
    }
    await this.observePrincipals([principal]);
  }

  listRecipients(principal: HumanPrincipal): DelegationRecipientView[] {
    return this.store
      .snapshot()
      .knownHumans.filter((candidate) => candidate.id !== principal.id)
      .sort((left, right) => left.displayName.localeCompare(right.displayName))
      .map(({ id, displayName, department }) => ({ id, displayName, department }));
  }

  async createRequest(
    principal: HumanPrincipal,
    input: {
      requiredCapability: string;
      prompt: string;
    },
    requestId: string,
  ): Promise<{ request: DelegationRequestView; decision: AuthorizationDecision }> {
    return this.withTransitionLock(() =>
      this.createRequestLocked(principal, input, requestId),
    );
  }

  private async createRequestLocked(
    principal: HumanPrincipal,
    input: {
      requiredCapability: string;
      prompt: string;
    },
    requestId: string,
  ): Promise<{ request: DelegationRequestView; decision: AuthorizationDecision }> {
    const capability = getCapabilityDefinition(input.requiredCapability);
    if (!capability) {
      throw new HttpError(400, "The requested capability is not supported");
    }
    if (capability.providerDepartment === principal.department) {
      throw new HttpError(
        400,
        "Choose a capability managed by another team for delegated access",
      );
    }
    const discovery = discoverCapability(input.prompt, principal.department);
    if (!discovery.required || discovery.capability !== capability.id) {
      throw new HttpError(
        400,
        "The requested capability does not match the server recommendation for this task",
      );
    }
    const timestamp = this.nowIso();
    const request: DelegationRequest = {
      id: randomUUID(),
      requesterHumanId: principal.id,
      requesterEmail: principal.email,
      requesterDisplayName: principal.displayName,
      requesterDepartment: principal.department,
      requiredCapability: capability.id,
      sanitizedTaskSummary: sanitizeTaskSummary(input.prompt),
      personalInformation: assessPersonalInformation(input.prompt),
      taskDigest: digestExactPrompt(input.prompt),
      status: "pending",
      createdAt: timestamp,
      expiresAt: new Date(this.now() + REQUEST_TTL_MS).toISOString(),
      reviewedAt: null,
      contractId: null,
    };
    const decision = this.makeDecision({
      principal,
      requestId,
      action: "delegation.request",
      targetType: "capability",
      targetId: request.id,
      targetLabel: capability.label,
      reasonCode: "DELEGATION_REQUESTED",
      reason:
        "The capability broker forwarded a consented request without exposing an Agent.",
    });
    const auditPersistedLocally = await this.store.mutate((database) => {
      database.delegationRequests.push(request);
      return this.appendAllowedDecisionsToDatabase(database, [decision]);
    });
    if (!auditPersistedLocally) {
      try {
        await this.appendAllowedDecision(decision);
      } catch (error) {
        await this.store.mutate((database) => {
          database.delegationRequests = database.delegationRequests.filter(
            (candidate) =>
              candidate.id !== request.id ||
              candidate.status !== "pending" ||
              candidate.contractId !== null,
          );
        });
        throw error;
      }
    }
    return { request: this.requestView(request, "outgoing"), decision };
  }

  async listRequests(
    principal: HumanPrincipal,
    box: "incoming" | "outgoing",
  ): Promise<{ requests: DelegationRequestView[]; serverNow: string }> {
    await this.expireRequests();
    const requests = this.store
      .snapshot()
      .delegationRequests.filter((request) =>
        box === "outgoing"
          ? request.requesterHumanId === principal.id
          : getCapabilityDefinition(request.requiredCapability)?.providerDepartment ===
            principal.department,
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((request) => this.requestView(request, box));
    return { requests, serverNow: this.nowIso() };
  }

  async rejectRequest(
    principal: HumanPrincipal,
    requestIdValue: string,
    auditRequestId: string,
  ): Promise<{ request: DelegationRequestView; decision: AuthorizationDecision }> {
    return this.withTransitionLock(() =>
      this.rejectRequestLocked(principal, requestIdValue, auditRequestId),
    );
  }

  private async rejectRequestLocked(
    principal: HumanPrincipal,
    requestIdValue: string,
    auditRequestId: string,
  ): Promise<{ request: DelegationRequestView; decision: AuthorizationDecision }> {
    await this.expireRequests();
    const transition = await this.store.mutate((database) => {
      const request = database.delegationRequests.find(
        (candidate) => candidate.id === requestIdValue,
      );
      const capability = request
        ? getCapabilityDefinition(request.requiredCapability)
        : null;
      if (!request || capability?.providerDepartment !== principal.department) {
        throw new HttpError(404, "Delegation request not found");
      }
      if (request.status !== "pending") {
        throw new HttpError(
          409,
          "This delegation request is no longer pending",
          request.status === "expired" ? { code: "DELEGATION_EXPIRED" } : undefined,
        );
      }
      request.status = "rejected";
      request.reviewedAt = this.nowIso();
      const updated = structuredClone(request);
      const decision = this.makeDecision({
        principal,
        requestId: auditRequestId,
        action: "delegation.reject",
        targetType: "delegation",
        targetId: updated.id,
        targetLabel: capability.label,
        reasonCode: "DELEGATION_REJECTED",
        reason: "The capability owner rejected the pending permission request.",
      });
      return {
        updated,
        decision,
        auditPersistedLocally: this.appendAllowedDecisionsToDatabase(database, [
          decision,
        ]),
      };
    });
    if (!transition.auditPersistedLocally) {
      try {
        await this.appendAllowedDecision(transition.decision);
      } catch (error) {
        await this.store.mutate((database) => {
          const request = database.delegationRequests.find(
            (candidate) => candidate.id === transition.updated.id,
          );
          if (request?.status === "rejected" && request.contractId === null) {
            request.status = "pending";
            request.reviewedAt = null;
          }
        });
        throw error;
      }
    }
    return {
      request: this.requestView(transition.updated, "incoming"),
      decision: transition.decision,
    };
  }

  async approveRequest(
    principal: HumanPrincipal,
    requestIdValue: string,
    input: {
      agentId: string;
      approvedResourceIds: string[];
      expiresInSeconds: number;
    },
    auditRequestId: string,
  ): Promise<{ contract: OwnerDelegationContractView; decision: AuthorizationDecision }> {
    return this.withTransitionLock(() =>
      this.approveRequestLocked(
        principal,
        requestIdValue,
        input,
        auditRequestId,
      ),
    );
  }

  private async approveRequestLocked(
    principal: HumanPrincipal,
    requestIdValue: string,
    input: {
      agentId: string;
      approvedResourceIds: string[];
      expiresInSeconds: number;
    },
    auditRequestId: string,
  ): Promise<{ contract: OwnerDelegationContractView; decision: AuthorizationDecision }> {
    await this.expireRequests();
    const request = this.store
      .snapshot()
      .delegationRequests.find((candidate) => candidate.id === requestIdValue);
    const capability = request
      ? getCapabilityDefinition(request.requiredCapability)
      : null;
    if (!request || capability?.providerDepartment !== principal.department) {
      throw new HttpError(404, "Delegation request not found");
    }
    if (request.status !== "pending") {
      throw new HttpError(409, "This delegation request is no longer pending", {
        code: request.status === "expired" ? "DELEGATION_EXPIRED" : "DELEGATION_CONSUMED",
      });
    }
    return this.issueContract(
      principal,
      {
        requestId: request.id,
        requiredCapability: request.requiredCapability,
        sanitizedTaskSummary: request.sanitizedTaskSummary,
        personalInformation: request.personalInformation,
        granteeHumanId: request.requesterHumanId,
        agentId: input.agentId,
        // The owner approves exactly the redacted task shown in the inbox. Never
        // execute a longer requester-controlled prompt hidden behind its summary.
        approvedPrompt: request.sanitizedTaskSummary,
        approvedResourceIds: input.approvedResourceIds,
        expiresInSeconds: input.expiresInSeconds,
        requestExpiresAt: request.expiresAt,
      },
      auditRequestId,
    );
  }

  async createContract(
    principal: HumanPrincipal,
    input: {
      requiredCapability: string;
      granteeHumanId: string;
      agentId: string;
      exactPrompt: string;
      approvedResourceIds: string[];
      expiresInSeconds: number;
    },
    auditRequestId: string,
  ): Promise<{ contract: OwnerDelegationContractView; decision: AuthorizationDecision }> {
    return this.withTransitionLock(() =>
      this.createContractLocked(principal, input, auditRequestId),
    );
  }

  private async createContractLocked(
    principal: HumanPrincipal,
    input: {
      requiredCapability: string;
      granteeHumanId: string;
      agentId: string;
      exactPrompt: string;
      approvedResourceIds: string[];
      expiresInSeconds: number;
    },
    auditRequestId: string,
  ): Promise<{ contract: OwnerDelegationContractView; decision: AuthorizationDecision }> {
    return this.issueContract(
      principal,
      {
        requestId: null,
        requiredCapability: input.requiredCapability,
        sanitizedTaskSummary: sanitizeTaskSummary(input.exactPrompt),
        personalInformation: assessPersonalInformation(input.exactPrompt),
        granteeHumanId: input.granteeHumanId,
        agentId: input.agentId,
        approvedPrompt: input.exactPrompt,
        approvedResourceIds: input.approvedResourceIds,
        expiresInSeconds: input.expiresInSeconds,
        requestExpiresAt: null,
      },
      auditRequestId,
    );
  }

  async listContracts(
    principal: HumanPrincipal,
    box: "incoming" | "outgoing",
  ): Promise<{ contracts: DelegationContractView[]; serverNow: string }> {
    await this.expireContracts();
    const resources = await this.securityRepository.listResources();
    const matchingContracts = this.store
      .snapshot()
      .delegationContracts.filter((contract) =>
        box === "incoming"
          ? contract.granteeHumanId === principal.id
          : contract.approvingHumanId === principal.id,
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    const contracts: DelegationContractView[] =
      box === "incoming"
        ? matchingContracts.map((contract) =>
            this.contractView(contract, "incoming", resources),
          )
        : matchingContracts.map((contract) =>
            this.contractView(contract, "outgoing", resources),
          );
    return { contracts, serverNow: this.nowIso() };
  }

  async revokeContract(
    principal: HumanPrincipal,
    contractId: string,
    auditRequestId: string,
  ): Promise<{ contract: OwnerDelegationContractView; decision: AuthorizationDecision }> {
    return this.withTransitionLock(() =>
      this.revokeContractLocked(principal, contractId, auditRequestId),
    );
  }

  private async revokeContractLocked(
    principal: HumanPrincipal,
    contractId: string,
    auditRequestId: string,
  ): Promise<{ contract: OwnerDelegationContractView; decision: AuthorizationDecision }> {
    await this.expireContracts();
    const transition = await this.store.mutate((database) => {
      const contract = database.delegationContracts.find(
        (candidate) => candidate.id === contractId,
      );
      if (!contract || contract.approvingHumanId !== principal.id) {
        throw new HttpError(404, "Delegation contract not found");
      }
      if (contract.status !== "active") {
        throw new HttpError(409, "Only an active Trust Pass can be revoked", {
          code: this.reasonCodeForStatus(contract.status),
        });
      }
      contract.status = "revoked";
      contract.revokedAt = this.nowIso();
      const updated = structuredClone(contract);
      const agent = this.safeGetAgent(updated.agentId);
      const decision = this.makeDecision({
        principal,
        requestId: auditRequestId,
        action: "delegation.revoke",
        targetType: "delegation",
        targetId: updated.id,
        targetLabel: "One-use Agent Trust Pass",
        reasonCode: "DELEGATION_REVOKED",
        reason: "The Agent owner revoked the Trust Pass before use.",
        ...(agent ? { agent } : {}),
      });
      return {
        updated,
        decision,
        auditPersistedLocally: this.appendAllowedDecisionsToDatabase(database, [
          decision,
        ]),
      };
    });
    if (!transition.auditPersistedLocally) {
      try {
        await this.appendAllowedDecision(transition.decision);
      } catch (error) {
        await this.store.mutate((database) => {
          const contract = database.delegationContracts.find(
            (candidate) => candidate.id === transition.updated.id,
          );
          if (
            contract?.status === "revoked" &&
            contract.usesConsumed === 0 &&
            contract.runId === null
          ) {
            contract.status = "active";
            contract.revokedAt = null;
          }
        });
        throw error;
      }
    }
    const resources = await this.securityRepository.listResources();
    return {
      contract: this.contractView(transition.updated, "outgoing", resources),
      decision: transition.decision,
    };
  }

  async invokeContract(
    principal: HumanPrincipal,
    contractId: string,
    prompt: string,
    auditRequestId: string,
  ): Promise<{
    contract: GranteeDelegationContractView;
    decision: AuthorizationDecision;
    result: DelegatedRunView;
  }> {
    return this.withTransitionLock(() =>
      this.invokeContractLocked(principal, contractId, prompt, auditRequestId),
    );
  }

  private async invokeContractLocked(
    principal: HumanPrincipal,
    contractId: string,
    prompt: string,
    auditRequestId: string,
  ): Promise<{
    contract: GranteeDelegationContractView;
    decision: AuthorizationDecision;
    result: DelegatedRunView;
  }> {
    await this.expireContracts();
    const contract = this.store
      .snapshot()
      .delegationContracts.find((candidate) => candidate.id === contractId);
    if (!contract) {
      throw new HttpError(404, "Approved task not found");
    }
    if (contract.granteeHumanId !== principal.id) {
      const protectedAgent = this.safeGetAgent(contract.agentId);
      const decision = this.makeDecision({
        principal,
        requestId: auditRequestId,
        action: "agent.invoke",
        targetType: "delegation",
        targetId: contract.id,
        targetLabel: "One-use Agent Trust Pass",
        reasonCode: "DELEGATION_GRANTEE_MISMATCH",
        reason: "The authenticated human is not the approved Trust Pass grantee.",
        decision: "deny",
        ...(protectedAgent ? { agent: protectedAgent } : {}),
      });
      await this.appendDeniedDecision(decision);
      throw new HttpError(404, "Approved task not found");
    }
    const agent = this.safeGetAgent(contract.agentId);
    if (contract.status !== "active") {
      await this.denyInvocation(
        principal,
        contract,
        auditRequestId,
        this.reasonCodeForStatus(contract.status),
        contract.status === "consumed"
          ? "This one-use Trust Pass has already admitted its approved Run."
          : contract.status === "revoked"
            ? "The Agent owner revoked this Trust Pass before use."
            : "This Trust Pass expired before the approved Run started.",
        agent,
      );
    }
    const promptDigest = digestExactPrompt(prompt);
    if (promptDigest !== contract.exactPromptDigest) {
      await this.denyInvocation(
        principal,
        contract,
        auditRequestId,
        "DELEGATION_PROMPT_MISMATCH",
        "The submitted prompt bytes do not match the exact owner-approved task.",
        agent,
      );
    }
    if (contract.allowedActions.length !== 1 || contract.allowedActions[0] !== "agent.invoke") {
      await this.denyInvocation(
        principal,
        contract,
        auditRequestId,
        "DELEGATION_ACTION_NOT_ALLOWED",
        "The Trust Pass does not authorize this action.",
        agent,
      );
    }
    if (!agent || agent.revokedAt) {
      await this.denyInvocation(
        principal,
        contract,
        auditRequestId,
        "DELEGATION_REVOKED",
        "The approved capability is no longer available.",
        agent,
      );
    }
    if (!agent) throw new Error("Approved capability became unavailable");

    const approvedResources: Array<{
      id: string;
      name: string;
    }> = [];

    try {
      let allowedDecision: AuthorizationDecision | null = null;
      const buildAuthorizationEvidence = (
        claimedContract: DelegationContract,
        claimedAgent: Agent,
      ): AuthorizationDecision[] => {
        const resourceDecisions = approvedResources.map((resource) =>
          this.makeDecision({
            principal,
            requestId: auditRequestId,
            action: "resource.read",
            targetType: "resource",
            targetId: resource.id,
            targetLabel: resource.name,
            reasonCode: "DELEGATION_ACTIVE",
            reason:
              "The Agent owner approved this exact resource as an input to the one-use Run.",
            agent: claimedAgent,
          }),
        );
        const decision = this.makeDecision({
          principal,
          requestId: auditRequestId,
          action: "agent.invoke",
          targetType: "delegation",
          targetId: claimedContract.id,
          targetLabel: "One-use Agent Trust Pass",
          reasonCode: "DELEGATION_ACTIVE",
          reason:
            "The grantee, exact task, action, approved inputs, expiry, and remaining use matched.",
          agent: claimedAgent,
        });
        allowedDecision = decision;
        return [...resourceDecisions, decision];
      };
      const reservation = await this.agents.sendDelegatedMessage({
        contractId: contract.id,
        granteeHumanId: principal.id,
        prompt,
        promptDigest,
        loadApprovedInputs: async () => {
          const approvedInputs: Array<{ fileName: string; content: string }> = [];
          for (const [index, resourceId] of contract.approvedResourceIds.entries()) {
            const resource = await this.securityRepository.readResourceForDelegation(
              resourceId,
              contract.approvingHumanId,
            );
            if (
              !resource ||
              digestResourceContent(resource.content) !==
                contract.approvedResourceDigests[resourceId]
            ) {
              await this.denyInvocation(
                principal,
                contract,
                auditRequestId,
                "DELEGATION_RESOURCE_CHANGED",
                "An owner-approved input changed after approval, so execution failed closed.",
                agent,
              );
            }
            if (!resource) throw new Error("Approved input became unavailable");
            approvedInputs.push({
              fileName: `approved-input-${index + 1}.md`,
              content: resource.content,
            });
            approvedResources.push({
              id: resource.resource.id,
              name: resource.resource.name,
            });
          }
          return approvedInputs;
        },
        runtimeAuthorization: {
          humanUserId: principal.id,
          humanEmail: principal.email,
          humanDepartment: principal.department,
          requestId: auditRequestId,
        },
        commitAuthorizationEvidence: (
          database,
          claimedContract,
          _run,
          claimedAgent,
        ) =>
          this.appendAllowedDecisionsToDatabase(
            database,
            buildAuthorizationEvidence(claimedContract, claimedAgent),
          ),
        onAuthorized: async (claimedContract, _run, claimedAgent) => {
          await this.appendAllowedDecisions(
            buildAuthorizationEvidence(claimedContract, claimedAgent),
          );
        },
      });
      if (!allowedDecision) {
        throw new Error("Delegated authorization evidence was not created");
      }
      return {
        contract: this.contractView(reservation.contract, "incoming", []),
        decision: this.publicDecision(allowedDecision),
        result: this.runView(reservation.run),
      };
    } catch (error) {
      if (error instanceof HttpError && error.code?.startsWith("DELEGATION_")) {
        const reasonCode = error.code as AuthorizationDecision["reasonCode"];
        await this.denyInvocation(
          principal,
          contract,
          auditRequestId,
          reasonCode,
          error.message,
          agent,
        );
      }
      if (
        error instanceof HttpError &&
        error.code === "RUNTIME_ACTION_DENIED" &&
        error.details &&
        typeof error.details === "object"
      ) {
        throw new HttpError(403, error.message, {
          code: error.code,
          details: this.publicDecision(error.details as AuthorizationDecision),
        });
      }
      throw error;
    }
  }

  async delegatedResult(
    principal: HumanPrincipal,
    contractId: string,
  ): Promise<{
    contractStatus: DelegationContractStatus;
    result: DelegatedRunView | null;
    serverNow: string;
  }> {
    await this.expireContracts();
    const contract = this.store
      .snapshot()
      .delegationContracts.find((candidate) => candidate.id === contractId);
    if (
      !contract ||
      (contract.granteeHumanId !== principal.id &&
        contract.approvingHumanId !== principal.id)
    ) {
      throw new HttpError(404, "Delegated result not found");
    }
    const run = contract.runId ? this.agents.getRun(contract.runId) : null;
    return {
      contractStatus: contract.status,
      result: run ? this.runView(run) : null,
      serverNow: this.nowIso(),
    };
  }

  private async issueContract(
    principal: HumanPrincipal,
    input: {
      requestId: string | null;
      requiredCapability: string;
      sanitizedTaskSummary: string;
      personalInformation: DelegationContract["personalInformation"];
      granteeHumanId: string;
      agentId: string;
      approvedPrompt: string;
      approvedResourceIds: string[];
      expiresInSeconds: number;
      requestExpiresAt: string | null;
    },
    auditRequestId: string,
  ): Promise<{ contract: OwnerDelegationContractView; decision: AuthorizationDecision }> {
    const capability = getCapabilityDefinition(input.requiredCapability);
    if (!capability || capability.providerDepartment !== principal.department) {
      throw new HttpError(403, "Only the capability-owning team can issue this Trust Pass");
    }
    if (input.granteeHumanId === principal.id) {
      throw new HttpError(400, "A Trust Pass must delegate to another authenticated user");
    }
    const grantee = this.store
      .snapshot()
      .knownHumans.find((candidate) => candidate.id === input.granteeHumanId);
    if (!grantee) throw new HttpError(400, "The selected grantee is not available");
    const agent = this.safeGetAgent(input.agentId);
    if (!agent || agent.ownerId !== principal.id) {
      throw new HttpError(404, "Agent not found");
    }
    if (agent.revokedAt) {
      throw new HttpError(409, "A revoked Agent cannot receive new Trust Passes", {
        code: "AGENT_REVOKED",
      });
    }
    const resourceIds = [...new Set(input.approvedResourceIds)].sort();
    const approvedResourceDigests: Record<string, string> = {};
    for (const resourceId of resourceIds) {
      const resource = await this.securityRepository.readResourceForDelegation(
        resourceId,
        principal.id,
      );
      if (!resource) {
        throw new HttpError(403, "Every approved input must belong to the Agent owner");
      }
      approvedResourceDigests[resourceId] = digestResourceContent(resource.content);
    }
    const now = this.now();
    const ttlSeconds = Math.min(
      MAX_CONTRACT_TTL_SECONDS,
      Math.max(MIN_CONTRACT_TTL_SECONDS, input.expiresInSeconds),
    );
    const requestedExpiry = now + ttlSeconds * 1_000;
    const expiresAt = new Date(
      input.requestExpiresAt
        ? Math.min(requestedExpiry, new Date(input.requestExpiresAt).getTime())
        : requestedExpiry,
    ).toISOString();
    if (new Date(expiresAt).getTime() <= now) {
      throw new HttpError(409, "The originating delegation request has expired", {
        code: "DELEGATION_EXPIRED",
      });
    }
    const contract: DelegationContract = {
      id: randomUUID(),
      requestId: input.requestId,
      requiredCapability: capability.id,
      sanitizedTaskSummary: input.sanitizedTaskSummary,
      personalInformation: input.personalInformation,
      approvingHumanId: principal.id,
      granteeHumanId: grantee.id,
      granteeEmail: grantee.email,
      granteeDisplayName: grantee.displayName,
      granteeDepartment: grantee.department,
      agentId: agent.id,
      approvedPrompt: input.approvedPrompt,
      exactPromptDigest: digestExactPrompt(input.approvedPrompt),
      approvedResourceIds: resourceIds,
      approvedResourceDigests,
      allowedActions: ["agent.invoke"],
      resultVisibility: "final_output_only",
      maximumUses: 1,
      usesConsumed: 0,
      expiresAt,
      status: "active",
      runId: null,
      createdAt: this.nowIso(),
      consumedAt: null,
      revokedAt: null,
    };
    const decision = this.makeDecision({
      principal,
      requestId: auditRequestId,
      action: "delegation.approve",
      targetType: "delegation",
      targetId: contract.id,
      targetLabel: "One-use Agent Trust Pass",
      reasonCode: "DELEGATION_APPROVED",
      reason:
        "The Agent owner approved one exact task, one grantee, one Run, and bounded inputs.",
      agent,
    });
    const auditPersistedLocally = await this.store.mutate((database) => {
      const storedAgent = database.agents.find(
        (candidate) => candidate.id === agent.id,
      );
      if (!storedAgent || storedAgent.ownerId !== principal.id) {
        throw new HttpError(404, "Agent not found");
      }
      if (storedAgent.revokedAt) {
        throw new HttpError(409, "A revoked Agent cannot receive new Trust Passes", {
          code: "AGENT_REVOKED",
        });
      }
      if (input.requestId) {
        const request = database.delegationRequests.find(
          (candidate) => candidate.id === input.requestId,
        );
        if (
          !request ||
          request.requesterHumanId !== grantee.id ||
          request.status !== "pending" ||
          new Date(request.expiresAt).getTime() <= now
        ) {
          throw new HttpError(409, "The delegation request can no longer be approved", {
            code: "DELEGATION_EXPIRED",
          });
        }
        request.status = "approved";
        request.reviewedAt = this.nowIso();
        request.contractId = contract.id;
      }
      database.delegationContracts.push(contract);
      return this.appendAllowedDecisionsToDatabase(database, [decision]);
    });
    if (!auditPersistedLocally) {
      try {
        await this.appendAllowedDecision(decision);
      } catch (error) {
        await this.store.mutate((database) => {
          const storedContract = database.delegationContracts.find(
            (candidate) => candidate.id === contract.id,
          );
          const canRollback =
            storedContract?.status === "active" &&
            storedContract.usesConsumed === 0 &&
            storedContract.runId === null;
          if (!canRollback) return;
          database.delegationContracts = database.delegationContracts.filter(
            (candidate) => candidate.id !== contract.id,
          );
          if (contract.requestId) {
            const request = database.delegationRequests.find(
              (candidate) => candidate.id === contract.requestId,
            );
            if (request?.contractId === contract.id) {
              request.status = "pending";
              request.reviewedAt = null;
              request.contractId = null;
            }
          }
        });
        throw error;
      }
    }
    const resources = await this.securityRepository.listResources();
    return {
      contract: this.contractView(contract, "outgoing", resources),
      decision,
    };
  }

  private contractView(
    contract: DelegationContract,
    box: "incoming",
    resources: Awaited<ReturnType<SecurityRepository["listResources"]>>,
  ): GranteeDelegationContractView;
  private contractView(
    contract: DelegationContract,
    box: "outgoing",
    resources: Awaited<ReturnType<SecurityRepository["listResources"]>>,
  ): OwnerDelegationContractView;
  private contractView(
    contract: DelegationContract,
    box: "incoming" | "outgoing",
    resources: Awaited<ReturnType<SecurityRepository["listResources"]>>,
  ): DelegationContractView {
    const capability = getCapabilityDefinition(contract.requiredCapability);
    if (!capability) throw new Error("Stored delegation capability is invalid");
    const base: DelegationContractViewBase = {
      id: contract.id,
      source: contract.requestId ? "request" : "owner",
      requiredCapability: contract.requiredCapability,
      capabilityLabel: capability.label,
      providerDepartment: capability.providerDepartment,
      sanitizedTaskSummary: contract.sanitizedTaskSummary,
      personalInformation: contract.personalInformation,
      allowedActions: ["agent.invoke"],
      resultVisibility: contract.resultVisibility,
      maximumUses: 1,
      usesConsumed: contract.usesConsumed,
      remainingUses: Math.max(0, contract.maximumUses - contract.usesConsumed),
      approvedInputCount: contract.approvedResourceIds.length,
      status: contract.status,
      policyReasonCode: this.reasonCodeForStatus(contract.status),
      createdAt: contract.createdAt,
      expiresAt: contract.expiresAt,
      consumedAt: contract.consumedAt,
      revokedAt: contract.revokedAt,
    };
    if (box === "incoming") {
      return {
        ...base,
        box,
        providerLabel: "Privately managed " + capability.providerDepartment + " capability",
        approvedPrompt: contract.approvedPrompt,
      };
    }
    const agent = this.safeGetAgent(contract.agentId);
    return {
      ...base,
      box,
      grantee: {
        id: contract.granteeHumanId,
        displayName: contract.granteeDisplayName,
        department: contract.granteeDepartment,
      },
      agent: { id: contract.agentId, name: agent?.name ?? "Deleted Agent" },
      approvedResources: contract.approvedResourceIds.map((id) => {
        const resource = resources.find((candidate) => candidate.id === id);
        return {
          id,
          name: resource?.name ?? "Unavailable approved input",
          fileName: resource?.fileName ?? "unavailable",
        };
      }),
    };
  }

  private async expireContracts(): Promise<void> {
    const now = this.now();
    const hasExpired = this.store.snapshot().delegationContracts.some(
      (contract) =>
        contract.status === "active" && new Date(contract.expiresAt).getTime() <= now,
    );
    if (!hasExpired) return;
    await this.store.mutate((database) => {
      for (const contract of database.delegationContracts) {
        if (
          contract.status === "active" &&
          new Date(contract.expiresAt).getTime() <= now
        ) {
          contract.status = "expired";
        }
      }
    });
  }

  private runView(run: AgentRun): DelegatedRunView {
    return {
      id: run.id,
      status: run.status,
      output: run.status === "completed" ? run.output : null,
      error: run.status === "failed" ? "The delegated Run failed." : null,
      createdAt: run.createdAt,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
    };
  }

  private async denyInvocation(
    principal: HumanPrincipal,
    contract: DelegationContract,
    requestId: string,
    reasonCode: AuthorizationDecision["reasonCode"],
    reason: string,
    agent: Agent | null,
  ): Promise<never> {
    const decision = this.makeDecision({
      principal,
      requestId,
      action: "agent.invoke",
      targetType: "delegation",
      targetId: contract.id,
      targetLabel: "One-use Agent Trust Pass",
      reasonCode,
      reason,
      decision: "deny",
      ...(agent ? { agent } : {}),
    });
    await this.appendDeniedDecision(decision);
    throw new HttpError(403, "Access denied by Agent Trust Gateway", {
      code: "AUTHORIZATION_DENIED",
      details: this.publicDecision(decision),
    });
  }

  private publicDecision(decision: AuthorizationDecision): AuthorizationDecision {
    return {
      ...decision,
      agentId: null,
      agentName: null,
      targetLabel: "Approved delegated task",
    };
  }

  private reasonCodeForStatus(
    status: DelegationContractStatus,
  ):
    | "DELEGATION_ACTIVE"
    | "DELEGATION_CONSUMED"
    | "DELEGATION_REVOKED"
    | "DELEGATION_EXPIRED" {
    if (status === "consumed") return "DELEGATION_CONSUMED";
    if (status === "revoked") return "DELEGATION_REVOKED";
    if (status === "expired") return "DELEGATION_EXPIRED";
    return "DELEGATION_ACTIVE";
  }

  private safeGetAgent(agentId: string): Agent | null {
    try {
      return this.store.snapshot().agents.find((agent) => agent.id === agentId) ?? null;
    } catch {
      return null;
    }
  }

  private requestView(
    request: DelegationRequest,
    box: "incoming" | "outgoing",
  ): DelegationRequestView {
    const capability = getCapabilityDefinition(request.requiredCapability);
    if (!capability) throw new Error("Stored delegation capability is invalid");
    return {
      id: request.id,
      box,
      requiredCapability: request.requiredCapability,
      capabilityLabel: capability.label,
      providerDepartment: capability.providerDepartment,
      sanitizedTaskSummary: request.sanitizedTaskSummary,
      personalInformation: request.personalInformation,
      taskDigest: request.taskDigest,
      status: request.status,
      createdAt: request.createdAt,
      expiresAt: request.expiresAt,
      contractId: request.contractId,
      ...(box === "incoming"
        ? {
            requester: {
              displayName: request.requesterDisplayName,
              department: request.requesterDepartment,
            },
          }
        : {}),
    };
  }

  private async expireRequests(): Promise<void> {
    const now = this.now();
    const hasExpired = this.store.snapshot().delegationRequests.some(
      (request) =>
        request.status === "pending" && new Date(request.expiresAt).getTime() <= now,
    );
    if (!hasExpired) return;
    await this.store.mutate((database) => {
      for (const request of database.delegationRequests) {
        if (
          request.status === "pending" &&
          new Date(request.expiresAt).getTime() <= now
        ) {
          request.status = "expired";
          request.reviewedAt = this.nowIso();
        }
      }
    });
  }

  private makeDecision(input: {
    principal: HumanPrincipal;
    requestId: string;
    action: AuthorizationDecision["action"];
    targetType: AuthorizationDecision["targetType"];
    targetId: string;
    targetLabel: string;
    reasonCode: AuthorizationDecision["reasonCode"];
    reason: string;
    agent?: Agent;
    decision?: AuthorizationDecision["decision"];
  }): AuthorizationDecision {
    return {
      id: randomUUID(),
      requestId: input.requestId,
      humanUserId: input.principal.id,
      humanEmail: input.principal.email,
      humanDepartment: input.principal.department,
      agentId: input.agent?.id ?? null,
      agentName: input.agent?.name ?? null,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      targetLabel: input.targetLabel,
      decision: input.decision ?? "allow",
      reasonCode: input.reasonCode,
      reason: input.reason,
      createdAt: this.nowIso(),
    };
  }

  private async appendAllowedDecision(decision: AuthorizationDecision): Promise<void> {
    await this.appendAllowedDecisions([decision]);
  }

  private appendAllowedDecisionsToDatabase(
    database: Database,
    decisions: readonly AuthorizationDecision[],
  ): boolean {
    const append = this.securityRepository.appendDecisionsToDatabase;
    if (!append) return false;
    try {
      append.call(this.securityRepository, database, decisions);
      return true;
    } catch {
      throw new HttpError(
        503,
        "Authorization evidence could not be persisted; access failed closed",
        { code: "AUTHORIZATION_AUDIT_UNAVAILABLE" },
      );
    }
  }

  private async appendAllowedDecisions(
    decisions: readonly AuthorizationDecision[],
  ): Promise<void> {
    try {
      await this.securityRepository.appendDecisions(decisions);
    } catch {
      throw new HttpError(
        503,
        "Authorization evidence could not be persisted; access failed closed",
        { code: "AUTHORIZATION_AUDIT_UNAVAILABLE" },
      );
    }
  }

  private async appendDeniedDecision(decision: AuthorizationDecision): Promise<void> {
    try {
      await this.securityRepository.appendDecision(decision);
    } catch {
      // The request remains denied even if the evidence sink is unavailable.
    }
  }

  private async withTransitionLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.transitionTail;
    let release!: () => void;
    this.transitionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private nowIso(): string {
    return new Date(this.now()).toISOString();
  }
}

export function knownHumanFromPrincipal(
  principal: HumanPrincipal,
  lastSeenAt: string,
): KnownHuman {
  return { ...principal, lastSeenAt };
}
