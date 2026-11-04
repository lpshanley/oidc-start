import { z } from "zod";
import {
	type CookieOptions,
	clearChunked,
	readChunked,
	writeChunked,
} from "./cookies.js";
import { authUserSchema } from "./models.js";
import type { SessionRevocations } from "./revocation.js";
import { sealValue, unsealValue } from "./seal.js";

export type { SessionRevocations };

const sessionSchema = z.object({
	user: authUserSchema,
	accessToken: z.string().min(1),
	refreshToken: z.string().min(1).optional(),
	idToken: z.string().min(1).optional(),
	expiresAt: z.number(),
	/** Random id naming this sign-in, so it can be revoked server-side. */
	sid: z.string().min(1),
	/** Seconds since epoch of sign-in; bounds the absolute lifetime. */
	issuedAt: z.number(),
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
	revocations,
	allowSession,
}: {
	cookieName: () => string;
	cookieOptions: () => CookieOptions;
	/** Absolute lifetime from sign-in. */
	maxAgeSeconds: number;
	/** Lifetime without requests. */
	idleSeconds: number;
	password: () => string;
	revocations: SessionRevocations;
	/** Whether the (possibly refreshed) user may keep a session. */
	allowSession: (user: Session["user"]) => boolean;
}) {
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

	async function resolve(
		cookies: Map<string, string>,
		onRefreshError: (error: unknown) => void = () => {},
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
			!allowSession(session.user)
		) {
			return { session: null, setCookies: clear(cookies) };
		}
		try {
			if (await revocations.isRevoked({ ...session, sub: session.user.sub })) {
				return { session: null, setCookies: clear(cookies) };
			}
		} catch (error) {
			// Fail closed, but keep the cookie: the session may be valid once the store is back.
			onRefreshError(error);
			return { session: null, setCookies: [] };
		}
		if (session.expiresAt > now) {
			if (now - session.lastSeenAt < TOUCH_AFTER_SECONDS) {
				return { session, setCookies: [] };
			}
			const touched = { ...session, lastSeenAt: now };
			return { session: touched, setCookies: await write(cookies, touched) };
		}
		return { session: null, setCookies: clear(cookies) };
	}

	return { resolve, write, clear };
}

export type SessionManager = ReturnType<typeof createSessionManager>;
