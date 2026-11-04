import type { OidcCallContext, OidcMiddlewareOptions } from "./config.js";
import { z } from "zod";
import {
	type CookieOptions,
	clearChunked,
	readChunked,
	writeChunked,
} from "./cookies.js";
import { authUserSchema } from "./models.js";
import type { OidcProvider, RefreshedTokens } from "./provider.js";
import { RECENT_REFRESH_MS, sharedRefresh, type SessionRefreshCoordinator } from "./refresh.js";
import type { SessionRevocations } from "./revocation.js";
import { sealValue, unsealValue } from "./seal.js";

export type { SessionRevocations };

// Session resolution after WorkOS authkit-session's AuthKitCore and
// AuthService: the sealed cookie holds the user and tokens, and an expiring
// access token is refreshed with in-flight deduplication. Unlike WorkOS, it
// refreshes shortly before expiry and clears the cookie when refresh fails.

/** Refresh this many seconds before the access token expires. */
export const REFRESH_LEEWAY_SECONDS = 30;

const sessionSchema = z.object({
	user: authUserSchema,
	accessToken: z.string().min(1),
	refreshToken: z.string().min(1).optional(),
	/** Sequence number of this session’s last coordinated token refresh. */
	refreshGeneration: z.number().int().nonnegative().optional(),
	idToken: z.string().min(1).optional(),
	expiresAt: z.number(),
	/** Random id naming this sign-in, so it can be revoked server-side. */
	sid: z.string().min(1),
	/** Seconds since epoch of sign-in; bounds the absolute lifetime. */
	issuedAt: z.number(),
	/** Provider authentication time from the sign-in ID token, in epoch seconds. */
	authTime: z.number().nonnegative().optional(),
	/** Seconds since epoch of the last request; bounds the idle lifetime. */
	lastSeenAt: z.number(),
	/** The provider's session id (ID token `sid`), when it sends one. */
	idpSid: z.string().min(1).optional(),
});
export type Session = z.infer<typeof sessionSchema>;

/** Re-seal the cookie once the last-seen time is this stale, to keep idle tracking current. */
export const TOUCH_AFTER_SECONDS = 300;

export type SessionResolution = {
	session: Session | null;
	/** Set-Cookie lines to apply: a refreshed session, or a cleared one. */
	setCookies: string[];
};

