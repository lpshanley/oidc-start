import { beforeEach, describe, expect, test, vi } from "vitest";

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
	OidcDeadlineError,
	SessionAccessDeniedError,
	withinDeadline,
} = await import("./core.js");

const env = {
	SESSION_SECRET: "test-only-session-secret-at-least-32-characters",
	OIDC_ISSUER: "https://idp.test/application/o/sage/",
	OIDC_CLIENT_ID: "sage-web",
	OIDC_CLIENT_SECRET: "secret",
	APP_ORIGIN: "https://sage.test",
};

const allowSession = (user: { sub: string }) => user.sub === "alice";

const revocations = {
	isRevoked: vi.fn(async () => false),
	revoke: vi.fn(async () => {}),
	revokeAllFor: vi.fn(async () => {}),
	revokeIdpSession: vi.fn(async () => {}),
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
		revocations,
		cookiePrefix: "sage",
		environment: () => ({ ...env, ...extra }),
	});
}

beforeEach(() => {
	oidc.metadata.end_session_endpoint = "https://idp.test/logout";
});

describe("OIDC core", () => {
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
		expect(revocations.revoke).toHaveBeenCalledWith(
			resolved.session?.sid,
			expect.any(Number),
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

	test("an authenticated user denied by the host receives no session cookie", async () => {
		const auth = createOidcCore({
			environment: () => env,
			revocations,
			allowSession: () => false,
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

	test("sanitizes return paths and evicts excess pending verifiers", async () => {
		const auth = core();
		const jar = new Map(
			Array.from(
				{ length: 5 },
				(_, i) => [`__Host-sage-verifier-${i}`, "x"] as const,
			),
		);

		const { setCookies } = await auth.signIn(
			request("/"),
			jar,
			"//evil.test/x",
		);
		const result = await auth.callback(
			request(
				`/api/auth/callback?code=c&state=${encodeURIComponent(
					decodeURIComponent(setCookies[0]?.split(";")[0]?.split("=")[1] ?? ""),
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
			revocations,
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
			revocations,
			environment: () => ({ OIDC_ISSUER: "idp", SESSION_SECRET: "short" }),
		});

		expect(() => auth.assertConfigured()).toThrow(
			/OIDC_ISSUER must be a valid URL.*OIDC_CLIENT_ID.*OIDC_CLIENT_SECRET.*SESSION_SECRET must be at least 32/,
		);
	});
});

describe("withinDeadline", () => {
	test("passes work through without a deadline", async () => {
		await expect(withinDeadline(Promise.resolve(1))).resolves.toBe(1);
	});

	test("rejects at once when the deadline has passed", async () => {
		await expect(
			withinDeadline(new Promise(() => {}), { deadline: 10 }, 20),
		).rejects.toBeInstanceOf(OidcDeadlineError);
	});

	test("rejects hung work when the remaining time runs out", async () => {
		vi.useFakeTimers();
		const hung = withinDeadline(new Promise(() => {}), {
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
		revocations,
		environment: () => env,
		onError,
	});
	const session = {
		user: { sub: "alice", email: "a@x.test", name: null, roles: ["stellar"] },
		accessToken: "a",
		refreshToken: "r",
		expiresAt: 0,
		sid: "s1",
		issuedAt: 0,
		lastSeenAt: 0,
	};

	const out = await auth.signOut(request("/logout"), new Map(), session);

	expect(out.location).toContain("https://idp.test/logout");
	expect(revocations.revoke).toHaveBeenCalledWith("s1", expect.any(Number));
	expect(onError).toHaveBeenCalledWith(
		expect.objectContaining({ operation: "token-revocation" }),
	);
});

test("ends the sessions a verified back-channel logout token names", async () => {
	const onError = vi.fn();
	const auth = createOidcCore({
		allowSession,
		revocations,
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
	expect(revocations.revokeIdpSession).not.toHaveBeenCalled();
});

test.each(["sid", "sub"] as const)("redelivery preserves the original %s revocation after a storage outage", async (kind) => {
	const { exportJWK, generateKeyPair, SignJWT } = await import("jose");
	const { privateKey, publicKey } = await generateKeyPair("RS256");
	const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" };
	vi.stubGlobal("fetch", vi.fn(async () => Response.json({ keys: [jwk] })));
	Object.assign(oidc.metadata, {
		issuer: env.OIDC_ISSUER,
		jwks_uri: "https://idp.test/jwks/",
	});
	const issuedAt = Math.floor(Date.now() / 1000) - 60;
	const token = await new SignJWT({
		sub: "alice",
		...(kind === "sid" ? { sid: "idp-1" } : {}),
		events: { "http://schemas.openid.net/event/backchannel-logout": {} },
	})
		.setProtectedHeader({ alg: "RS256", kid: "k1" })
		.setIssuer(env.OIDC_ISSUER)
		.setAudience(env.OIDC_CLIENT_ID)
		.setIssuedAt(issuedAt)
		.setExpirationTime(issuedAt + 300)
		.setJti("logout-1")
		.sign(privateKey);

	const write = kind === "sid" ? revocations.revokeIdpSession : revocations.revokeAllFor;
	write.mockClear().mockRejectedValueOnce(new Error("database unavailable"));
	const auth = createOidcCore({
		allowSession, revocations, environment: () => env, onError: vi.fn(),
		sessionMaxAgeSeconds: 3600,
	});
	const deliver = () => auth.backchannelLogout(new Request("https://internal:3000/auth/backchannel-logout", {
		method: "POST",
		body: new URLSearchParams({ logout_token: token }),
	}));

	try {
		expect(await deliver()).toEqual({ status: 503 });
		expect(await deliver()).toEqual({ status: 200 });
		vi.useFakeTimers({ toFake: ["Date"], now: (issuedAt + 120) * 1000 });
		expect(await deliver()).toEqual({ status: 200 });
		const expected = kind === "sid" ? ["idp-1", issuedAt + 600 + 3600] : ["alice", issuedAt];
		expect(write.mock.calls).toEqual([expected, expected, expected]);
	} finally {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	}
});

test.each([
	false,
	true,
])("sign-out fails when revocation persistence fails (everywhere=%s)", async (everywhere) => {
	const failure = new Error("database unavailable");
	if (everywhere) revocations.revokeAllFor.mockRejectedValueOnce(failure);
	else revocations.revoke.mockRejectedValueOnce(failure);
	const auth = core();
	const session = {
		user: { sub: "alice", email: "a@x.test", name: null, roles: ["stellar"] },
		accessToken: "a",
		refreshToken: "r",
		expiresAt: 0,
		sid: "s1",
		issuedAt: 0,
		lastSeenAt: 0,
	};
	await expect(
		auth.signOut(request("/logout"), new Map(), session, undefined, everywhere),
	).rejects.toBe(failure);
});

test.each([false, true])("sign-out can be retried after a revocation read outage (everywhere=%s)", async (everywhere) => {
	let offline = true;
	const revoked = new Set<string>();
	const failure = new Error("store offline");
	const auth = createOidcCore({
		allowSession,
		environment: () => env,
		onError: vi.fn(),
		revocations: {
			...revocations,
			async isRevoked({ sid, sub }) {
				if (offline) throw failure;
				return revoked.has(sid) || revoked.has(sub);
			},
			async revoke(sid) { revoked.add(sid); },
			async revokeAllFor(sub) { revoked.add(sub); },
		},
	});
	const jar = new Map<string, string>();
	const start = await auth.signIn(request("/"), jar);
	apply(jar, start.setCookies);
	const state = new URL(start.url).searchParams.get("state");
	const callback = await auth.callback(request(`/callback?code=c&state=${state}`, jar), jar);
	apply(jar, callback.setCookies);
	const logout = request("/logout", jar);
	const call = { correlationId: "logout-retry" };
	const blocked = await auth.resolve(logout, call);
	expect(auth.report).toHaveBeenCalledWith({ operation: "revocation-read", error: failure, context: call });
	expect(blocked).toMatchObject({ session: null, setCookies: [] });
	await expect(auth.signOut(logout, blocked.cookies, blocked.session, undefined, everywhere))
		.rejects.toBe(failure);
	expect(revoked.size).toBe(0);

	offline = false;
	const retry = await auth.resolve(logout);
	expect(retry.session?.user.sub).toBe("alice");
	// Recovery between resolution and sign-out may end this cookie, but cannot
	// authorize ending other sessions until a fresh request resolves the user.
	if (everywhere) {
		await expect(auth.signOut(logout, blocked.cookies, null, undefined, true)).rejects.toThrow("active session");
		expect(revoked.size).toBe(0);
	}
	const out = await auth.signOut(logout, retry.cookies, everywhere ? retry.session : null, undefined, everywhere);
	expect(out.setCookies.join()).toContain("Max-Age=0");
	expect(revoked).toEqual(new Set([everywhere ? "alice" : retry.session?.sid]));
	expect((await auth.resolve(logout)).session).toBeNull(); // replay the original cookie
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
			user: { sub: "alice" },
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
