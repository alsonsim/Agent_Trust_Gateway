import { digestExactPrompt } from "./delegation-digest.js";
import type { Department } from "./types.js";

export type CapabilityId =
  | "frontend.interface-implementation"
  | "backend.service-implementation"
  | "qa.release-validation";

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
    id: "frontend.interface-implementation",
    label: "Frontend interface implementation",
    providerDepartment: "frontend",
    description: "Typed interfaces, components, layout, and accessibility implementation.",
  }),
  Object.freeze({
    id: "backend.service-implementation",
    label: "Backend service implementation",
    providerDepartment: "backend",
    description: "API, service, data-model, and server-side authorization implementation.",
  }),
  Object.freeze({
    id: "qa.release-validation",
    label: "QA release validation",
    providerDepartment: "qa",
    description: "Regression, smoke-test, acceptance, and release-readiness validation.",
  }),
]);

const capabilitySignals: Readonly<Record<CapabilityId, readonly RegExp[]>> = {
  "frontend.interface-implementation": [
    /\b(?:frontend|user interface|ui implementation|react|component|client-side|web interface|page layout|css|accessibility)\b/i,
    /\b(?:build|create|implement|design)\b[\s\S]{0,80}\b(?:screen|page|component|interface|layout|form)\b/i,
  ],
  "backend.service-implementation": [
    /\b(?:backend|api|endpoint|database|data model|schema|server|service layer|middleware|authentication|authorization)\b/i,
    /\b(?:build|create|implement|design)\b[\s\S]{0,80}\b(?:handler|endpoint|service|api|schema|database)\b/i,
  ],
  "qa.release-validation": [
    /\b(?:qa|quality assurance|test plan|test suite|smoke test|regression test|release validation|release readiness|acceptance test)\b/i,
    /\b(?:test|validate|verify)\b[\s\S]{0,80}\b(?:release|workflow|feature|regression|failure|authorization)\b/i,
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
