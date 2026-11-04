/** Server-side record of ended sessions. Methods throw when the store is unavailable. */
export interface SessionRevocations {
	/**
	 * Whether this session was signed out, its provider session was logged out,
	 * or it started at or before its user's cutoff.
	 */
	isRevoked(session: {
		sid: string;
		sub: string;
		issuedAt: number;
		idpSid?: string;
	}): Promise<boolean>;
	/** Ends one session; `until` (epoch seconds) is when its cookie expires anyway. */
	revoke(sid: string, until: number): Promise<void>;
	/** Ends sessions for `idpSid`. Atomically keep the later of the stored and supplied expiry. */
	revokeIdpSession(idpSid: string, until: number): Promise<void>;
	/** Ends sessions of `sub` issued at or before `cutoff` (epoch seconds). Atomically keep the greatest cutoff. */
	revokeAllFor(sub: string, cutoff: number): Promise<void>;
}
