import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const actions = [
  "agent.create", "agent.read", "agent.update", "agent.delete", "agent.revoke",
  "agent.start", "agent.stop", "agent.invoke", "run.read", "resource.read",
  "file.read", "file.write", "shell.execute", "network.request",
];
const targetTypes = ["agent", "run", "resource", "file", "command", "network"];
const reasonCodes = [
  "OWNER_MATCH", "HUMAN_AGENT_OWNER_MISMATCH", "AGENT_REVOKED",
  "AGENT_RESOURCE_OWNER_MISMATCH", "WORKSPACE_PATH_ALLOWED", "PATH_OUTSIDE_WORKSPACE",
  "PROTECTED_SECRET_FILE", "FILE_TOO_LARGE", "RUNTIME_COMMAND_ALLOWED",
  "RUNTIME_COMMAND_DENIED", "RUNTIME_NETWORK_DENIED",
];

describe("Supabase authorization schema contract", () => {
  it("contains every application decision value in the explicit migration whitelists", async () => {
    const migration = await readFile(
      path.resolve(process.cwd(), "../../supabase/migrations/202608290001_authorization_decision_whitelists.sql"),
      "utf8",
    );
    for (const value of [...actions, ...targetTypes, ...reasonCodes]) {
      expect(migration).toContain("'" + value + "'");
    }
  });
});
