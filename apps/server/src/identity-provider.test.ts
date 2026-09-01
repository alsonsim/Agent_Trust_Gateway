import { describe, expect, it, vi } from "vitest";
import {
  DemoIdentityProvider,
  SupabaseIdentityProvider,
} from "./identity-provider.js";

describe("identity providers", () => {
  it("issues a signed demo identity and rejects tampering", async () => {
    const provider = new DemoIdentityProvider({
      host: "127.0.0.1",
      signingKey: "a-test-signing-key-that-is-at-least-32-bytes",
      tokenTtlSeconds: 600,
    });
    const session = await provider.signIn({
      email: "Frontend@bytedance.com",
      password: "test-password",
    });
    await expect(provider.verifyAccessToken(session.accessToken)).resolves.toMatchObject({
      displayName: "Frontend",
      department: "frontend",
    });
    const [header, body, signature] = session.accessToken.split(".");
    const tamperedSignature =
      (signature?.startsWith("A") ? "B" : "A") + signature!.slice(1);
    const tampered = `${header}.${body}.${tamperedSignature}`;
    await expect(provider.verifyAccessToken(tampered)).rejects.toMatchObject({
      statusCode: 401,
    });
    await expect(
      provider.signIn({
        email: "unknown@bytedance.com",
        password: "test-password",
      }),
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  it("accepts the judge demo password and rejects wrong typed demo passwords", async () => {
    const provider = new DemoIdentityProvider({
      host: "127.0.0.1",
      signingKey: "a-test-signing-key-that-is-at-least-32-bytes",
      tokenTtlSeconds: 600,
    });

    await expect(
      provider.signIn({
        email: "frontend@bytedance.com",
        password: "test-password",
      }),
    ).resolves.toMatchObject({
      principal: { email: "frontend@bytedance.com" },
    });
    await expect(
      provider.signIn({
        email: "frontend@bytedance.com",
        password: "wrong-password",
      }),
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  it("loads the authoritative Supabase profile after validating the token", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ access_token: "signed-access-token", expires_in: 3_600 }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "33333333-3333-4333-8333-333333333333",
            email: "qa@bytedance.com",
            user_metadata: { department: "frontend" },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              id: "33333333-3333-4333-8333-333333333333",
              display_name: "QA",
              department: "qa",
            },
          ]),
          { status: 200 },
        ),
      );
    const provider = new SupabaseIdentityProvider({
      supabaseUrl: "http://127.0.0.1:54321",
      anonKey: "anon-key",
      serviceRoleKey: "server-secret-key",
      fetchImpl: fetchMock,
    });
    const session = await provider.signIn({
      email: "qa@bytedance.com",
      password: "not-logged",
    });
    expect(session.principal.department).toBe("qa");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2]?.[0].toString()).toContain("/rest/v1/profiles");
  });

  it("keeps demo identity off non-loopback hosts unless explicitly enabled", () => {
    expect(
      () =>
        new DemoIdentityProvider({
          host: "0.0.0.0",
          signingKey: "a-test-signing-key-that-is-at-least-32-bytes",
        }),
    ).toThrow(/loopback/);
  });
});
