import { createOidcCore, type SessionRevocations } from "@lpshanley/oidc-start-react/server";

// Single-process example. A deployed host needs a shared, persistent store.
const sessions = new Map<string, number>();
const providerSessions = new Map<string, number>();
const userCutoffs = new Map<string, number>();

const revocations: SessionRevocations = {
	async isRevoked({ sid, idpSid, sub, issuedAt }) {
		const now = Math.floor(Date.now() / 1000);
		return (sessions.get(sid) ?? 0) >= now
			|| (idpSid !== undefined && (providerSessions.get(idpSid) ?? 0) >= now)
			|| issuedAt <= (userCutoffs.get(sub) ?? 0);
	},
	async revoke(sid, until) { sessions.set(sid, until); },
	async revokeIdpSession(sid, until) {
		providerSessions.set(sid, Math.max(providerSessions.get(sid) ?? 0, until));
	},
	async revokeAllFor(sub, cutoff) {
		userCutoffs.set(sub, Math.max(userCutoffs.get(sub) ?? 0, cutoff));
	},
};

export const auth = createOidcCore({
	cookiePrefix: "example",
	callbackPath: "/callback",
	postLogoutPath: "/",
	allowSession: () => true,
	revocations,
});
