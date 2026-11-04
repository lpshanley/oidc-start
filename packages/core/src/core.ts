import { randomNonce, randomPKCECodeVerifier } from "openid-client";
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
import { type AuthUser, sanitizeReturnPath } from "./models.js";
import {
	createProvider,
	type OidcProvider,
} from "./provider.js";
import { createSessionManager } from "./session.js";
import {
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

export type OidcAuth = { user: AuthUser | null };

/** The caller's deadline passed before the provider answered. */
export class OidcDeadlineError extends Error {
	override name = "OidcDeadlineError";
	constructor() {
		super("The request deadline passed before the provider answered");
	}
}

/**
 * Settles with the work, or rejects once the caller's deadline passes. Each
 * provider request also has its own timeout, so abandoned work still ends.
 */
export function withinDeadline<T>(
	work: Promise<T>,
	context?: OidcCallContext,
	now = Date.now(),
): Promise<T> {
	if (context?.deadline === undefined) return work;
	const remaining = context.deadline - now;
	if (remaining <= 0) return Promise.reject(new OidcDeadlineError());
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expired = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new OidcDeadlineError()), remaining);
	});
	return Promise.race([work, expired]).finally(() => clearTimeout(timer));
}

/** The provider authenticated a user whom the host denied a session. */
export class SessionAccessDeniedError extends Error {
	override name = "SessionAccessDeniedError";
	constructor() {
		super("The signed-in account cannot start a session");
	}
}

export type CallbackResult =
	| { ok: true; location: string; setCookies: string[] }
	| { ok: false; error: unknown; setCookies: string[] };

function logIdentityFailure(event: OidcErrorEvent) {
	console.error(
		JSON.stringify({
			level: "error",
			event: `oidc.${event.operation}.failed`,
			component: "identity",
			request_id: event.context?.correlationId,
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
				provider: createProvider(config, settings.providerTimeoutMs),
			};
		}
		return cached.provider;
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

	async function begin(
		request: Request,
		cookies: Map<string, string>,
		returnPathname: string | null | undefined,
		context: OidcCallContext | undefined,
	) {
		const nonce = randomNonce();
		const codeVerifier = randomPKCECodeVerifier();
		const state = await sealState(
			{
				nonce,
				codeVerifier,
				returnPathname: sanitizeReturnPath(returnPathname),
			},
			password(),
		);
		const name = verifierCookieName(prefix(), state);
		const url = await withinDeadline(
			provider().authorizationUrl(
				{
					redirectUri: redirectUri(request),
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
				serializeCookie(name, state, {
					...cookieOptions(),
					maxAge: STATE_MAX_AGE_SECONDS,
				}),
				...stale.map(expire),
			],
		};
	}

	async function complete(
		request: Request,
		cookies: Map<string, string>,
		context: OidcCallContext | undefined,
	) {
		const url = new URL(request.url);
		const state = url.searchParams.get("state");
		const clearVerifier = state
			? [expire(verifierCookieName(prefix(), state))]
			: [];
		try {
			if (!state || !url.searchParams.get("code")) {
				throw new OidcStateError("missing");
			}
			const flow = await verifyCallbackState({
				state,
				cookieValue: cookies.get(verifierCookieName(prefix(), state)),
				password: password(),
			});
			// Rebuild the callback on the registered redirect URI so a proxy
			// in front of the app doesn't change the URL being verified.
			const callbackUrl = new URL(redirectUri(request));
			callbackUrl.search = url.search;
			const { user, tokens, idpSid } = await withinDeadline(
				provider().exchangeCode(
					callbackUrl,
					{
						state,
						nonce: flow.nonce,
						codeVerifier: flow.codeVerifier,
					},
					context,
				),
				context,
			);
			return { ok: true as const, flow, user, tokens, idpSid, clearVerifier };
		} catch (error) {
			return { ok: false as const, error, setCookies: clearVerifier };
		}
	}

	const sessions = createSessionManager({
		cookieName: () => `${prefix()}_session`,
		cookieOptions,
		maxAgeSeconds: settings.sessionMaxAgeSeconds,
		idleSeconds: settings.sessionIdleSeconds,
		password,
		provider,
		revocations: options.revocations,
		allowSession: options.allowSession,
	});

	return {
		/** Reads, and when needed refreshes or clears, the request's session. */
		async resolve(request: Request, context?: OidcCallContext) {
			const cookies = parseCookies(request.headers.get("cookie"));
			const { session, setCookies } = await sessions.resolve(
				cookies,
				(error) => onError({ operation: "refresh", error, context }),
				(work) => withinDeadline(work, context),
				context,
			);
			return { cookies, session, setCookies };
		},

		/** An authorization URL plus the flow's verifier cookie. */
		signIn(
			request: Request,
			cookies: Map<string, string>,
			returnPathname?: string | null,
			context?: OidcCallContext,
		) {
			return begin(request, cookies, returnPathname, context);
		},

		/** Verifies the flow, exchanges the code, and issues the session. */
		async callback(
			request: Request,
			cookies: Map<string, string>,
			context?: OidcCallContext,
		): Promise<CallbackResult> {
			const result = await complete(request, cookies, context);
			if (!result.ok) return result;
			const { user, tokens, idpSid, flow, clearVerifier } = result;
			try {
				if (!options.allowSession(user)) throw new SessionAccessDeniedError();
				const now = Math.floor(Date.now() / 1000);
				return {
					ok: true,
					location: new URL(flow.returnPathname, origin(request)).toString(),
					setCookies: [
						...(await sessions.write(cookies, {
							user,
							...tokens,
							sid: crypto.randomUUID(),
							...(idpSid ? { idpSid } : {}),
							issuedAt: now,
							lastSeenAt: now,
						})),
						...clearVerifier,
					],
				};
			} catch (error) {
				return { ok: false, error, setCookies: clearVerifier };
			}
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
