/** Server-side record of ended sessions. Methods throw when the store is unavailable. */
export interface SessionRevocations {
	/**
	 * Whether this session was signed out, its provider session was logged out,
	 * or it started before its user's cutoff.
	 */
	isRevoked(session: {
		sid: string;
		sub: string;
		issuedAt: number;
		idpSid?: string;
	}): Promise<boolean>;
	/** Ends one session; `until` (epoch seconds) is when its cookie expires anyway. */
	revoke(sid: string, until: number): Promise<void>;
	/** Ends every session signed in through the provider session `idpSid`. */
	revokeIdpSession(idpSid: string, until: number): Promise<void>;
	/** Ends every session of `sub` that started before `cutoff` (epoch seconds). */
	revokeAllFor(sub: string, cutoff: number): Promise<void>;
}
