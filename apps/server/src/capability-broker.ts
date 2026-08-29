import { digestExactPrompt } from "./delegation-digest.js";
import type { Department } from "./types.js";

export type CapabilityId =
  | "finance.cost-analysis"
  | "hr.people-operations"
  | "research.evidence-synthesis";

export type PersonalInformationAssessment = "none_detected" | "possible";

export interface CapabilityDefinition {
  readonly id: CapabilityId;
  readonly label: string;
  readonly providerDepartment: Department;
  readonly description: string;
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

export const CAPABILITY_CATALOG: readonly CapabilityDefinition[] = Object.freeze([
  Object.freeze({
    id: "finance.cost-analysis",
    label: "Finance cost analysis",
    providerDepartment: "finance",
    description: "Budget, spend, forecast, and financial-impact analysis.",
  }),
  Object.freeze({
    id: "hr.people-operations",
    label: "HR people operations",
    providerDepartment: "hr",
    description: "People policies, onboarding, benefits, and employee operations.",
  }),
  Object.freeze({
    id: "research.evidence-synthesis",
    label: "Research evidence synthesis",
    providerDepartment: "research",
    description: "Literature, study, source, and evidence synthesis.",
  }),
]);

const capabilitySignals: Readonly<Record<CapabilityId, readonly RegExp[]>> = {
  "finance.cost-analysis": [
    /\b(?:budget|cost|spend|expense|expenditure|cash flow|financial analysis|financial impact|cost analysis|cost estimate|budget impact|payroll cost|salary spend)\b/i,
    /\b(?:hire|hiring|headcount)\b[\s\S]{0,80}\b(?:budget|cost|salary|spend|financial)\b/i,
    /\b(?:budget|cost|salary|spend|financial)\b[\s\S]{0,80}\b(?:hire|hiring|headcount)\b/i,
  ],
  "hr.people-operations": [
    /\b(?:people operations|employee relations|onboarding|offboarding|leave policy|benefits policy|performance review|recruitment workflow|hiring policy|workforce policy|staff retention)\b/i,
    /\b(?:employee|staff|workforce)\b[\s\S]{0,60}\b(?:policy|benefits|onboarding|retention|relations)\b/i,
  ],
  "research.evidence-synthesis": [
    /\b(?:evidence synthesis|literature review|systematic review|research evidence|study findings|citation review|source comparison|research synthesis)\b/i,
    /\b(?:synthesize|compare|review|summarize)\b[\s\S]{0,60}\b(?:papers|studies|sources|evidence|literature)\b/i,
  ],
};

const personalInformationPatterns = [
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
  /\b[STFGM]\d{7}[A-Z]\b/gi,
  /\b\d{3}-\d{2}-\d{4}\b/g,
  /\+?\d{1,3}[\s.-](?:\(?\d{2,4}\)?[\s.-]){1,3}\d{3,4}\b/g,
  /\b(?:employee|staff|passport|national)\s*(?:id|number)\s*[:#=-]\s*[A-Z0-9-]{3,}\b/gi,
  /\b(?:full\s+name|employee\s+name)\s*:\s*[^\n,;]{2,80}/gi,
] as const;

const secretPatterns = [
  /\b(?:api[_ -]?key|access[_ -]?token|password|secret)\s*[:=]\s*[^\s,;]+/gi,
  /\bBearer\s+[A-Za-z0-9._~-]+/gi,
] as const;

const MAX_SANITIZED_SUMMARY_LENGTH = 280;

export function getCapabilityDefinition(id: string): CapabilityDefinition | null {
  return CAPABILITY_CATALOG.find((definition) => definition.id === id) ?? null;
}

export function assessPersonalInformation(value: string): PersonalInformationAssessment {
  return personalInformationPatterns.some((pattern) => {
    pattern.lastIndex = 0;
    const matched = pattern.test(value);
    pattern.lastIndex = 0;
    return matched;
  })
    ? "possible"
    : "none_detected";
}

export function sanitizeTaskSummary(value: string): string {
  let sanitized = value;
  for (const pattern of personalInformationPatterns) {
    pattern.lastIndex = 0;
    sanitized = sanitized.replace(pattern, "[personal information redacted]");
  }
  for (const pattern of secretPatterns) {
    pattern.lastIndex = 0;
    sanitized = sanitized.replace(pattern, "[secret redacted]");
  }
  sanitized = sanitized.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!sanitized) return "(empty task)";
  return sanitized.slice(0, MAX_SANITIZED_SUMMARY_LENGTH);
}

export function discoverCapability(
  prompt: string,
  requesterDepartment: Department,
): CapabilityDiscovery {
  const definition = selectCapability(prompt);
  return {
    required:
      definition !== null && definition.providerDepartment !== requesterDepartment,
    capability: definition?.id ?? null,
    capabilityLabel: definition?.label ?? null,
    providerDepartment: definition?.providerDepartment ?? null,
    sanitizedTaskSummary: sanitizeTaskSummary(prompt),
    taskDigest: digestExactPrompt(prompt),
    personalInformation: assessPersonalInformation(prompt),
  };
}

function selectCapability(prompt: string): CapabilityDefinition | null {
  let selected: CapabilityDefinition | null = null;
  let highestScore = 0;
  for (const definition of CAPABILITY_CATALOG) {
    const score = capabilitySignals[definition.id].reduce(
      (total, signal) => total + (signal.test(prompt) ? 1 : 0),
      0,
    );
    if (score > highestScore) {
      selected = definition;
      highestScore = score;
    }
  }
  return selected;
}
