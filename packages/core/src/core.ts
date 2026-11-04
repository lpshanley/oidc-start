import { withinDeadline } from "./deadline.js";
import { randomNonce, randomPKCECodeVerifier, randomState } from "openid-client";
import {
	assertOidcConfigured,
	authOriginConfigurationSchema,
	authServiceOptionsSchema,
	type OidcCallContext,
	type OidcErrorEvent,
	type OidcMiddlewareOptions,
	oidcConfigurationSchema,
	sessionConfigurationSchema,
} from "./config.js";
import {
	type CookieOptions,
	parseCookies,
	serializeCookie,
} from "./cookies.js";
import { type LogoutTarget } from "./logout-token.js";
import { type AuthUser, sanitizeReturnPath, type SignInOptions, type SignOutOptions, signInOptionsSchema, signOutOptionsSchema } from "./models.js";
import {
	authorizationErrorCode,
	createProvider,
	type OidcProvider,
	type TokenSet,
} from "./provider.js";
import { createSessionManager, type Session, type SessionResolution } from "./session.js";
import {
	type FlowPurpose,
	OidcStateError,
	STATE_MAX_AGE_SECONDS,
	sealState,
	staleVerifierNames,
	verifierCookieName,
	verifyCallbackState,
} from "./state.js";

// Framework-free sign-in, callback, sign-out, and request resolution. The
// TanStack Start middleware, server functions, and route handlers are thin
// adapters over these operations, mirroring how WorkOS splits
// authkit-session (core) from authkit-tanstack-react-start (adapter).

export type OidcAuth = { user: AuthUser | null; status: SessionResolution["status"]; reason?: SessionResolution["reason"] };

/** The provider authenticated a user whom the host denied a session. */
export class SessionAccessDeniedError extends Error {
	override name = "SessionAccessDeniedError";
	constructor() {
		super("The signed-in account cannot start a session");
	}
}

export type CallbackErrorReason =
	| "invalid_callback"
	| "sign_in_expired"
	| "invalid_state"
	| "access_denied"
	| "provider_error"
	| "token_exchange_failed"
	| "session_failed";

export type CallbackResult =
	| { ok: true; location: string; setCookies: string[] }
	| { ok: false; reason: CallbackErrorReason | "session_access_denied"; error: unknown; setCookies: string[] };

export type GrantResult =
	| {
			ok: true;
			user: AuthUser;
			tokens: TokenSet;
			returnPathname: string;
			setCookies: string[];
	  }
	| { ok: false; reason: CallbackErrorReason; error: unknown; setCookies: string[] };

export type GrantRefresh =
	| { status: "refreshed"; tokens: TokenSet }
	| { status: "refused" };

function logIdentityFailure(event: OidcErrorEvent) {
	console.error(
		JSON.stringify({
			level: "error",
			event: `oidc.${event.operation}.failed`,
			component: "identity",
			request_id: event.context?.correlationId,
			reason: event.reason,
		}),
	);
}

