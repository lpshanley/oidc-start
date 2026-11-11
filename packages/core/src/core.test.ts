import { beforeEach, describe, expect, test, vi } from "vitest";
import { verifierCookieName } from "./state.js";
import { OidcDeadlineError, withinDeadline } from "./deadline.js";

const oidc = vi.hoisted(() => {
	const metadata: Record<string, string> = {
		end_session_endpoint: "https://idp.test/logout",
	};
	return {
		customFetch: Symbol("fetch"),
		metadata,
		discovery: vi.fn(async (..._args: unknown[]) => ({
			serverMetadata: () => metadata,
		})),
		allowInsecureRequests: vi.fn(),
		randomNonce: vi.fn(() => "nonce-1"),
		randomState: () => crypto.randomUUID(),
		randomPKCECodeVerifier: vi.fn(() => "verifier-1"),
		calculatePKCECodeChallenge: vi.fn(async () => "challenge"),
		buildAuthorizationUrl: vi.fn(
			(_: unknown, params: Record<string, string>) =>
				new URL(`https://idp.test/authorize?${new URLSearchParams(params)}`),
		),
		authorizationCodeGrant: vi.fn(async (..._args: unknown[]) => ({
			access_token: "access",
			refresh_token: "refresh",
			id_token: "id-token",
			claims: () => ({
				sub: "alice",
				email: "alice@sage.test",
				name: "Alice",
				roles: ["stellar"],
			}),
			expiresIn: () => 300,
		})),
		refreshTokenGrant: vi.fn(),
		tokenRevocation: vi.fn(async () => {}),
		fetchUserInfo: vi.fn(),
		buildEndSessionUrl: vi.fn(
			(_: unknown, params: Record<string, string>) =>
				new URL(`https://idp.test/logout?${new URLSearchParams(params)}`),
		),
	};
});
vi.mock("openid-client", () => oidc);

const {
	createOidcCore,
	SessionAccessDeniedError,
} = await import("./core.js");

const env = {
	SESSION_SECRET: "test-only-session-secret-at-least-32-characters",
	OIDC_ISSUER: "https://idp.test/application/o/sage/",
	OIDC_CLIENT_ID: "sage-web",
	OIDC_CLIENT_SECRET: "secret",
	APP_ORIGIN: "https://sage.test",
};

const allowSession = (user: { sub: string }) => user.sub === "alice";

const registry = {
	isActive: vi.fn(async () => true),
	register: vi.fn(async () => {}), end: vi.fn(async () => {}),
	endAll: vi.fn(async () => {}),
	applyLogout: vi.fn(async () => {}),
};

function apply(jar: Map<string, string>, lines: string[]) {
	for (const line of lines) {
		const [pair = ""] = line.split(";");
		const name = pair.slice(0, pair.indexOf("="));
		if (/Max-Age=0(;|$)/.test(line)) jar.delete(name);
		else jar.set(name, decodeURIComponent(pair.slice(name.length + 1)));
	}
	return jar;
}

function request(path: string, jar = new Map<string, string>()) {
	const cookie = [...jar].map(([k, v]) => `${k}=${encodeURIComponent(v)}`);
	return new Request(`https://internal:3000${path}`, {
		headers: cookie.length ? { cookie: cookie.join("; ") } : {},
	});
}

function core(extra: Record<string, string> = {}) {
	return createOidcCore({
		allowSession,
		registry,
		cookiePrefix: "sage",
		environment: () => ({ ...env, ...extra }),
	});
}

beforeEach(() => {
	oidc.metadata.end_session_endpoint = "https://idp.test/logout";
});

