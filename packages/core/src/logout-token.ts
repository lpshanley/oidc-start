import { errors, type JWTPayload } from "jose";
import { z } from "zod";

// OpenID Connect Back-Channel Logout 1.0, section 2.6: the checks that apply
// after the signature, issuer, and audience have been verified.

export const LOGOUT_TOKEN_MAX_AGE_SECONDS = 600;

export const BACKCHANNEL_LOGOUT_EVENT =
	"http://schemas.openid.net/event/backchannel-logout";

/** The logout token is malformed or not one this app accepts. */
export class LogoutTokenError extends Error {
	override name = "LogoutTokenError";
}

/** Only reject the token when its contents, claims or signature fail validation. */
export function isInvalidLogoutToken(error: unknown) {
	return error instanceof LogoutTokenError
		|| error instanceof errors.JWTInvalid
		|| error instanceof errors.JWSInvalid
		|| error instanceof errors.JWTClaimValidationFailed
		|| error instanceof errors.JWTExpired
		|| error instanceof errors.JOSEAlgNotAllowed
		|| error instanceof errors.JOSENotSupported
		|| error instanceof errors.JWKSNoMatchingKey
		|| error instanceof errors.JWKSMultipleMatchingKeys
		|| error instanceof errors.JWSSignatureVerificationFailed;
}

/** Which sign-ins a logout token ends: one provider session, or all of a user's. */
export type LogoutTarget = ({ sid: string; sub?: string } | { sub: string; sid?: never }) & { issuedAt: number; expiresAt: number; jti: string };

const NO_LOGOUT_EVENT = "The token carries no back-channel logout event";
const NO_TOKEN_ID = "The logout token has no token ID";
const logoutClaims = z.object({
	events: z.object(
		{ [BACKCHANNEL_LOGOUT_EVENT]: z.looseObject({}, { error: NO_LOGOUT_EVENT }) },
		{ error: NO_LOGOUT_EVENT },
	),
	iat: z.number({ error: "The token has no issued-at time" }),
	jti: z.string({ error: NO_TOKEN_ID }).regex(/\S/, NO_TOKEN_ID),
	exp: z.number({ error: "Missing expiry" }),
	sid: z.string().optional().catch(undefined),
	sub: z.string().optional().catch(undefined),
});

export function logoutTarget(payload: JWTPayload): LogoutTarget {
	if ("nonce" in payload) {
		throw new LogoutTokenError("A logout token must not carry a nonce");
	}
	const claims = logoutClaims.safeParse(payload);
	if (!claims.success) throw new LogoutTokenError(claims.error.issues[0].message);
	const { iat, exp, jti, sid, sub } = claims.data;
	const event = { issuedAt: iat, expiresAt: exp, jti };
	if (sid) return { ...event, sid, ...(sub && { sub }) };
	if (sub) return { ...event, sub };
	throw new LogoutTokenError("The token names neither a session nor a user");
}
