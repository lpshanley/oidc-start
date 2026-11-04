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
	test("signs in, completes the callback, and resolves the user", async () => {
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
