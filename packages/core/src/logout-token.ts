import type { JWTPayload } from "jose";

// OpenID Connect Back-Channel Logout 1.0, section 2.6: the checks that apply
// after the signature, issuer, and audience have been verified.

export const BACKCHANNEL_LOGOUT_EVENT =
	"http://schemas.openid.net/event/backchannel-logout";

/** The logout token is malformed or not one this app accepts. */
export class LogoutTokenError extends Error {
	override name = "LogoutTokenError";
}

/** Which sign-ins a logout token ends: one provider session, or all of a user's. */
export type LogoutTarget = { sid: string } | { sub: string };

export function logoutTarget(payload: JWTPayload): LogoutTarget {
	const events = payload.events;
	if (
		typeof events !== "object" ||
		events === null ||
		!(BACKCHANNEL_LOGOUT_EVENT in events)
	) {
		throw new LogoutTokenError(
			"The token carries no back-channel logout event",
		);
	}
	if ("nonce" in payload) {
		throw new LogoutTokenError("A logout token must not carry a nonce");
	}
	if (typeof payload.iat !== "number") {
		throw new LogoutTokenError("The token has no issued-at time");
	}
	const sid = typeof payload.sid === "string" ? payload.sid : "";
	if (sid) return { sid };
	const sub = typeof payload.sub === "string" ? payload.sub : "";
	if (sub) return { sub };
	throw new LogoutTokenError("The token names neither a session nor a user");
}
