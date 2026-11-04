import { generateKeyPair, SignJWT } from "jose";
import { afterEach, expect, test, vi } from "vitest";
import { createOidcCore } from "./core.js";
import { parseCookies } from "./cookies.js";

afterEach(() => vi.unstubAllGlobals());

test("binds max_age to the flow and uses the validated ID token's auth_time", async () => {
	const issuer = "https://issuer.test";
	const clientId = "app";
	const now = Math.floor(Date.now() / 1000);
	const { privateKey } = await generateKeyPair("RS256");
	let nonce: string;
	let authTime: number | undefined;
	vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (url) => {
		if (String(url).endsWith("/token")) {
			const token = await new SignJWT({ auth_time: authTime, nonce, email: "alice@test.example", roles: [] })
				.setProtectedHeader({ alg: "RS256" }).setIssuer(issuer).setAudience(clientId)
				.setSubject("alice").setIssuedAt(now).setExpirationTime(now + 3600).sign(privateKey);
			return Response.json({ token_type: "Bearer", access_token: "access", expires_in: 3600, id_token: token });
		}
		return Response.json({ issuer, authorization_endpoint: issuer + "/authorize", token_endpoint: issuer + "/token" });
	}));
	const auth = createOidcCore({
		environment: () => ({
			OIDC_ISSUER: issuer, OIDC_CLIENT_ID: clientId, OIDC_CLIENT_SECRET: "secret",
			SESSION_SECRET: "test-only-session-secret-at-least-32-characters",
		}),
		allowSession: () => true,
		registry: { isActive: async () => true, register: vi.fn(), end: vi.fn(), endAll: vi.fn(), applyLogout: vi.fn() },
	});
	const request = new Request("https://app.test/");
	for (const [time, maxAge, shouldPass] of [
		[undefined, 300, false], [now - 900, 300, false], [now + 900, 300, false],
		[now - 60, 300, true], [now, 0, true], [undefined, undefined, true],
	] as const) {
		authTime = time;
		const start = await auth.signIn(request, new Map(), { maxAge });
		const params = new URL(start.url).searchParams;
		expect(params.get("max_age")).toBe(maxAge === undefined ? null : String(maxAge));
		nonce = params.get("nonce")!;
		const callback = new URL(params.get("redirect_uri")!);
		callback.search = new URLSearchParams({ state: params.get("state")!, code: "c", max_age: "86400" }).toString();
		const cookies = parseCookies(start.setCookies[0].split(";")[0]);
		const result = await auth.callback(new Request(callback), cookies);
		if (shouldPass) {
			expect(result.ok).toBe(true);
			const session = await auth.resolve(new Request(request, { headers: { cookie: result.setCookies[0].split(";")[0] } }));
			expect(session.session?.user.sub).toBe("alice");
			expect(session.session?.authTime).toBe(time);
		} else {
			expect(result).toMatchObject({ ok: false, reason: "token_exchange_failed" });
			expect(result.setCookies).toEqual([expect.stringContaining("Max-Age=0")]);
		}
	}
});
