import { getGlobalStartContext } from "@tanstack/react-start";
import type { OidcCallContext } from "@lpshanley/oidc-start-core/config";
import type { OidcAuth, OidcCore } from "@lpshanley/oidc-start-core";
import type { Session } from "@lpshanley/oidc-start-core";

/** Request-scoped auth state that oidcMiddleware places in Start's context. */
export type OidcContext = {
	core: OidcCore;
	request: Request;
	cookies: Map<string, string>;
	session: Session | null;
	/** The caller's request context, when one was provided upstream. */
	call: OidcCallContext | undefined;
	auth: () => OidcAuth;
	/** Queue a Set-Cookie line for the final response. */
	appendSetCookie: (line: string) => void;
};

const NOT_CONFIGURED =
	"OIDC middleware is not configured. Add oidcMiddleware() to requestMiddleware in src/start.ts.";

function isOidcContext(value: unknown): value is OidcContext {
	return (
		typeof value === "object" &&
		value !== null &&
		"core" in value &&
		"auth" in value &&
		"appendSetCookie" in value
	);
}

/** The current request's OIDC context; throws outside the middleware. */
export function getOidcContext(): OidcContext {
	const context = getGlobalStartContext() as { oidc?: unknown } | undefined;
	if (!isOidcContext(context?.oidc)) throw new Error(NOT_CONFIGURED);
	return context.oidc;
}

/** Check the resolved session inside the server handler that performs a sensitive action. */
export function checkRecentAuth({ maxAge }: { maxAge: number }): { isStale: boolean } {
	if (!Number.isSafeInteger(maxAge) || maxAge < 0) {
		throw new RangeError("maxAge must be a nonnegative integer in seconds");
	}
	const authTime = getOidcContext().session?.authTime;
	if (authTime === undefined) return { isStale: true };
	const age = Math.floor(Date.now() / 1000) - authTime;
	return { isStale: !(age >= 0 && age <= maxAge) };
}