describe("OIDC core", () => {
	test("scopes login hints and prompts to one sign-in", async () => {
		const auth = core();
		const start = await auth.signIn(request("/"), new Map(), { loginHint: "alice+work@sage.test", prompt: "select_account" });
		const params = new URL(start.url).searchParams;
		expect(params.get("login_hint")).toBe("alice+work@sage.test");
		expect(params.get("prompt")).toBe("select_account consent");

		const ordinary = await auth.signIn(request("/"), new Map(), "/dashboard");
		const defaults = new URL(ordinary.url).searchParams;
		expect(defaults.has("login_hint")).toBe(false);
		expect(defaults.get("prompt")).toBe("consent");
	});

	test("signs in, completes the callback, resolves the user, and signs out", async () => {
		const auth = core();
		const jar = new Map<string, string>();

		const start = await auth.signIn(
			request("/api/auth/sign-in"),
			jar,
			"/projects?tab=1",
		);
		apply(jar, start.setCookies);
		const authorize = new URL(start.url);
		const state = authorize.searchParams.get("state") ?? "";

		expect(authorize.searchParams.get("redirect_uri")).toBe(
			"https://sage.test/api/auth/callback",
		);
		expect([...jar.keys()]).toEqual([
			expect.stringMatching(/^__Host-sage-verifier-[0-9a-f]{8}$/),
		]);
		expect(start.setCookies[0]).toMatch(
			/Max-Age=600; Path=\/; HttpOnly; Secure; SameSite=Lax$/,
		);

		const result = await auth.callback(
			request(
				`/api/auth/callback?code=c&state=${encodeURIComponent(state)}`,
				jar,
			),
			jar,
		);
		expect(result).toMatchObject({
			ok: true,
			location: "https://sage.test/projects?tab=1",
		});
		expect(String(oidc.authorizationCodeGrant.mock.lastCall?.[1])).toMatch(
			/^https:\/\/sage\.test\/api\/auth\/callback\?code=c&state=/,
		);
		apply(jar, result.setCookies);
		expect([...jar.keys()]).toEqual(["__Host-sage_session"]);

		const resolved = await auth.resolve(request("/", jar));
		expect(resolved.session?.user).toEqual({
			issuer: env.OIDC_ISSUER,
			sub: "alice",
			email: "alice@sage.test",
			name: "Alice",
			picture: null,
			roles: ["stellar"],
		});

		const out = await auth.signOut(
			request("/logout", jar),
			jar,
			resolved.session,
		);
		apply(jar, out.setCookies);
		expect(jar.size).toBe(0);
		expect(registry.end).toHaveBeenCalledWith(
			{ issuer: env.OIDC_ISSUER, clientId: env.OIDC_CLIENT_ID, sid: resolved.session?.sid },
		);
		expect(oidc.tokenRevocation).toHaveBeenCalledWith(
			expect.anything(),
			"refresh",
			{ token_type_hint: "refresh_token" },
		);
		expect(Object.fromEntries(new URL(out.location).searchParams)).toEqual({
			client_id: "sage-web",
			post_logout_redirect_uri: "https://sage.test/login",
			id_token_hint: "id-token",
		});
	});

	test.each([
		["a synchronous denial", () => false],
		["an asynchronous denial", async () => false],
		["a truthy non-boolean from JavaScript", () => "false" as unknown as boolean],
	])("an authenticated user receives no session cookie for %s", async (_, deny) => {
		const auth = createOidcCore({
			environment: () => env,
			registry,
			allowSession: deny,
		});
		const jar = new Map<string, string>();
		const start = await auth.signIn(request("/"), jar);
		apply(jar, start.setCookies);
		const callback = new URL("/callback", env.APP_ORIGIN);
		callback.searchParams.set(
			"state",
			new URL(start.url).searchParams.get("state") ?? "",
		);
		callback.searchParams.set("code", "valid");
		const result = await auth.callback(new Request(callback), jar);
		expect(result).toMatchObject({
			ok: false,
			error: expect.any(SessionAccessDeniedError),
		});
		expect(apply(jar, result.setCookies).size).toBe(0);
	});

	test("rejects a callback without its verifier cookie or with a foreign state", async () => {
		const auth = core();
		const jar = new Map<string, string>();
		const { url, setCookies } = await auth.signIn(request("/"), jar);
		const state = new URL(url).searchParams.get("state") ?? "";

		const missing = await auth.callback(
			request(`/api/auth/callback?code=c&state=${encodeURIComponent(state)}`),
			new Map(),
		);
		apply(jar, setCookies);
		const forged = await auth.callback(
			request("/api/auth/callback?code=c&state=forged"),
			jar,
		);
		const noCode = await auth.callback(
			request(`/api/auth/callback?state=x`),
			jar,
		);

		for (const result of [missing, forged, noCode]) {
			expect(result.ok).toBe(false);
		}
		expect(missing.setCookies[0]).toMatch(
			/^__Host-sage-verifier-[0-9a-f]{8}=; Max-Age=0/,
		);
	});

	test.each(["session", "grant"])("requires the initiating browser's cookie for a %s callback", async (purpose) => {
		const auth = core();
		const begin = purpose === "session" ? auth.signIn : auth.startGrant;
		const finish = purpose === "session" ? auth.callback : auth.finishGrant;
		const start = await begin(request("/"), new Map(), "/");
		const params = new URL(start.url).searchParams;
		const callback = new URL(params.get("redirect_uri")!);
		const state = params.get("state")!;
		callback.search = new URLSearchParams({ state, code: "unused" }).toString();
		const reconstructed = new Map([[verifierCookieName("__Host-sage", state), state]]);
		const exchanges = oidc.authorizationCodeGrant.mock.calls.length;
		expect(await finish(new Request(callback), reconstructed)).toMatchObject({ ok: false, reason: "invalid_state" });
		expect(oidc.authorizationCodeGrant).toHaveBeenCalledTimes(exchanges);
		expect(await finish(new Request(callback), apply(new Map(), start.setCookies))).toMatchObject({ ok: true });
	});

	test("sanitizes return paths and evicts excess pending verifiers", async () => {
		const auth = core();
		const jar = new Map(
			Array.from(
				{ length: 5 },
				(_, i) => [`__Host-sage-verifier-${i}`, "x"] as const,
			),
		);

		const { url, setCookies } = await auth.signIn(
			request("/"),
			jar,
			"//evil.test/x",
		);
		const result = await auth.callback(
			request(
				`/api/auth/callback?code=c&state=${encodeURIComponent(
					new URL(url).searchParams.get("state")!,
				)}`,
			),
			apply(new Map(), setCookies.slice(0, 1)),
		);

		expect(setCookies.slice(1)).toHaveLength(5);
		expect(result).toMatchObject({ ok: true, location: "https://sage.test/" });
	});

	test("uses the request origin and insecure cookies without APP_ORIGIN outside production", async () => {
		const auth = core({ APP_ORIGIN: "" });

		const { url, setCookies } = await auth.signIn(request("/"), new Map());

		expect(new URL(url).searchParams.get("redirect_uri")).toBe(
			"https://internal:3000/api/auth/callback",
		);
		expect(setCookies[0]).not.toContain("Secure");
	});

	test("falls back to the app's post-logout path without an end-session endpoint", async () => {
		oidc.metadata.end_session_endpoint = "";

		const out = await core().signOut(request("/logout"), new Map(), null);

		expect(out.location).toBe("https://sage.test/login");
	});

	test("signs out locally and reports an unreachable provider", async () => {
		const onError = vi.fn();
		const failure = new Error("offline");
		oidc.buildEndSessionUrl.mockImplementationOnce(() => {
			throw failure;
		});
		const auth = createOidcCore({
			allowSession,
			registry,
			environment: () => env,
			onError,
		});

		const out = await auth.signOut(request("/logout"), new Map(), null, {
			correlationId: "req-1",
		});

		expect(out.location).toBe("https://sage.test/login");
		expect(onError).toHaveBeenCalledWith({
			operation: "end-session",
			error: failure,
			context: { correlationId: "req-1" },
		});
	});

	test("emits a correlated service log without provider error contents", () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => {});

		core().report({
			operation: "refresh",
			error: new Error("token abc in message"),
			context: { correlationId: "req-1" },
		});

		const line = String(log.mock.calls[0]?.[0]);
		expect(JSON.parse(line)).toMatchObject({
			level: "error",
			event: "oidc.refresh.failed",
			component: "identity",
			request_id: "req-1",
		});
		expect(line).not.toContain("token abc");
		log.mockRestore();
	});
});

