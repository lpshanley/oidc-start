import { redirect } from "@tanstack/react-router";
import { setResponseHeader, setResponseStatus } from "@tanstack/react-start/server";
import { endSession } from "./sign-out.server.js";
import { checkRecentAuth, getOidcContext } from "./context.js";
import type { AuthSession, SignInOptions, SignOutOptions } from "@lpshanley/oidc-start-core/models";

export function getAuthBody(): AuthSession {
	setResponseHeader("Cache-Control", "no-store");
	const auth = getOidcContext().auth();
	if (auth.status === "denied" || auth.status === "unavailable") {
        const status = auth.status === "denied" ? 403 : 503;
        setResponseStatus(status);
        // Loader errors must serialize during SSR. A thrown Response cannot.
        throw Object.assign(new Error(auth.status === "denied"
          ? "Your account does not have access."
          : "Authentication is temporarily unavailable. Try again."), { status });
	}
	return { user: auth.user };
}

export function getRecentAuthBody(maxAge: number): AuthSession {
	const auth = getAuthBody();
	return checkRecentAuth({ maxAge }).isStale ? { user: null } : auth;
}

export async function getSignInUrlBody(options?: SignInOptions) {
	setResponseHeader("Cache-Control", "no-store");
	const context = getOidcContext();
	const { url, setCookies } = await context.core.signIn(
		context.request,
		context.cookies,
		options,
		context.call,
	);
	for (const line of setCookies) context.appendSetCookie(line);
	return url;
}

export async function signOutBody(options: SignOutOptions = {}): Promise<never> {
	const result = await endSession(options);
	if (result instanceof Response) throw result;
	throw redirect({ href: result, reloadDocument: true });
}
