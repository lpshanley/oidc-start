import { afterEach, expect, test, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { createOidcCore } from "./core.js";
import { createMemorySessionRegistry, type SessionRegistry } from "./registry.js";
import { parseCookies } from "./cookies.js";

const issuer = "https://issuer.test", clientId = "client";
const scope = { issuer, clientId };
const env = { OIDC_ISSUER: issuer, OIDC_CLIENT_ID: clientId, OIDC_CLIENT_SECRET: "secret",
	SESSION_SECRET: "test-only-session-secret-at-least-32-characters", APP_ORIGIN: "https://app.test" };
const events = { "http://schemas.openid.net/event/backchannel-logout": {} };
afterEach(() => vi.unstubAllGlobals());
function apply(jar: Map<string, string>, lines: string[]) {
	for (const line of lines) {
		const pair = parseCookies(line.split(";")[0]);
		for (const [key, value] of pair) if (line.includes("Max-Age=0")) jar.delete(key); else jar.set(key, value);
	}
	return jar;
}
const request = (jar: Map<string, string>) => new Request("https://app.test/", {
	headers: { cookie: [...jar].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("; ") },
});
async function fixture(registry: SessionRegistry = createMemorySessionRegistry()) {
	const rsa = await generateKeyPair("RS256"), ec = await generateKeyPair("ES256");
	const keys = await Promise.all([rsa.publicKey, ec.publicKey].map(exportJWK));
	const nonces = new Map<string, string>();
	const now = () => Math.floor(Date.now() / 1000);
	vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
		const url = String(input);
		if (url.endsWith("/keys")) return Response.json({ keys: [{ ...keys[0], kid: "rsa", alg: "RS256" }, { ...keys[1], kid: "ec", alg: "ES256" }] });
		if (url.endsWith("/revoke")) return new Response(null, { status: 200 });
		if (url.endsWith("/token")) {
			const params = new URLSearchParams(String(init?.body));
			const token = await new SignJWT({ nonce: nonces.get(params.get("code")!), sid: "stable-sso", roles: [] })
				.setProtectedHeader({ alg: "RS256", kid: "rsa" }).setIssuer(issuer).setAudience(clientId)
				.setSubject("alice").setIssuedAt().setExpirationTime(now() + 3600).sign(rsa.privateKey);
			return Response.json({ access_token: "access", refresh_token: "refresh", token_type: "Bearer", expires_in: 3600, id_token: token });
		}
		return Response.json({ issuer, authorization_endpoint: issuer + "/authorize", token_endpoint: issuer + "/token",
			jwks_uri: issuer + "/keys", revocation_endpoint: issuer + "/revoke", end_session_endpoint: issuer + "/logout",
			id_token_signing_alg_values_supported: ["RS256"] });
	}));
	const core = () => createOidcCore({ registry, environment: () => env, onError: vi.fn() });
	const a = core(), b = core();
	async function login(auth = a) {
		const jar = new Map<string, string>();
		const start = await auth.signIn(request(jar), jar);
		apply(jar, start.setCookies);
		const params = new URL(start.url).searchParams;
		const code = crypto.randomUUID();
		nonces.set(code, params.get("nonce")!);
		const callback = new URL(params.get("redirect_uri")!);
		callback.search = new URLSearchParams({ code, state: params.get("state")! }).toString();
		const result = await auth.callback(new Request(callback), jar);
		return { jar: apply(jar, result.setCookies), result };
	}
	async function token({ id = crypto.randomUUID(), sid = "stable-sso", alg = "RS256" } = {}) {
		return new SignJWT({ events, sub: "alice", ...(sid && { sid }) })
			.setProtectedHeader({ alg, kid: alg === "RS256" ? "rsa" : "ec", typ: "logout+jwt" })
			.setIssuer(issuer).setAudience(clientId).setIssuedAt().setExpirationTime(now() + 300)
			.setJti(id).sign(alg === "RS256" ? rsa.privateKey : ec.privateKey);
	}
	const deliver = async (signed: string, auth = a) => auth.backchannelLogout(new Request("https://app.test/logout/backchannel", {
		method: "POST", body: new URLSearchParams({ logout_token: signed }),
	}));
	return { a, b, login, token, deliver, registry };
}

