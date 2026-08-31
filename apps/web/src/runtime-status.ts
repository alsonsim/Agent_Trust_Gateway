import type { RuntimeCapabilities, SystemInfo } from "./types";

export type RuntimeStatusTone = "checking" | "ready" | "blocked";

export function runtimeProviderLabel(
  provider: SystemInfo["runtimeProvider"] | undefined,
): string {
  switch (provider) {
    case "offline-demo":
      return "Offline judge demo";
    case "container":
      return "Disposable Agent container";
    case "application-container":
      return "Application container profile";
    case "local-process":
      return "Local Node.js process";
    default:
      return "Checking Runtime";
  }
}

export function runtimeStatusTone(system: SystemInfo | null): RuntimeStatusTone {
  if (!system) return "checking";
  return system.executionReady ? "ready" : "blocked";
}

export function runtimeStatusLabel(system: SystemInfo | null): string {
  if (!system) return "Checking Runtime…";
  return system.executionReady ? "Local checks passed" : "Runtime checks blocked";
}

export function runtimePrimaryBlocker(system: SystemInfo | null): string | null {
  if (!system || system.executionReady) return null;
  return (
    system.blockers[0]?.message ??
    (!system.arkConfigured
      ? "Configure ARK_API_KEY and ARK_MODEL before starting a Run."
      : !system.codexAvailable
        ? "The selected Runtime cannot start the Codex CLI."
        : "The selected Runtime is not ready to execute Agent Runs.")
  );
}

export function runtimeExecutionBoundaryLabel(
  value: RuntimeCapabilities["executionBoundary"],
): string {
  switch (value) {
    case "offline-demo":
      return "Offline deterministic runner";
    case "disposable-container":
      return "Disposable container per Run";
    case "application-container":
      return "Application container profile (orchestrator-managed)";
    case "host-process":
      return "Host Node.js process";
  }
}

export function runtimeWorkspaceLabel(
  value: RuntimeCapabilities["workspaceIsolation"],
): string {
  return value === "filtered-owner-projection"
    ? "Filtered owner-only projection"
    : "Logical owner directory (no mount boundary)";
}

export function runtimeNetworkLabel(
  value: RuntimeCapabilities["networkPolicy"],
): string {
  switch (value) {
    case "offline-demo-network-disabled":
      return "Network unused";
    case "container-network-blocked":
      return "Container network blocked";
    case "local-debug-network":
      return "Local debug network enabled";
    case "application-container-network":
      return "Application container network";
    case "middleware-and-codex-policy":
      return "Middleware and Codex policy";
  }
}

export function runtimeCredentialLabel(
  value: RuntimeCapabilities["credentialPolicy"],
): string {
  switch (value) {
    case "offline-demo-no-credentials":
      return "No provider credentials";
    case "not-forwarded":
      return "Credentials not forwarded";
    case "local-debug-forwarded":
      return "Local debug forwarding enabled";
    case "application-container-environment":
      return "Application container environment";
    case "server-process-environment":
      return "Server process environment";
  }
}

export function codexVersionMatches(system: SystemInfo): boolean {
  if (system.runtimeProvider === "offline-demo") return true;
  if (!system.codexVersion || !system.codexExpectedVersion) return false;
  return system.codexVersion === system.codexExpectedVersion;
}