describe("assertConfigured", () => {
	test("accepts a complete configuration", () => {
		expect(() => core().assertConfigured()).not.toThrow();
	});

	test("names every missing or invalid setting at once", () => {
		const auth = createOidcCore({
			allowSession,
			registry,
			environment: () => ({ OIDC_ISSUER: "idp", SESSION_SECRET: "short" }),
		});

		expect(() => auth.assertConfigured()).toThrow(
			/OIDC_ISSUER must be a valid URL.*OIDC_CLIENT_ID.*OIDC_CLIENT_SECRET.*SESSION_SECRET must be at least 32/,
		);
	});
});

describe("origin configuration", () => {
	const configured = (extra: Record<string, string>) =>
		createOidcCore({ allowSession, registry, environment: () => ({ ...env, ...extra }) });

	test("rejects a malformed OIDC_REDIRECT_URI instead of ignoring it", () => {
		expect(() => configured({ OIDC_REDIRECT_URI: "not a url" }).assertConfigured()).toThrow(
			/OIDC_REDIRECT_URI must be a valid URL/,
		);
	});

	test("requires APP_ORIGIN in production", () => {
		expect(() => configured({ APP_ORIGIN: "", NODE_ENV: "production" }).assertConfigured()).toThrow(
			/APP_ORIGIN is required in production/,
		);
	});

	test("refuses HTTP origins in production unless explicitly allowed", () => {
		const http = { APP_ORIGIN: "http://sage.test", NODE_ENV: "production" };
		expect(() => configured(http).assertConfigured()).toThrow(/APP_ORIGIN must use https in production/);
		expect(() =>
			configured({ ...http, OIDC_REDIRECT_URI: "http://sage.test/callback" }).assertConfigured(),
		).toThrow(/OIDC_REDIRECT_URI must use https in production/);
	});

	test("the insecure override permits loopback hosts only", () => {
		const local = { NODE_ENV: "production", OIDC_ALLOW_INSECURE_ORIGIN: "true" };
		for (const host of ["localhost:3000", "127.0.0.1:3000", "[::1]:3000"]) {
			expect(() =>
				configured({ ...local, APP_ORIGIN: `http://${host}`, OIDC_REDIRECT_URI: `http://${host}/callback` }).assertConfigured(),
			).not.toThrow();
		}
		for (const host of ["sage.test", "10.0.0.5", "localhost.evil.test", "127.0.0.1.evil.test"]) {
			expect(() => configured({ ...local, APP_ORIGIN: `http://${host}` }).assertConfigured()).toThrow(
				/APP_ORIGIN must use https in production/,
			);
			expect(() =>
				configured({ ...local, APP_ORIGIN: "http://localhost:3000", OIDC_REDIRECT_URI: `http://${host}/callback` }).assertConfigured(),
			).toThrow(/OIDC_REDIRECT_URI must use https in production/);
		}
	});

	test("still allows an HTTP origin outside production", () => {
		expect(() => configured({ APP_ORIGIN: "http://localhost:5173" }).assertConfigured()).not.toThrow();
	});

	test("fails a sign-in at request time on a malformed OIDC_REDIRECT_URI", async () => {
		await expect(
			configured({ OIDC_REDIRECT_URI: "nope" }).signIn(request("/"), new Map()),
		).rejects.toThrow();
	});
});

