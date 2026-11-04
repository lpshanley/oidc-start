import { beforeEach, describe, expect, test, vi } from "vitest";

const oidc = vi.hoisted(() => {
	const metadata: Record<string, string> = {
		end_session_endpoint: "https://idp.test/logout",
	};
	const config = { serverMetadata: () => metadata };
	return {
		customFetch: Symbol("fetch"),
		metadata,
		discovery: vi.fn(async (..._args: unknown[]) => config),
		allowInsecureRequests: vi.fn(),
		calculatePKCECodeChallenge: vi.fn(async (v: string) => `challenge-${v}`),
		buildAuthorizationUrl: vi.fn(
			(_: unknown, params: Record<string, string>) =>
				new URL(`https://idp.test/authorize?${new URLSearchParams(params)}`),
		),
		authorizationCodeGrant: vi.fn(),
		refreshTokenGrant: vi.fn(),
		fetchUserInfo: vi.fn(),
		buildEndSessionUrl: vi.fn(
			(_: unknown, params: Record<string, string>) =>
				new URL(`https://idp.test/logout?${new URLSearchParams(params)}`),
		),
	};
});
vi.mock("openid-client", () => oidc);

const { createProvider } = await import("./provider.js");

const settings = {
	OIDC_ISSUER: "https://idp.test/application/o/sage/",
	OIDC_CLIENT_ID: "sage-web",
	OIDC_CLIENT_SECRET: "secret",
	OIDC_SCOPES: "openid profile email offline_access",
	OIDC_ROLES_CLAIM: "roles",
};

function tokenResponse(
	fields: Record<string, unknown>,
	claims: Record<string, unknown> | undefined,
	expiresIn: number | undefined = 300,
) {
	return {
		access_token: "access",
		...fields,
		claims: () => claims,
		expiresIn: () => expiresIn,
	};
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"], now: 1_000_000 });
	oidc.metadata.end_session_endpoint = "https://idp.test/logout";
	oidc.fetchUserInfo.mockResolvedValue({ sub: "alice" });
});