export function createSessionManager({
	cookieName: name,
	cookieOptions,
	maxAgeSeconds,
	idleSeconds,
	password,
	provider,
	revocations,
	refreshCoordinator,
	allowSession,
}: {
	cookieName: () => string;
	cookieOptions: () => CookieOptions;
	/** Absolute lifetime from sign-in. */
	maxAgeSeconds: number;
	/** Lifetime without requests. */
	idleSeconds: number;
	password: () => string;
	provider: () => OidcProvider;
	revocations: SessionRevocations;
	refreshCoordinator?: SessionRefreshCoordinator;
	/** Whether the (possibly refreshed) user may keep a session. */
	allowSession: OidcMiddlewareOptions["allowSession"];
}) {
	const refreshes = new Map<
		string,
		{ result: Promise<RefreshedTokens>; settledAt?: number }
	>();

	function refreshOnce(
		refreshToken: string,
		sub: string,
		context?: OidcCallContext,
	) {
		const now = Date.now();
		for (const [token, entry] of refreshes) {
			if (entry.settledAt && now - entry.settledAt > RECENT_REFRESH_MS) {
				refreshes.delete(token);
			}
		}
		const existing = refreshes.get(refreshToken);
		if (existing) return existing.result;
		const entry: { result: Promise<RefreshedTokens>; settledAt?: number } = {
			result: provider()
				.refresh(refreshToken, sub, context)
				.then(
					(tokens) => {
						entry.settledAt = Date.now();
						return tokens;
					},
					(error: unknown) => {
						refreshes.delete(refreshToken);
						throw error;
					},
				),
		};
		refreshes.set(refreshToken, entry);
		return entry.result;
	}

	async function write(cookies: Map<string, string>, session: Session) {
		const sealed = await sealValue(session, password(), maxAgeSeconds);
		return writeChunked(cookies, name(), sealed, {
			...cookieOptions(),
			maxAge: maxAgeSeconds,
		});
	}

	function clear(cookies: Map<string, string>) {
		return clearChunked(cookies, name(), cookieOptions());
	}

	async function isAllowed(user: Session["user"]) {
		return (await allowSession(user)) === true;
	}

	// Verify the cookie, host policy, lifetimes, and revocation before using it.
	// A store read failure propagates so sign-out can be retried.
	async function readActive(
		cookies: Map<string, string>,
		onStoreError?: (error: unknown) => void,
	): Promise<SessionResolution> {
		const sealed = readChunked(cookies, name());
		if (sealed === undefined) return { session: null, setCookies: [] };
		let session: Session;
		try {
			session = sessionSchema.parse(
				await unsealValue(sealed, password(), maxAgeSeconds),
			);
		} catch {
			return { session: null, setCookies: clear(cookies) };
		}
		const now = Math.floor(Date.now() / 1000);
		if (
			now - session.issuedAt > maxAgeSeconds ||
			now - session.lastSeenAt > idleSeconds ||
			!(await isAllowed(session.user))
		) {
			return { session: null, setCookies: clear(cookies) };
		}
		try {
			const revoked = await revocations.isRevoked({
				sid: session.sid,
				sub: session.user.sub,
				issuedAt: session.issuedAt,
				...(session.idpSid !== undefined && { idpSid: session.idpSid }),
			});
			if (revoked) {
				return { session: null, setCookies: clear(cookies) };
			}
		} catch (error) {
			if (!onStoreError) throw error;
			onStoreError(error);
			return { session: null, setCookies: [] };
		}
		return { session, setCookies: [] };
	}

	async function resolve(
		cookies: Map<string, string>,
		onError: (error: unknown, operation: "refresh" | "revocation-read") => void = () => {},
		bound: <T>(work: Promise<T>) => Promise<T> = (work) => work,
		context?: OidcCallContext,
	): Promise<SessionResolution> {
		const checked = await readActive(cookies, (error) => onError(error, "revocation-read"));
		const { session } = checked;
		if (!session) return checked;
		const now = Math.floor(Date.now() / 1000);
		if (session.expiresAt - now > REFRESH_LEEWAY_SECONDS) {
			if (now - session.lastSeenAt < TOUCH_AFTER_SECONDS) {
				return { session, setCookies: [] };
			}
			const touched = { ...session, lastSeenAt: now };
			return { session: touched, setCookies: await write(cookies, touched) };
		}
		if (!session.refreshToken) {
			return { session: null, setCookies: clear(cookies) };
		}
		try {
			const refreshToken = session.refreshToken;
			const work = refreshCoordinator
				? sharedRefresh(refreshCoordinator, {
					session,
					until: session.issuedAt + maxAgeSeconds,
					password: password(),
					refresh: () => provider().refresh(refreshToken, session.user.sub, context),
				})
				: refreshOnce(refreshToken, session.user.sub, context);
			const refreshedTokens = await bound(work);
			if (!refreshedTokens) return { session: null, setCookies: [] };
			const { roles, ...tokens } = refreshedTokens;
			const refreshed: Session = {
				...session,
				...tokens,
				...(refreshCoordinator && { refreshGeneration: (session.refreshGeneration ?? 0) + 1 }),
				idToken: tokens.idToken ?? session.idToken,
				user: { ...session.user, roles },
				lastSeenAt: now,
			};
			if (!(await isAllowed(refreshed.user))) {
				return { session: null, setCookies: clear(cookies) };
			}
			return {
				session: refreshed,
				setCookies: await write(cookies, refreshed),
			};
		} catch (error) {
			onError(error, "refresh");
			// A peer may already have written the renewed cookie, even if this
			// caller timed out. A failed coordinated refresh must never erase it.
			return { session: null, setCookies: refreshCoordinator ? [] : clear(cookies) };
		}
	}

	return { isAllowed, readActive, resolve, write, clear };
}

export type SessionManager = ReturnType<typeof createSessionManager>;
