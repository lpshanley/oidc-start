import { redirect } from "@tanstack/react-router";
import { setResponseHeader } from "@tanstack/react-start/server";
import { endSession } from "./sign-out.server.js";
import { checkRecentAuth, getOidcContext } from "./context.js";
import type { AuthSession, SignInOptions } from "@lpshanley/oidc-start-core/models";

export function getAuthBody(): AuthSession {
	setResponseHeader("Cache-Control", "no-store");
	return { user: getOidcContext().auth().user };
}

export function getRecentAuthBody(maxAge: number): AuthSession {
	const auth = getAuthBody();
	return checkRecentAuth({ maxAge }).isStale ? { user: null } : auth;
}

export async function getSignInUrlBody(options?: SignInOptions) {
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

export async function signOutBody(everywhere = false): Promise<never> {
	const result = await endSession(everywhere);
	if (result instanceof Response) throw result;
	throw redirect({ href: result, reloadDocument: true });
}