export function createOidcCore(options: OidcMiddlewareOptions) {
	const settings = authServiceOptionsSchema.parse(options);
	const onError = options.onError ?? logIdentityFailure;
	const environment = options.environment ?? (() => process.env);
	/** `__Host-` pins cookies to this origin over HTTPS, with no Domain and Path=/. */
	function prefix() {
		return cookieOptions().secure
			? `__Host-${settings.cookiePrefix}`
			: settings.cookiePrefix;
	}

	let cached: { key: string; provider: OidcProvider } | null = null;

	function provider() {
		const config = oidcConfigurationSchema.parse(environment());
		const key = JSON.stringify([
			config.OIDC_ISSUER,
			config.OIDC_CLIENT_ID,
			config.OIDC_CLIENT_SECRET,
			config.OIDC_SCOPES,
			config.OIDC_ROLES_CLAIM,
		]);
		if (cached?.key !== key) {
			cached = {
				key,
				provider: createProvider(config, settings.providerTimeoutMs, settings.offlineAccessConsent),
			};
		}
		return cached.provider;
	}

	function scope() {
		const config = oidcConfigurationSchema.parse(environment());
		return { issuer: config.OIDC_ISSUER, clientId: config.OIDC_CLIENT_ID };
	}

	function password() {
		return sessionConfigurationSchema.parse(environment()).SESSION_SECRET;
	}

	function origin(request: Request) {
		const { APP_ORIGIN } = authOriginConfigurationSchema.parse(environment());
		return new URL(APP_ORIGIN ?? request.url).origin;
	}

	function redirectUri(request: Request) {
		const { OIDC_REDIRECT_URI } = authOriginConfigurationSchema.parse(
			environment(),
		);
		return OIDC_REDIRECT_URI ?? `${origin(request)}${settings.callbackPath}`;
	}

	function cookieOptions(): CookieOptions {
		const { APP_ORIGIN, NODE_ENV } = authOriginConfigurationSchema.parse(
			environment(),
		);
		const secure = APP_ORIGIN
			? new URL(APP_ORIGIN).protocol === "https:"
			: NODE_ENV === "production";
		return { path: "/", httpOnly: true, sameSite: "lax", secure };
	}

	function expire(name: string) {
		return serializeCookie(name, "", { ...cookieOptions(), maxAge: 0 });
	}

	function callbackUri(purpose: FlowPurpose, request: Request) {
		return purpose === "session"
			? redirectUri(request)
			: `${origin(request)}${settings.grantCallbackPath}`;
	}

	async function begin(
		purpose: FlowPurpose,
		request: Request,
		cookies: Map<string, string>,
		options: SignInOptions,
		context: OidcCallContext | undefined,
	) {
		const nonce = randomNonce();
		const codeVerifier = randomPKCECodeVerifier();
		const state = randomState();
		const verifier = await sealState(
			{
				state,
				purpose,
				nonce,
				codeVerifier,
				returnPathname: sanitizeReturnPath(options.returnPathname),
				maxAge: options.maxAge,
			},
			password(),
		);
		const name = verifierCookieName(prefix(), state);
		const url = await withinDeadline(
			() => provider().authorizationUrl(
				{
					redirectUri: callbackUri(purpose, request),
					loginHint: options.loginHint,
					maxAge: options.maxAge,
					prompt: options.prompt,
					state,
					nonce,
					codeVerifier,
				},
				context,
			),
			context,
		);
		const stale = staleVerifierNames(cookies.keys(), {
			prefix: prefix(),
			keep: name,
		});
		return {
			url: url.toString(),
			setCookies: [
					serializeCookie(name, verifier, {
					...cookieOptions(),
					maxAge: STATE_MAX_AGE_SECONDS,
				}),
				...stale.map(expire),
			],
		};
	}

	async function complete(
		purpose: FlowPurpose,
		request: Request,
		cookies: Map<string, string>,
		context: OidcCallContext | undefined,
	) {
		const url = new URL(request.url);
		const state = url.searchParams.get("state");
		const clearVerifier = state
			? [expire(verifierCookieName(prefix(), state))]
			: [];
		if (!state || !(url.searchParams.get("code") || url.searchParams.get("error"))) {
			return { ok: false, reason: "invalid_callback", error: new OidcStateError("missing"), setCookies: clearVerifier } as const;
		}
		let reason: CallbackErrorReason = "invalid_state";
		try {
			const flow = await verifyCallbackState({
				state,
				cookieValue: cookies.get(verifierCookieName(prefix(), state)),
				password: password(),
				purpose,
			});
			reason = "token_exchange_failed";
			// Rebuild the callback on the registered redirect URI so a proxy
			// in front of the app doesn't change the URL being verified.
			const callbackUrl = new URL(callbackUri(purpose, request));
			callbackUrl.search = url.search;
			const { user, tokens, idpSid, authTime } = await withinDeadline(
				() => provider().exchangeCode(
					callbackUrl,
					{
						state,
						nonce: flow.nonce,
						codeVerifier: flow.codeVerifier,
						maxAge: flow.maxAge,
					},
					context,
				),
				context,
			);
			return { ok: true as const, flow, user, tokens, idpSid, authTime, clearVerifier };
		} catch (error) {
			const code = authorizationErrorCode(error);
			if (code) reason = code === "access_denied" ? "access_denied" : "provider_error";
			else if (error instanceof OidcStateError && error.reason === "missing") reason = "sign_in_expired";
			return { ok: false as const, reason, error, setCookies: clearVerifier };
		}
	}

	const sessions = createSessionManager({
		cookieName: () => `${prefix()}_session`,
		cookieOptions,
		maxAgeSeconds: settings.sessionMaxAgeSeconds,
		idleSeconds: settings.sessionIdleSeconds,
		password,
		provider,
		registry: options.registry,
		scope,
		refreshCoordinator: options.refreshCoordinator,
		allowSession: options.allowSession,
	});

	return {
		/** Reads, and when needed refreshes or clears, the request's session. */
		async resolve(request: Request, context?: OidcCallContext) {
			const cookies = parseCookies(request.headers.get("cookie"));
			const result = await sessions.resolve(
				cookies,
				(error, operation, reason) => onError({ operation, reason, error, context }),
				context,
			);
			return { cookies, ...result };
		},

		/** An authorization URL plus the flow's verifier cookie. */
		signIn(
			request: Request,
			cookies: Map<string, string>,
			options?: string | null | SignInOptions,
			context?: OidcCallContext,
		) {
			const signInOptions = typeof options === "string"
				? { returnPathname: options }
				: signInOptionsSchema.parse(options ?? {});
			return begin("session", request, cookies, signInOptions, context);
		},

		/** Verifies the flow, exchanges the code, and issues the session. */
		async callback(
			request: Request,
			cookies: Map<string, string>,
			context?: OidcCallContext,
		): Promise<CallbackResult> {
			const result = await complete("session", request, cookies, context);
			if (!result.ok) return result;
			const { user, tokens, idpSid, authTime, flow, clearVerifier } = result;
			try {
				if (!(await sessions.isAllowed(user))) throw new SessionAccessDeniedError();
				const now = Math.floor(Date.now() / 1000);
				const session: Session = {
					version: 2, clientId: scope().clientId, user, ...tokens,
					sid: crypto.randomUUID(), ...(idpSid ? { idpSid } : {}),
					authTime, issuedAt: now, lastSeenAt: now,
				};
				// Seal first so a serialization failure cannot leave an unnecessary row.
				const setCookies = await sessions.write(cookies, session);
				await options.registry.register({
					...scope(), sid: session.sid, sub: user.sub, idpSid,
					expiresAt: now + settings.sessionMaxAgeSeconds,
				});
				return {
					ok: true, location: new URL(flow.returnPathname, origin(request)).toString(),
					setCookies: [...setCookies, ...clearVerifier],
				};
			} catch (error) {
				const reason = error instanceof SessionAccessDeniedError ? "session_access_denied" : "session_failed";
				return { ok: false, reason, error, setCookies: clearVerifier };
			}
		},

		/**
		 * Starts a grant: an authorization like sign-in whose tokens the app
		 * keeps for itself, returning on `grantCallbackPath`. It writes no
		 * session, so the browser's own session is untouched.
		 */
		startGrant(
			request: Request,
			cookies: Map<string, string>,
			returnPathname: string,
			context?: OidcCallContext,
		) {
			return begin("grant", request, cookies, { returnPathname }, context);
		},

		/** Verifies a grant's callback and exchanges its code for tokens. */
		async finishGrant(
			request: Request,
			cookies: Map<string, string>,
			context?: OidcCallContext,
		): Promise<GrantResult> {
			const result = await complete("grant", request, cookies, context);
			if (!result.ok) return result;
			const { flow, user, tokens, clearVerifier } = result;
			return {
				ok: true,
				user,
				tokens,
				returnPathname: flow.returnPathname,
				setCookies: clearVerifier,
			};
		},

		/**
		 * Refreshes a grant's tokens. `refused` means the provider ended the
		 * grant (`invalid_grant`); any other failure throws, since the provider
		 * may only be unreachable.
		 */
		async refreshGrant(
			refreshToken: string,
			context?: OidcCallContext,
		): Promise<GrantRefresh> {
			try {
				const tokens = await withinDeadline(
					() => provider().refreshGrantTokens(refreshToken, context),
					context,
				);
				return { status: "refreshed", tokens };
			} catch (error) {
				if ((error as { error?: unknown } | null)?.error === "invalid_grant") {
					return { status: "refused" };
				}
				throw error;
			}
		},

		/**
		 * Ends the session server-side (every session of the user with
		 * `everywhere`), clears the cookie, and returns the provider logout URL.
		 * Throws when the session cannot be ended, so a sign-out is never
		 * reported done while the cookie would still work.
		 */
		async signOut(
			request: Request,
			cookies: Map<string, string>,
			session: Session | null,
			context?: OidcCallContext,
			logoutOptions: SignOutOptions = {},
		) {
			const { everywhere = false, providerLogout = true } = signOutOptionsSchema.parse(logoutOptions);
			// Before signing out, require a definitive registry result for any presented cookie.
			if (!session) {
				const checked = await sessions.readSession(cookies, "sign-out");
				if (checked.session && everywhere) {
					// Only a fully resolved session may revoke the user's other sessions.
					throw new Error("Retry signing out everywhere with an active session");
				}
				session = checked.session;
			}
			if (session) {
				const sessionScope = { issuer: session.user.issuer, clientId: session.clientId };
				if (everywhere) await options.registry.endAll({ ...sessionScope, sub: session.user.sub });
				else await options.registry.end({ ...sessionScope, sid: session.sid });
			}
			const refreshToken = session?.refreshToken;
			if (refreshToken) {
				try {
					await withinDeadline(
						() => provider().revokeRefreshToken(refreshToken, context),
						context,
					);
				} catch (error) {
					// The session is already revoked here, and its cookie sealed; report and go on.
					onError({ operation: "token-revocation", error, context });
				}
			}
			const afterLogout = `${origin(request)}${sanitizeReturnPath(settings.postLogoutPath)}`;
			let location = afterLogout;
			try {
				if (providerLogout) location =
					(await withinDeadline(
						() => provider().endSessionUrl(
							{
								idTokenHint: session?.idToken,
								postLogoutRedirectUri: afterLogout,
							},
							context,
						),
						context,
					)) ?? afterLogout;
			} catch (error) {
				// Signing out locally still succeeds when the provider is unreachable.
				onError({ operation: "end-session", error, context });
			}
			return { location, setCookies: sessions.clear(cookies) };
		},

		/** OIDC Back-Channel Logout §§2.6–2.8: validate, commit, then acknowledge. */
		async backchannelLogout(request: Request, context?: OidcCallContext): Promise<{ status: 200 | 400 }> {
			const form = await request.formData().catch(() => undefined);
			const token = form?.get("logout_token");
			if (typeof token !== "string" || token.length === 0) return { status: 400 };
			let target: LogoutTarget;
			try {
				target = await withinDeadline(() => provider().verifyLogoutToken(token, context), context);
			} catch (error) {
				onError({ operation: "backchannel-logout", reason: "logout_validation_failed", error, context });
				return { status: 400 };
			}
			try {
				const { sid, ...event } = target;
				await options.registry.applyLogout(sid !== undefined
					? { ...scope(), ...event, idpSid: sid }
					: { ...scope(), ...event, sub: target.sub! });
			} catch (error) {
				onError({ operation: "backchannel-logout", reason: "logout_storage_failed", error, context });
				return { status: 400 };
			}
			return { status: 200 };
		},

		/** Reports a failure through the configured `onError`. */
		report: onError,

		/**
		 * Throws one error naming every missing or invalid setting, so the
		 * app can refuse to serve before the first sign-in needs them.
		 */
		assertConfigured() {
			assertOidcConfigured(environment());
		},
	};
}

export type OidcCore = ReturnType<typeof createOidcCore>;
