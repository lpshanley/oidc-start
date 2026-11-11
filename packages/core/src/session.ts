import type { OidcCallContext, OidcMiddlewareOptions } from "./config.js";
import { z } from "zod";
import { type CookieOptions, clearChunked, readChunked, writeChunked } from "./cookies.js";
import { authUserSchema } from "./models.js";
import { withinDeadline } from "./deadline.js";
import type { OidcProvider } from "./provider.js";
import { createMemoryRefreshCoordinator, sharedRefresh, type SessionRefreshCoordinator } from "./refresh.js";
import type { SessionRegistry, SessionScope } from "./registry.js";
import { sealValue, unsealValue } from "./seal.js";

export const REFRESH_LEEWAY_SECONDS = 30;
const sessionSchema = z.object({
	version: z.literal(2),
	clientId: z.string().min(1),
	user: authUserSchema,
	accessToken: z.string().min(1), refreshToken: z.string().min(1).optional(),
	refreshGeneration: z.number().int().nonnegative().optional(),
	idToken: z.string().min(1).optional(), expiresAt: z.number(),
	sid: z.string().min(1), issuedAt: z.number(),
	authTime: z.number().nonnegative().optional(), lastSeenAt: z.number(),
	idpSid: z.string().min(1).optional(),
});
export type Session = z.infer<typeof sessionSchema>;
export type SessionReason = "no_session" | "invalid_session" | "session_expired" | "session_ended"
	| "access_denied" | "registry_unavailable" | "policy_unavailable" | "refresh_unavailable"
	| "refresh_busy" | "reauth_required";
export type SessionResolution = { setCookies: string[] } & (
	| { status: "authenticated"; session: Session; reason?: never }
	| { status: "anonymous" | "denied" | "unavailable"; session: null; reason: SessionReason }
);
export type SessionReport = (error: unknown, operation: "refresh" | "registry-read" | "session-policy", reason: SessionReason) => void;

const isGrantRefused = (error: unknown) => (error as { error?: unknown } | null)?.error === "invalid_grant";

