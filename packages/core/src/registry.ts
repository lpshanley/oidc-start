/** One relying party. Identifiers from different issuers or clients never overlap. */
export type SessionScope = { issuer: string; clientId: string };
export type SessionKey = SessionScope & { sid: string };
export type SessionRecord = SessionKey & {
	sub: string;
	idpSid?: string;
	/** Absolute application session expiry, in epoch seconds. */
	expiresAt: number;
};
export type ProviderLogout = SessionScope & {
	jti: string;
	issuedAt: number;
	expiresAt: number;
} & ({ idpSid: string; sub?: string } | { idpSid?: never; sub: string });

/**
 * Active application sessions, never a ban on future authorization.
 * Mutations within a scope must be atomically ordered. applyLogout atomically
 * remembers the event through expiresAt and removes currently matching sessions;
 * a duplicate is a no-op. If both sub and idpSid are present, match both.
 * isActive checks expiry at read time. Cleanup is not an authorization mechanism.
 * Use shared, durable, read-after-write consistent storage in production.
 * Methods throw on storage failure. Never hold a transaction over a provider call.
 */
export interface SessionRegistry {
	register(session: SessionRecord): Promise<void>;
	isActive(session: SessionKey): Promise<boolean>;
	end(session: SessionKey): Promise<void>;
	endAll(subject: SessionScope & { sub: string }): Promise<void>;
	applyLogout(event: ProviderLogout): Promise<void>;
}

/** Single-process reference implementation for development and contract tests. */
export function createMemorySessionRegistry(now = () => Math.floor(Date.now() / 1000)): SessionRegistry {
	const sessions = new Map<string, SessionRecord>();
	const receipts = new Map<string, number>();
	const scope = (s: SessionScope) => JSON.stringify([s.issuer, s.clientId]);
	const key = (s: SessionKey) => JSON.stringify([s.issuer, s.clientId, s.sid]);
	return {
		async register(session) {
			if (sessions.has(key(session))) throw new Error("Application session ID already exists");
			sessions.set(key(session), { ...session });
		},
		async isActive(session) { return (sessions.get(key(session))?.expiresAt ?? 0) > now(); },
		async end(session) { sessions.delete(key(session)); },
		async endAll(subject) {
			for (const [id, s] of sessions) if (scope(s) === scope(subject) && s.sub === subject.sub) sessions.delete(id);
		},
		async applyLogout(event) {
			const at = now();
			for (const [id, expiry] of receipts) if (expiry <= at) receipts.delete(id);
			for (const [id, s] of sessions) if (s.expiresAt <= at) sessions.delete(id);
			const id = JSON.stringify([event.issuer, event.clientId, event.jti]);
			if (receipts.has(id)) return;
			receipts.set(id, event.expiresAt);
			for (const [id, s] of sessions) {
				if (scope(s) === scope(event) && (event.idpSid === undefined || s.idpSid === event.idpSid)
					&& (event.sub === undefined || s.sub === event.sub)) sessions.delete(id);
			}
		},
	};
}
