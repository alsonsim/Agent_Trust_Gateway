import path from "node:path";
import { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import { ensureWritableDataDirectory, loadConfig, writeCodexConfig } from "./config.js";
import {
  DemoIdentityProvider,
  isLoopbackHost,
  SupabaseIdentityProvider,
} from "./identity-provider.js";
import { createRunner } from "./runner-factory.js";
import { RuntimeActionFirewall } from "./runtime-action-firewall.js";
import { writeRuntimeExecPolicy } from "./runtime-execpolicy.js";
import {
  LocalSecurityRepository,
  SupabaseSecurityRepository,
} from "./security-repository.js";
import { JsonStore } from "./store.js";
import { TrustGateway } from "./trust-gateway.js";
import { WorkspaceManager } from "./workspace.js";

const config = loadConfig();
await ensureWritableDataDirectory(config.dataDirectory);
await writeCodexConfig(config);
await writeRuntimeExecPolicy(config.codexHome);

const store = new JsonStore(path.join(config.dataDirectory, "launchpad.json"));
const workspaces = new WorkspaceManager(config.workspaceRoot);
const securityRepository =
  config.authMode === "supabase"
    ? new SupabaseSecurityRepository(
        config.supabaseUrl,
        config.supabasePublicKey,
      config.supabaseSecretKey,
    )
    : new LocalSecurityRepository(store, config.dataDirectory);
const runner = createRunner(config);
const service = new AgentService(
  config,
  store,
  workspaces,
  runner,
  new RuntimeActionFirewall(securityRepository),
);
await service.initialize();
await securityRepository.initialize();
const identityProvider =
  config.authMode === "supabase"
    ? new SupabaseIdentityProvider({
        supabaseUrl: config.supabaseUrl,
        anonKey: config.supabasePublicKey,
        serviceRoleKey: config.supabaseSecretKey,
      })
    : new DemoIdentityProvider({
        host: config.host,
        allowNonLoopback:
          config.authMode === "legacy" ||
          config.nodeEnv !== "production" ||
          config.allowInsecureDemoAuth ||
          isLoopbackHost(config.host),
        signingKey: config.authSessionSecret,
        tokenTtlSeconds: config.authSessionTtlSeconds,
      });
const gateway = new TrustGateway(identityProvider, securityRepository, service);

const app = await createApp(config, service, gateway);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Shutting down");
  await app.close();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: config.host, port: config.port });