describe("withinDeadline", () => {
	test("passes work through without a deadline", async () => {
		await expect(withinDeadline(() => Promise.resolve(1))).resolves.toBe(1);
	});

	test("does not start work that could reject after an expired deadline", async () => {
		const start = vi.fn(async () => { throw new Error("provider failure"); });
		await expect(
			withinDeadline(start, { deadline: 10 }, 20),
		).rejects.toBeInstanceOf(OidcDeadlineError);
		expect(start).not.toHaveBeenCalled();
	});

	test("rejects hung work when the remaining time runs out", async () => {
		vi.useFakeTimers();
		const hung = withinDeadline(() => new Promise(() => {}), {
			deadline: Date.now() + 1_000,
		});
		const settled = expect(hung).rejects.toBeInstanceOf(OidcDeadlineError);
		await vi.advanceTimersByTimeAsync(1_000);
		await settled;
		vi.useRealTimers();
	});

	test("fails a callback whose provider exchange outlives the deadline", async () => {
		oidc.authorizationCodeGrant.mockImplementationOnce(
			() => new Promise(() => {}),
		);
		const auth = core();
		const start = await auth.signIn(request("/"), new Map());
		const state = new URL(start.url).searchParams.get("state") ?? "";
		const jar = apply(new Map(), start.setCookies);

		const result = await auth.callback(
			request(
				`/api/auth/callback?code=c&state=${encodeURIComponent(state)}`,
				jar,
			),
			jar,
			{ deadline: Date.now() + 20 },
		);

		expect(result).toMatchObject({ ok: false });
		expect(result.ok || result.error).toBeInstanceOf(OidcDeadlineError);
	});
});