export function createSessionManager({
	cookieName: name, cookieOptions, maxAgeSeconds, idleSeconds, password, provider,
	registry, scope, refreshCoordinator = createMemoryRefreshCoordinator(), allowSession = () => true,
}: {
	cookieName: () => string; cookieOptions: () => CookieOptions;
	maxAgeSeconds: number; idleSeconds: number; password: () => string; provider: () => OidcProvider;
	registry: SessionRegistry; scope: () => SessionScope;
	refreshCoordinator?: SessionRefreshCoordinator; allowSession?: OidcMiddlewareOptions["allowSession"];
}) {
	const touchAfterSeconds = Math.max(1, Math.min(300, Math.floor(idleSeconds / 100)));
	async function write(cookies: Map<string, string>, session: Session) {
		return writeChunked(cookies, name(), await sealValue(session, password(), maxAgeSeconds), {
			...cookieOptions(), maxAge: maxAgeSeconds,
		});
	}
	const clear = (cookies: Map<string, string>) => clearChunked(cookies, name(), cookieOptions());
	const isAllowed = async (user: Session["user"]) => (await allowSession(user)) === true;
	const key = (session: Session) => ({ issuer: session.user.issuer, clientId: session.clientId, sid: session.sid });
	const absent = (reason: SessionReason, setCookies: string[] = []): SessionResolution => ({ status: "anonymous", reason, session: null, setCookies });

	async function readSession(cookies: Map<string, string>, purpose: "access" | "sign-out", report: SessionReport = () => {}): Promise<SessionResolution> {
		const sealed = readChunked(cookies, name());
		if (sealed === undefined) return absent("no_session");
		let session: Session;
		try { session = sessionSchema.parse(await unsealValue(sealed, password(), maxAgeSeconds)); }
		catch { return absent("invalid_session", clear(cookies)); }
		const expected = scope();
		if (session.user.issuer !== expected.issuer || session.clientId !== expected.clientId) return absent("invalid_session", clear(cookies));
		const now = Math.floor(Date.now() / 1000);
		if (now >= session.issuedAt + maxAgeSeconds || (purpose === "access" && now > session.lastSeenAt + idleSeconds)) return absent("session_expired", clear(cookies));
		try {
			if (!(await registry.isActive(key(session)))) return absent("session_ended", clear(cookies));
		} catch (error) {
			if (purpose === "sign-out") throw error;
			report(error, "registry-read", "registry_unavailable");
			return { status: "unavailable", reason: "registry_unavailable", session: null, setCookies: [] };
		}
		return { status: "authenticated", session, setCookies: [] };
	}

	async function policy(session: Session, report: SessionReport): Promise<SessionResolution> {
		try {
			if (!(await isAllowed(session.user))) {
				// Keep the sealed session so a denied request stays 403 instead of looping
				// through authorization. Refresh may later supply changed membership.
				return { status: "denied", reason: "access_denied", session: null, setCookies: [] };
			}
		} catch (error) {
			report(error, "session-policy", "policy_unavailable");
			return { status: "unavailable", reason: "policy_unavailable", session: null, setCookies: [] };
		}
		return { status: "authenticated", session, setCookies: [] };
	}

	async function resolve(cookies: Map<string, string>, report: SessionReport = () => {}, context?: OidcCallContext): Promise<SessionResolution> {
		const checked = await readSession(cookies, "access", report);
		if (checked.status !== "authenticated") return checked;
		const { session } = checked;
		const now = Math.floor(Date.now() / 1000);
		if (session.expiresAt - now > REFRESH_LEEWAY_SECONDS) {
			const allowed = await policy(session, report);
			if (allowed.status !== "authenticated" || now - session.lastSeenAt < touchAfterSeconds) return allowed;
			const touched = { ...session, lastSeenAt: now };
			return { status: "authenticated", session: touched, setCookies: await write(cookies, touched) };
		}
		if (!session.refreshToken) return absent("reauth_required", clear(cookies));
		let fresh;
		try {
			fresh = await withinDeadline(() => sharedRefresh(refreshCoordinator, {
				session, until: session.issuedAt + maxAgeSeconds, password: password(),
				refresh: () => provider().refresh(session.refreshToken!, session.user.sub, context),
			}), context);
		} catch (error) {
			report(error, "refresh", "refresh_unavailable");
			return { status: "unavailable", reason: "refresh_unavailable", session: null, setCookies: [] };
		}
		if (fresh.status === "busy") return { status: "unavailable", reason: "refresh_busy", session: null, setCookies: [] };
		// A stale request must not erase a newer cookie written by a peer.
		if (fresh.status === "reauth_required") {
			// The provider ending the grant is an ordinary expiry. Anything else, such
			// as a 500 or a timeout after dispatch, signed the user out and is reported.
			if ("failure" in fresh && fresh.failure && !isGrantRefused(fresh.failure.error)) report(fresh.failure.error, "refresh", "reauth_required");
			return absent("reauth_required");
		}
		const { roles, email, ...tokens } = fresh.tokens;
		const refreshed: Session = {
			...session, ...tokens, refreshGeneration: (session.refreshGeneration ?? 0) + 1,
			idToken: tokens.idToken ?? session.idToken,
			user: { ...session.user, roles, email: email ?? session.user.email }, lastSeenAt: now,
		};
		// Logout while a provider call was in flight wins over renewal.
		const stillActive = await readSession(cookies, "access", report);
		if (stillActive.status !== "authenticated") return stillActive.status === "unavailable"
			? { ...stillActive, setCookies: await write(cookies, refreshed) } : stillActive;
		const allowed = await policy(refreshed, report);
				// Persist renewed credentials even when admission is denied or unavailable, so later reads
		// remain denied and cannot retry a consumed refresh token.
		return { ...allowed, setCookies: await write(cookies, refreshed) };
	}
	return { isAllowed, readSession, resolve, write, clear };
}
export type SessionManager = ReturnType<typeof createSessionManager>;