describe("provider", () => {
	test("discovers once and builds a PKCE authorization URL", async () => {
		const provider = createProvider(settings);

		const url = await provider.authorizationUrl({
			redirectUri: "https://sage.test/api/auth/callback",
			state: "st",
			nonce: "no",
			codeVerifier: "ver",
		});
		await provider.authorizationUrl({
			redirectUri: "x",
			state: "s",
			nonce: "n",
			codeVerifier: "v",
		});

		expect(oidc.discovery).toHaveBeenCalledOnce();
		expect(oidc.discovery).toHaveBeenCalledWith(
			new URL(settings.OIDC_ISSUER),
			"sage-web",
			"secret",
			undefined,
			{ timeout: 5 },
		);
		expect(Object.fromEntries(url.searchParams)).toEqual({
			redirect_uri: "https://sage.test/api/auth/callback",
			scope: "openid profile email offline_access",
			state: "st",
			nonce: "no",
			code_challenge: "challenge-ver",
			code_challenge_method: "S256",
		});
	});

	test("allows plain HTTP only for a loopback issuer and retries failed discovery", async () => {
		oidc.discovery.mockRejectedValueOnce(new Error("down"));
		const local = createProvider({
			...settings,
			OIDC_ISSUER: "http://localhost:9000/",
		});


		const input = { redirectUri: "https://sage.test/cb", state: "s", nonce: "n", codeVerifier: "v" };
		await expect(local.authorizationUrl(input)).rejects.toThrow("down");
		await local.authorizationUrl(input);
		expect(oidc.discovery).toHaveBeenCalledTimes(2);
		expect(oidc.discovery.mock.lastCall?.[4]).toEqual({
			timeout: 5,
			execute: [oidc.allowInsecureRequests],
		});
	});

	test("exchanges a code with PKCE, state, and nonce checks", async () => {
		oidc.authorizationCodeGrant.mockResolvedValue(
			tokenResponse(
				{ refresh_token: "refresh", id_token: "id" },
				{
					sub: "alice",
					email: "alice@sage.test",
					preferred_username: "alice",
					roles: ["sage-admin"],
				},
			),
		);
		const callback = new URL("https://sage.test/api/auth/callback?code=c");

		const result = await createProvider(settings).exchangeCode(callback, {
			state: "st",
			nonce: "no",
			codeVerifier: "ver",
		});

		expect(oidc.authorizationCodeGrant).toHaveBeenCalledWith(
			expect.anything(),
			callback,
			{
				pkceCodeVerifier: "ver",
				expectedState: "st",
				expectedNonce: "no",
				idTokenExpected: true,
			},
		);
		expect(result).toEqual({
			user: {
				sub: "alice",
				email: "alice@sage.test",
				name: "alice",
				picture: null,
				roles: ["sage-admin"],
			},
			tokens: {
				accessToken: "access",
				refreshToken: "refresh",
				idToken: "id",
				expiresAt: 1_000 + 300,
			},
		});
		expect(oidc.fetchUserInfo).not.toHaveBeenCalled();
	});

	test("falls back to userinfo for a missing email and rejects users without one", async () => {
		oidc.authorizationCodeGrant.mockResolvedValue(
			tokenResponse({}, { sub: "bob" }, undefined),
		);
		oidc.fetchUserInfo.mockResolvedValueOnce({
			sub: "bob",
			email: "b@x.test",
			name: "Bob",
		});
		const provider = createProvider(settings);
		const checks = { state: "s", nonce: "n", codeVerifier: "v" };

		const { user, tokens } = await provider.exchangeCode(
			new URL("https://s.test/cb"),
			checks,
		);
		oidc.fetchUserInfo.mockResolvedValueOnce({ sub: "bob" });

		expect(user).toEqual({
			sub: "bob",
			email: "b@x.test",
			name: "Bob",
			picture: null,
			roles: [],
		});
		expect(tokens.expiresAt).toBe(1_000 + 300);
		await expect(
			provider.exchangeCode(new URL("https://s.test/cb"), checks),
		).rejects.toThrow("no email");
	});

	test.each([
		["the ID token", { roles: ["a", 7, "b"] }, {}, ["a", "b"]],
		["a single string", { roles: "a" }, {}, ["a"]],
		["userinfo when the token has none", {}, { roles: ["b"] }, ["b"]],
		["neither", {}, {}, []],
	])("reads roles from %s", async (_, tokenClaims, infoClaims, expected) => {
		oidc.authorizationCodeGrant.mockResolvedValueOnce(
			tokenResponse({}, { sub: "a", email: "a@x.test", ...tokenClaims }),
		);
		oidc.fetchUserInfo
			.mockReset()
			.mockResolvedValue({ sub: "a", ...infoClaims });

		const { user } = await createProvider(settings).exchangeCode(
			new URL("https://s.test/cb"),
			{ state: "s", nonce: "n", codeVerifier: "v" },
		);

		expect(user.roles).toEqual(expected);
		expect(user.email).toBe("a@x.test");
	});

	test("keeps the old refresh token when the provider does not rotate it", async () => {
		oidc.refreshTokenGrant.mockResolvedValueOnce(
			tokenResponse({ access_token: "a2" }, undefined, 60),
		);

		await expect(
			createProvider(settings).refresh("r1", "alice"),
		).resolves.toEqual({
			accessToken: "a2",
			refreshToken: "r1",
			idToken: undefined,
			roles: [],
			expiresAt: 1_060,
		});
	});

	test.each([
		["an absolute URL", "https://cdn.test/a.png", "https://cdn.test/a.png"],
		[
			"an issuer-relative path",
			"/media/avatars/a.png",
			"https://idp.test/media/avatars/a.png",
		],
		["a non-http scheme", "javascript:alert(1)", null],
		["an empty value", " ", null],
	])("reads the picture claim from %s", async (_, picture, expected) => {
		oidc.authorizationCodeGrant.mockResolvedValueOnce(
			tokenResponse(
				{},
				{ sub: "alice", email: "a@sage.test", picture, roles: [] },
			),
		);

		const { user } = await createProvider(settings).exchangeCode(
			new URL("https://sage.test/cb"),
			{ state: "s", nonce: "n", codeVerifier: "v" },
		);

		expect(user.picture).toBe(expected);
	});
});

test("re-reads roles on refresh, from the ID token or else userinfo", async () => {
	oidc.refreshTokenGrant.mockResolvedValueOnce(
		tokenResponse({ access_token: "a2" }, { sub: "alice", roles: ["stellar"] }),
	);
	await expect(
		createProvider(settings).refresh("r1", "alice"),
	).resolves.toMatchObject({ roles: ["stellar"] });

	oidc.refreshTokenGrant.mockResolvedValueOnce(
		tokenResponse({ access_token: "a3" }, undefined),
	);
	oidc.fetchUserInfo.mockResolvedValueOnce({ sub: "alice", roles: [] });
	await expect(
		createProvider(settings).refresh("r2", "alice"),
	).resolves.toMatchObject({ roles: [] });
});
