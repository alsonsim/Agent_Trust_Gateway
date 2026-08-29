import { randomUUID } from "node:crypto";
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

export class DelegationService {
  constructor(
    private readonly store: JsonStore,
    private readonly securityRepository: SecurityRepository,
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
      sanitizedTaskSummary?: string;
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
    const timestamp = this.nowIso();
    const request: DelegationRequest = {
      id: randomUUID(),
      requesterHumanId: principal.id,
      requesterEmail: principal.email,
      requesterDisplayName: principal.displayName,
      requesterDepartment: principal.department,
      requiredCapability: capability.id,
      sanitizedTaskSummary: sanitizeTaskSummary(
        input.sanitizedTaskSummary ?? input.prompt,
      ),
      personalInformation: assessPersonalInformation(input.prompt),
      requestedPrompt: input.prompt,
      taskDigest: digestExactPrompt(input.prompt),
      status: "pending",
      createdAt: timestamp,
      expiresAt: new Date(this.now() + REQUEST_TTL_MS).toISOString(),
      reviewedAt: null,
      contractId: null,
    };
    await this.store.mutate((database) => database.delegationRequests.push(request));
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
    await this.appendAllowedDecision(decision);
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
    await this.expireRequests();
    const updated = await this.store.mutate((database) => {
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
      return structuredClone(request);
    });
    const capability = getCapabilityDefinition(updated.requiredCapability)!;
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
    await this.appendAllowedDecision(decision);
    return { request: this.requestView(updated, "incoming"), decision };
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
        approvedPrompt: request.requestedPrompt,
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
      sanitizedTaskSummary?: string;
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
        sanitizedTaskSummary: sanitizeTaskSummary(
          input.sanitizedTaskSummary ?? input.exactPrompt,
        ),
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
    await this.expireContracts();
    const updated = await this.store.mutate((database) => {
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
      return structuredClone(contract);
    });
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
    await this.appendAllowedDecision(decision);
    const resources = await this.securityRepository.listResources();
    return {
      contract: this.contractView(updated, "outgoing", resources),
      decision,
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
    await this.store.mutate((database) => {
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
    });
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
    try {
      await this.appendAllowedDecision(decision);
    } catch (error) {
      await this.store.mutate((database) => {
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
      decision: "allow",
      reasonCode: input.reasonCode,
      reason: input.reason,
      createdAt: this.nowIso(),
    };
  }

  private async appendAllowedDecision(decision: AuthorizationDecision): Promise<void> {
    try {
      await this.securityRepository.appendDecision(decision);
    } catch {
      throw new HttpError(
        503,
        "Authorization evidence could not be persisted; access failed closed",
        { code: "AUTHORIZATION_AUDIT_UNAVAILABLE" },
      );
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
