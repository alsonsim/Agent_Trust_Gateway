import { randomUUID } from "node:crypto";
import {
  assessPersonalInformation,
  discoverCapability,
  getCapabilityDefinition,
  sanitizeTaskSummary,
} from "./capability-broker.js";
import { digestExactPrompt } from "./delegation-digest.js";
import { HttpError } from "./errors.js";
import type { HumanPrincipal } from "./identity-provider.js";
import type { SecurityRepository } from "./security-repository.js";
import { JsonStore } from "./store.js";
import type {
  AuthorizationDecision,
  DelegationRequest,
  DelegationRequestStatus,
  Department,
  KnownHuman,
} from "./types.js";

const REQUEST_TTL_MS = 30 * 60 * 1_000;

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
  }): AuthorizationDecision {
    return {
      id: randomUUID(),
      requestId: input.requestId,
      humanUserId: input.principal.id,
      humanEmail: input.principal.email,
      humanDepartment: input.principal.department,
      agentId: null,
      agentName: null,
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