test("still signs out when the provider cannot revoke the refresh token", async () => {
	const onError = vi.fn();
	oidc.tokenRevocation.mockRejectedValueOnce(new Error("offline"));
	const auth = createOidcCore({
		allowSession,
		registry,
		environment: () => env,
		onError,
	});
	const session = {
		version: 2 as const, clientId: env.OIDC_CLIENT_ID,
		user: { issuer: "https://idp.test/application/o/sage/", sub: "alice", email: "a@x.test", name: null, roles: ["stellar"] },
		accessToken: "a",
		refreshToken: "r",
		expiresAt: 0,
		sid: "s1",
		issuedAt: 0,
		lastSeenAt: 0,
	};

	const out = await auth.signOut(request("/logout"), new Map(), session);

	expect(out.location).toContain("https://idp.test/logout");
	expect(registry.end).toHaveBeenCalledWith({ issuer: env.OIDC_ISSUER, clientId: env.OIDC_CLIENT_ID, sid: "s1" });
	expect(onError).toHaveBeenCalledWith(
		expect.objectContaining({ operation: "token-revocation" }),
	);
});

test("ends the sessions a verified back-channel logout token names", async () => {
	const onError = vi.fn();
	const auth = createOidcCore({
		allowSession,
		registry,
		environment: () => env,
		onError,
	});
	const post = (body: string) =>
		new Request("https://internal:3000/auth/backchannel-logout", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body,
		});

	// No token at all, and a token that fails verification (no JWKS published here).
	expect(await auth.backchannelLogout(post(""))).toEqual({ status: 400 });
	expect(await auth.backchannelLogout(post("logout_token=bad"))).toEqual({
		status: 400,
	});
	expect(onError).toHaveBeenCalledWith(
		expect.objectContaining({ operation: "backchannel-logout" }),
	);
	expect(registry.applyLogout).not.toHaveBeenCalled();
});

test.each([
	false,
	true,
])("sign-out fails when revocation persistence fails (everywhere=%s)", async (everywhere) => {
	const failure = new Error("database unavailable");
	if (everywhere) registry.endAll.mockRejectedValueOnce(failure);
	else registry.end.mockRejectedValueOnce(failure);
	const auth = core();
	const session = {
		version: 2 as const, clientId: env.OIDC_CLIENT_ID,
		user: { issuer: "https://idp.test/application/o/sage/", sub: "alice", email: "a@x.test", name: null, roles: ["stellar"] },
		accessToken: "a",
		refreshToken: "r",
		expiresAt: 0,
		sid: "s1",
		issuedAt: 0,
		lastSeenAt: 0,
	};
	await expect(
		auth.signOut(request("/logout"), new Map(), session, undefined, { everywhere }),
	).rejects.toBe(failure);
});

