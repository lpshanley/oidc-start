import { getOidcContext } from "./context.js";
import { SessionAccessDeniedError } from "@lpshanley/oidc-start-core";

export type CallbackRouteOptions = {
	/** Where to send the browser when sign-in fails. Defaults to a 400. */
	errorRedirectUrl?: string;
	/** Shown when the host denies a session to an authenticated user. */
	accessDeniedMessage?: string;
};

function redirectTo(location: string, status: number) {
	return new Response(null, {
		status,
		headers: { Location: location, "Cache-Control": "no-store" },
	});
}

function failure(
	request: Request,
	options: CallbackRouteOptions,
	operation: "sign-in" | "callback",
	error: unknown,
) {
	// Provider error details go to onError, never into the response.
	const context = getOidcContext();
	context.core.report({ operation, error, context: context.call });
	if (options.errorRedirectUrl) {
		return redirectTo(
			new URL(options.errorRedirectUrl, request.url).toString(),
			303,
		);
	}
	return new Response("Authentication failed. Restart sign-in.", {
		status: 400,
		headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" },
	});
}

export async function signInRoute(
	request: Request,
	options: CallbackRouteOptions,
) {
	const context = getOidcContext();
	try {
		const { url, setCookies } = await context.core.signIn(
			request,
			context.cookies,
			new URL(request.url).searchParams.get("returnPathname"),
			context.call,
		);
		for (const line of setCookies) context.appendSetCookie(line);
		return redirectTo(url, 307);
	} catch (error) {
		return failure(request, options, "sign-in", error);
	}
}

export async function callbackRoute(
	request: Request,
	options: CallbackRouteOptions,
) {
	const context = getOidcContext();
	const result = await context.core.callback(
		request,
		context.cookies,
		context.call,
	);
	for (const line of result.setCookies) context.appendSetCookie(line);
	if (result.ok) return redirectTo(result.location, 307);
	if (result.error instanceof SessionAccessDeniedError) {
		return new Response(
			options.accessDeniedMessage ?? "Your account does not have access.",
			{
				status: 403,
				headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" },
			},
		);
	}
	return failure(request, options, "callback", result.error);
}

export async function signOutRoute(request: Request) {
	if (request.method !== "POST") {
		return new Response("Method Not Allowed", {
			status: 405,
			headers: { Allow: "POST" },
		});
	}
	const context = getOidcContext();
	const form = await request.formData().catch(() => undefined);
	let result: { location: string; setCookies: string[] };
	try {
		result = await context.core.signOut(
			request,
			context.cookies,
			context.session,
			context.call,
			form?.get("everywhere") === "1",
		);
	} catch (error) {
		// The revocation was not recorded, so the cookie would still work: say so.
		context.core.report({
			operation: "end-session",
			error,
			context: context.call,
		});
		return new Response("Sign-out could not be recorded. Try again.", {
			status: 503,
			headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" },
		});
	}
	const { location, setCookies } = result;
	for (const line of setCookies) context.appendSetCookie(line);
	return redirectTo(location, 303);
}

export async function backchannelLogoutRoute(request: Request) {
	if (request.method !== "POST") {
		return new Response("Method Not Allowed", {
			status: 405,
			headers: { Allow: "POST" },
		});
	}
	const context = getOidcContext();
	const { status } = await context.core.backchannelLogout(
		request,
		context.call,
	);
	return new Response(null, {
		status,
		headers: { "Cache-Control": "no-store" },
	});
}
