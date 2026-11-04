import { AsyncLocalStorage } from "node:async_hooks";
import { createRemoteJWKSet, jwtVerify, customFetch as jwksFetch } from "jose";
import * as client from "openid-client";
import type { OidcCallContext, OidcConfiguration } from "./config.js";
import { LogoutTokenError, logoutTarget } from "./logout-token.js";
import type { AuthUser } from "./models.js";

// OpenID Connect operations over openid-client, standing in for the WorkOS
// user-management calls in authkit-session (authorization URL, code exchange,
// refresh, logout URL), so any provider with discovery metadata works.

export type TokenSet = {
	accessToken: string;
	refreshToken?: string;
	idToken?: string;
	/** Seconds since epoch when the access token expires. */
	expiresAt: number;
	refreshExpiresAt?: number;
};

/** Tokens from a refresh, with roles re-read so membership changes apply. */
export type RefreshedTokens = TokenSet & { roles: string[] };

/** Used when a token response omits expires_in, so refresh is still attempted. */
const DEFAULT_TOKEN_LIFETIME_SECONDS = 300;

function isLoopback(url: URL) {
	return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

function firstString(...values: unknown[]) {
	for (const value of values) {
		if (typeof value === "string" && value.trim().length > 0) return value;
	}
	return null;
}

/**
 * An absolute http(s) URL for a `picture` claim. Relative values, such as
 * authentik's uploaded avatars, resolve against the issuer.
 */
function pictureUrl(value: unknown, issuer: string) {
	if (typeof value !== "string" || value.trim().length === 0) return null;
	try {
		const url = new URL(value, issuer);
		return url.protocol === "https:" || url.protocol === "http:"
			? url.href
			: null;
	} catch {
		return null;
	}
}

/** A roles claim as a list of names, or undefined when absent or malformed. */
function roleList(value: unknown) {
	if (typeof value === "string") return value.length > 0 ? [value] : [];
	if (!Array.isArray(value)) return undefined;
	return value.filter((role): role is string => typeof role === "string");
}

function tokenSet(
	response: client.TokenEndpointResponse & client.TokenEndpointResponseHelpers,
	previousRefreshToken?: string,
): TokenSet {
	const now = Math.floor(Date.now() / 1000);
	return {
		accessToken: response.access_token,
		// Providers that do not rotate refresh tokens omit them on refresh.
		refreshToken: response.refresh_token ?? previousRefreshToken,
		idToken: response.id_token,
		expiresAt: now + (response.expiresIn() ?? DEFAULT_TOKEN_LIFETIME_SECONDS),
		...(typeof response.refresh_expires_in === "number" &&
		response.refresh_expires_in > 0
			? { refreshExpiresAt: now + response.refresh_expires_in }
			: {}),
	};
}

/** Default timeout for each request to the provider. */
export const PROVIDER_TIMEOUT_MS = 5_000;

/** The provider has not received a token refresh request. */
export class RefreshNotDispatched extends Error {}
export function createProvider(
	settings: OidcConfiguration,
	timeoutMs = PROVIDER_TIMEOUT_MS,
) {
	// The SDK caches discovery and JWKS clients and accepts a single transport hook.
	// Only this transport adapter uses async-local state; domain callers pass context explicitly.
	const transport = new AsyncLocalStorage<OidcCallContext | undefined>();
	const refreshDispatch = new AsyncLocalStorage<{ sent: boolean }>();
	const boundedFetch = (
		url: string | URL,
		init: RequestInit | client.CustomFetchOptions = {},
	) => {
		const call = transport.getStore();
		const headers = new Headers(init.headers);
		if (call?.correlationId) headers.set("x-request-id", call.correlationId);
		const remaining = Math.min(
			timeoutMs,
			(call?.deadline ?? Infinity) - Date.now(),
		);
		if (remaining <= 0)
			throw new DOMException("Operation deadline exceeded", "TimeoutError");
		const signals = [AbortSignal.timeout(remaining)];
		if (call?.signal) signals.push(call.signal);
		if (init.signal) signals.push(init.signal);
		const signal = AbortSignal.any(signals);
		signal.throwIfAborted();
		const attempt = refreshDispatch.getStore();
		if (attempt) attempt.sent = true;
		return fetch(url, {
			...init,
			body:
				init.body instanceof Uint8Array ? new Uint8Array(init.body) : init.body,
			headers,
			signal,
		});
	};
	let configuration: Promise<client.Configuration> | null = null;
	let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

	function discover() {
		configuration ??= (async () => {
			const issuer = new URL(settings.OIDC_ISSUER);
			// Plain HTTP is only allowed for a local development issuer.
			const insecure = issuer.protocol === "http:" && isLoopback(issuer);
			// openid-client applies the timeout (in seconds) to discovery and
			// to every later request made with the configuration.
			return client.discovery(
				issuer,
				settings.OIDC_CLIENT_ID,
				settings.OIDC_CLIENT_SECRET,
				undefined,
				{
					[client.customFetch]: boundedFetch,
					timeout: Math.max(1, Math.ceil(timeoutMs / 1000)),
					...(insecure ? { execute: [client.allowInsecureRequests] } : {}),
				},
			);
		})().catch((error: unknown) => {
			configuration = null;
			throw error;
		});
		return configuration;
	}

	async function rotate(refreshToken: string) {
		const config = await discover().catch((error: unknown) => {
			throw new RefreshNotDispatched("Discovery failed before token refresh", {
				cause: error,
			});
		});
		const attempt = { sent: false };
		const response = await refreshDispatch.run(attempt, async () => {
			try {
				return await client.refreshTokenGrant(config, refreshToken);
			} catch (error) {
				if (attempt.sent) throw error;
				throw new RefreshNotDispatched("Token refresh failed before dispatch", {
					cause: error,
				});
			}
		});
		return { config, response };
	}

	const api = {
		async authorizationUrl({
			redirectUri,
			state,
			nonce,
			codeVerifier,
		}: {
			redirectUri: string;
			state: string;
			nonce: string;
			codeVerifier: string;
		}) {
			return client.buildAuthorizationUrl(await discover(), {
				redirect_uri: redirectUri,
				scope: settings.OIDC_SCOPES,
				state,
				nonce,
				code_challenge: await client.calculatePKCECodeChallenge(codeVerifier),
				code_challenge_method: "S256",
			});
		},

		async exchangeCode(
			callbackUrl: URL,
			checks: { state: string; nonce: string; codeVerifier: string },
		): Promise<{ user: AuthUser; tokens: TokenSet; idpSid?: string }> {
			const config = await discover();
			const response = await client.authorizationCodeGrant(
				config,
				callbackUrl,
				{
					pkceCodeVerifier: checks.codeVerifier,
					expectedState: checks.state,
					expectedNonce: checks.nonce,
					idTokenExpected: true,
				},
			);
			const claims = response.claims();
			if (!claims?.sub) throw new Error("ID token has no subject");
			let email = firstString(claims.email);
			const tokenRoles = roleList(claims[settings.OIDC_ROLES_CLAIM]);
			let info: client.UserInfoResponse | undefined;
			if (!email || tokenRoles === undefined) {
				info = await client.fetchUserInfo(
					config,
					response.access_token,
					claims.sub,
				);
				email = email ?? firstString(info.email);
			}
			if (!email) throw new Error("Provider returned no email");
			return {
				user: {
					sub: claims.sub,
					email,
					name: firstString(
						claims.name,
						info?.name,
						claims.preferred_username,
						info?.preferred_username,
					),
					picture:
						pictureUrl(claims.picture, settings.OIDC_ISSUER) ??
						pictureUrl(info?.picture, settings.OIDC_ISSUER),
					roles:
						tokenRoles ?? roleList(info?.[settings.OIDC_ROLES_CLAIM]) ?? [],
				},
				tokens: tokenSet(response),
				// The provider's session id, matched by back-channel logout tokens.
				idpSid: firstString(claims.sid) ?? undefined,
			};
		},

		async refresh(refreshToken: string, sub: string): Promise<RefreshedTokens> {
			const { config, response } = await rotate(refreshToken);
			const claims = response.claims();
			if (claims && claims.sub !== sub)
				throw Object.assign(new Error("Refresh subject mismatch"), {
					error: "invalid_grant",
				});
			let roles = roleList(claims?.[settings.OIDC_ROLES_CLAIM]);
			if (roles === undefined) {
				const info = await client.fetchUserInfo(
					config,
					response.access_token,
					sub,
				);
				roles = roleList(info[settings.OIDC_ROLES_CLAIM]) ?? [];
			}
			return { ...tokenSet(response, refreshToken), roles };
		},

		/**
		 * Verifies a back-channel logout token's signature against the provider's
		 * published keys, its issuer, audience, and age, then its logout claims.
		 * Throws LogoutTokenError or a jose error for an invalid token.
		 */
		async verifyLogoutToken(token: string) {
			const metadata = (await discover()).serverMetadata();
			if (!metadata.jwks_uri) {
				throw new LogoutTokenError("The provider publishes no jwks_uri");
			}
			jwks ??= createRemoteJWKSet(new URL(metadata.jwks_uri), {
				timeoutDuration: timeoutMs,
				[jwksFetch]: boundedFetch,
			});
			const { payload } = await jwtVerify(token, jwks, {
				issuer: metadata.issuer,
				audience: settings.OIDC_CLIENT_ID,
				maxTokenAge: "10 minutes",
			});
			return logoutTarget(payload);
		},

		/** Revokes a refresh token at the provider, so it cannot mint new tokens. */
		async revokeRefreshToken(refreshToken: string) {
			await client.tokenRevocation(await discover(), refreshToken, {
				token_type_hint: "refresh_token",
			});
		},

		/** The provider logout URL, or null when it has no end_session_endpoint. */
		async endSessionUrl({
			idTokenHint,
			postLogoutRedirectUri,
		}: {
			idTokenHint?: string;
			postLogoutRedirectUri: string;
		}) {
			const config = await discover();
			if (!config.serverMetadata().end_session_endpoint) return null;
			return client
				.buildEndSessionUrl(config, {
					client_id: settings.OIDC_CLIENT_ID,
					post_logout_redirect_uri: postLogoutRedirectUri,
					...(idTokenHint ? { id_token_hint: idTokenHint } : {}),
				})
				.toString();
		},
	};
	return {
		authorizationUrl: (
			input: Parameters<typeof api.authorizationUrl>[0],
			context?: OidcCallContext,
		) => transport.run(context, () => api.authorizationUrl(input)),
		exchangeCode: (
			url: URL,
			checks: Parameters<typeof api.exchangeCode>[1],
			context?: OidcCallContext,
		) => transport.run(context, () => api.exchangeCode(url, checks)),
		refreshGrantTokens: (token: string, context?: OidcCallContext) =>
			transport.run(context, async () =>
				tokenSet((await rotate(token)).response, token),
			),
		refresh: (token: string, subject: string, context?: OidcCallContext) =>
			transport.run(context, () => api.refresh(token, subject)),
		verifyLogoutToken: (token: string, context?: OidcCallContext) =>
			transport.run(context, () => api.verifyLogoutToken(token)),
		revokeRefreshToken: (token: string, context?: OidcCallContext) =>
			transport.run(context, () => api.revokeRefreshToken(token)),
		endSessionUrl: (
			input: Parameters<typeof api.endSessionUrl>[0],
			context?: OidcCallContext,
		) => transport.run(context, () => api.endSessionUrl(input)),
	};
}

export type OidcProvider = ReturnType<typeof createProvider>;