describe("grants", () => {
	async function started(path = "/oauth/upstream/start") {
		const auth = core();
		const jar = new Map<string, string>();
		const start = await auth.startGrant(
			request(path),
			jar,
			"/oauth/upstream/finish?pending=p1",
		);
		apply(jar, start.setCookies);
		const authorize = new URL(start.url);
		const state = authorize.searchParams.get("state") ?? "";
		return { auth, jar, authorize, state };
	}

	test("returns the grant's tokens on its own callback and writes no session", async () => {
		const { auth, jar, authorize, state } = await started();
		expect(authorize.searchParams.get("redirect_uri")).toBe(
			"https://sage.test/api/auth/grant-callback",
		);

		const result = await auth.finishGrant(
			request(
				`/api/auth/grant-callback?code=c&state=${encodeURIComponent(state)}`,
				jar,
			),
			jar,
		);

		expect(result).toMatchObject({
			ok: true,
			user: { issuer: "https://idp.test/application/o/sage/", sub: "alice" },
			tokens: { accessToken: "access", refreshToken: "refresh" },
			returnPathname: "/oauth/upstream/finish?pending=p1",
		});
		expect(String(oidc.authorizationCodeGrant.mock.lastCall?.[1])).toMatch(
			/^https:\/\/sage\.test\/api\/auth\/grant-callback\?code=c&state=/,
		);
		apply(jar, result.setCookies);
		expect([...jar.keys()]).toEqual([]);
	});

	test("refuses a grant's state at the sign-in callback, and the reverse", async () => {
		const grant = await started();
		const session = core();
		const sessionJar = new Map<string, string>();
		const signIn = await session.signIn(request("/"), sessionJar);
		apply(sessionJar, signIn.setCookies);
		const sessionState = new URL(signIn.url).searchParams.get("state") ?? "";

		const asSession = await grant.auth.callback(
			request(
				`/api/auth/callback?code=c&state=${encodeURIComponent(grant.state)}`,
				grant.jar,
			),
			grant.jar,
		);
		const asGrant = await session.finishGrant(
			request(
				`/api/auth/grant-callback?code=c&state=${encodeURIComponent(sessionState)}`,
				sessionJar,
			),
			sessionJar,
		);

		expect(asSession).toMatchObject({
			ok: false,
			error: { reason: "mismatch" },
		});
		expect(asGrant).toMatchObject({ ok: false, error: { reason: "mismatch" } });
	});

	test("refreshes a grant, and tells a refusal from an outage", async () => {
		const auth = core();
		oidc.refreshTokenGrant.mockResolvedValueOnce({
			access_token: "access-2",
			refresh_token: "refresh-2",
			expiresIn: () => 300,
		});
		await expect(auth.refreshGrant("refresh-1")).resolves.toMatchObject({
			status: "refreshed",
			tokens: { accessToken: "access-2", refreshToken: "refresh-2" },
		});

		async function dispatchedFailure(error: Error) {
			const options = oidc.discovery.mock.lastCall?.[4] as Record<
				symbol,
				typeof fetch
			>;
			await options[oidc.customFetch]("https://idp.test/token");
			throw error;
		}
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response()),
		);
		try {
			const invalid = Object.assign(new Error("refused"), {
				error: "invalid_grant",
			});
			oidc.refreshTokenGrant.mockImplementationOnce(() =>
				dispatchedFailure(invalid),
			);
			await expect(auth.refreshGrant("refresh-2")).resolves.toEqual({
				status: "refused",
			});
			const offline = new TypeError("network unavailable");
			oidc.refreshTokenGrant.mockImplementationOnce(() =>
				dispatchedFailure(offline),
			);
			await expect(auth.refreshGrant("refresh-2")).rejects.toBe(offline);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
