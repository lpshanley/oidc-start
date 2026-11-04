import { redirect } from "@tanstack/react-router";
import { setResponseHeader } from "@tanstack/react-start/server";
import { getOidcContext } from "./context.js";
import type { AuthSession } from "@lpshanley/oidc-start-core/models";

export function getAuthBody(): AuthSession {
	setResponseHeader("Cache-Control", "no-store");
	return { user: getOidcContext().auth().user };
}

export async function getSignInUrlBody(returnPathname?: string) {
	const context = getOidcContext();
	const { url, setCookies } = await context.core.signIn(
		context.request,
		context.cookies,
		returnPathname,
		context.call,
	);
	for (const line of setCookies) context.appendSetCookie(line);
	return url;
}

export async function signOutBody(): Promise<never> {
	const context = getOidcContext();
	const { location, setCookies } = await context.core.signOut(
		context.request,
		context.cookies,
		context.session,
		context.call,
	);
	for (const line of setCookies) context.appendSetCookie(line);
	throw redirect({ href: location, reloadDocument: true });
}