test("logout rejects the old cookie while a new authorization with the same provider sid succeeds", async () => {
	const { a, b, login, token, deliver } = await fixture();
	const first = await login();
	expect(first.result.ok).toBe(true);
	const current = await a.resolve(request(first.jar));
	expect(current.status).toBe("authenticated");
	expect(current.session?.user.email).toBeUndefined();
	await a.signOut(request(first.jar), first.jar, current.session);
	const logout = await token();
	expect(await deliver(logout, b)).toEqual({ status: 200 });
	expect((await b.resolve(request(first.jar))).status).toBe("anonymous");
	const second = await login(b);
	const next = await a.resolve(request(second.jar));
	expect(next.status).toBe("authenticated");
	expect(next.session?.idpSid).toBe(current.session?.idpSid);
	expect(next.session?.sid).not.toBe(current.session?.sid);
	expect(await deliver(logout)).toEqual({ status: 200 });
	expect((await b.resolve(request(second.jar))).status).toBe("authenticated");
});

test("a distinct delayed logout ends current matches but never prohibits later login", async () => {
	const { a, b, login, token, deliver } = await fixture();
	const delayed = await token();
	const first = await login(), second = await login(b);
	expect(await deliver(delayed)).toEqual({ status: 200 });
	for (const { jar } of [first, second]) expect((await a.resolve(request(jar))).reason).toBe("session_ended");
	const third = await login();
	expect((await b.resolve(request(third.jar))).status).toBe("authenticated");
});

test("subject-only logout and local sign-out everywhere end existing app sessions", async () => {
	const { a, login, token, deliver } = await fixture();
	const first = await login(), second = await login();
	expect(await deliver(await token({ sid: "" }))).toEqual({ status: 200 });
	for (const { jar } of [first, second]) expect((await a.resolve(request(jar))).status).toBe("anonymous");
	const third = await login(), fourth = await login();
	const session = (await a.resolve(request(third.jar))).session;
	const out = await a.signOut(request(third.jar), third.jar, session, undefined, { everywhere: true, providerLogout: false });
	expect(out.location).toBe("https://app.test/login");
	expect((await a.resolve(request(fourth.jar))).reason).toBe("session_ended");
});

test("registry registration failure never issues a session cookie", async () => {
	const registry = createMemorySessionRegistry();
	registry.register = async () => { throw new Error("store unavailable"); };
	const { login } = await fixture(registry);
	const { result, jar } = await login();
	expect(result).toMatchObject({ ok: false, reason: "session_failed" });
	expect(jar.size).toBe(0);
});

test("logout storage failure is not acknowledged, and retry succeeds", async () => {
	const { a, registry, login, token, deliver } = await fixture();
	const first = await login();
	vi.spyOn(registry, "applyLogout").mockRejectedValueOnce(new Error("db down"));
	const logout = await token();
	expect(await deliver(logout)).toEqual({ status: 400 });
	expect((await a.resolve(request(first.jar))).status).toBe("authenticated");
	expect(await deliver(logout)).toEqual({ status: 200 });
	expect((await a.resolve(request(first.jar))).status).toBe("anonymous");
});

test("a correctly signed but unadvertised logout algorithm is rejected without ending sessions", async () => {
	const { a, login, token, deliver } = await fixture();
	const first = await login();
	expect(await deliver(await token({ alg: "ES256" }))).toEqual({ status: 400 });
	expect((await a.resolve(request(first.jar))).status).toBe("authenticated");
});

test("registry expiry, scope isolation, and duplicate handling do not depend on cleanup", async () => {
	let now = 100;
	const registry = createMemorySessionRegistry(() => now);
	const base = { ...scope, sid: "one", sub: "alice", idpSid: "sso", expiresAt: 200 };
	for (const s of [base, { ...base, clientId: "other" }, { ...base, issuer: "https://other.test" }]) await registry.register(s);
	const event = { ...scope, idpSid: "sso", sub: "alice", jti: "event", issuedAt: 100, expiresAt: 300 };
	await registry.applyLogout(event);
	expect(await registry.isActive(base)).toBe(false);
	expect(await registry.isActive({ ...base, clientId: "other" })).toBe(true);
	expect(await registry.isActive({ ...base, issuer: "https://other.test" })).toBe(true);
	await registry.register(base);
	await registry.applyLogout(event);
	expect(await registry.isActive(base)).toBe(true);
	now = 200;
	expect(await registry.isActive(base)).toBe(false);
});
