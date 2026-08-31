import { describe, expect, it } from "vitest";
import {
  codexVersionMatches,
  runtimeCredentialLabel,
  runtimeNetworkLabel,
  runtimePrimaryBlocker,
  runtimeProviderLabel,
  runtimeStatusLabel,
  runtimeWorkspaceLabel,
} from "./runtime-status";
import type { SystemInfo } from "./types";

function systemInfo(overrides: Partial<SystemInfo> = {}): SystemInfo {
  return {
    arkConfigured: true,
    arkBaseUrl: "https://ark.example.test/api/v3",
    arkModel: "ep-test",
    codexExecutable: "codex",
    codexExecutableSource: "platform-default",
    codexAvailable: true,
    codexVersion: "0.151.0",
    codexExpectedVersion: "0.151.0",
    codexSandboxMode: "workspace-write",
    runtimeProvider: "container",
    containerEngine: "docker",
    containerRuntimeImage: "volc-agent-runtime:local",
    executionReady: true,
    delegatedRunsAvailable: true,
    blockers: [],
    capabilities: {
      executionBoundary: "disposable-container",
      workspaceIsolation: "filtered-owner-projection",
      networkPolicy: "local-debug-network",
      credentialPolicy: "local-debug-forwarded",
      readOnlyRoot: true,
      capabilitiesDropped: true,
      noNewPrivileges: true,
      resourceLimits: true,
      protectedFileProjection: true,
    },
    runtime: "Codex CLI in Docker Agent Runtime",
    ...overrides,
  };
}

describe("Runtime status presentation", () => {
  it("names each execution boundary without describing npm mode as Docker", () => {
    expect(runtimeProviderLabel("offline-demo")).toBe("Offline judge demo");
    expect(runtimeProviderLabel("local-process")).toBe("Local Node.js process");
    expect(runtimeProviderLabel("application-container")).toBe(
      "Application container profile",
    );
    expect(runtimeProviderLabel("container")).toBe("Disposable Agent container");
  });

  it("shows the backend blocker when execution is unavailable", () => {
    const system = systemInfo({
      executionReady: false,
      delegatedRunsAvailable: false,
      blockers: [{ code: "RUNTIME_NETWORK_BLOCKED", message: "Network access is blocked." }],
    });

    expect(runtimeStatusLabel(system)).toBe("Runtime checks blocked");
    expect(runtimePrimaryBlocker(system)).toBe("Network access is blocked.");
  });

  it("describes the security-sensitive network and credential modes", () => {
    expect(runtimeNetworkLabel("offline-demo-network-disabled")).toBe("Network unused");
    expect(runtimeCredentialLabel("offline-demo-no-credentials")).toBe(
      "No provider credentials",
    );
    expect(runtimeNetworkLabel("container-network-blocked")).toBe(
      "Container network blocked",
    );
    expect(runtimeCredentialLabel("not-forwarded")).toBe("Credentials not forwarded");
    expect(runtimeWorkspaceLabel("logical-owner-directory")).toBe(
      "Logical owner directory (no mount boundary)",
    );
  });

  it("compares the probed CLI version with the image contract", () => {
    expect(codexVersionMatches(systemInfo())).toBe(true);
    expect(codexVersionMatches(systemInfo({ codexVersion: "0.110.0" }))).toBe(
      false,
    );
  });
});
