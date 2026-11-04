import * as client from "openid-client";
import type { OidcConfiguration } from "./config.js";
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

export function createProvider(
	settings: OidcConfiguration,
	timeoutMs = PROVIDER_TIMEOUT_MS,
) {
	let configuration: Promise<client.Configuration> | null = null;

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

	return {
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

	};
}

export type OidcProvider = ReturnType<typeof createProvider>;
