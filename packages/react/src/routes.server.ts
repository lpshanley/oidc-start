import { endSession } from "./sign-out.server.js";
import { getOidcContext } from "./context.js";
import type { CallbackErrorReason } from "@lpshanley/oidc-start-core";

import type { SignInOptions } from "@lpshanley/oidc-start-core/models";

type FailureOptions = {
	/** Where to send the browser when sign-in fails. Defaults to a 400. */
	errorRedirectUrl?: string;
	/** Shown when the host denies a session to an authenticated user. */
	accessDeniedMessage?: string;
};

export type SignInRouteOptions = FailureOptions & SignInOptions;

export type CallbackRouteOptions = FailureOptions & {
	/** Customize callback failures after the verifier cookie has been queued for cleanup. */
	onError?: (failure: { reason: CallbackErrorReason; request: Request }) => Response | Promise<Response>;
};

function redirectTo(location: string, status: number) {
	return new Response(null, {
		status,
		headers: { Location: location, "Cache-Control": "no-store" },
	});
}

function failure(
	request: Request,
	options: FailureOptions,
) {
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
	options: SignInRouteOptions,
) {
	const context = getOidcContext();
	try {
		const query = new URL(request.url).searchParams;
		const requestedAge = query.get("maxAge");
		let maxAge = options.maxAge;
		if (requestedAge !== null) {
			const age = Number(requestedAge);
			if (!/^\d+$/.test(requestedAge) || !Number.isSafeInteger(age)) {
				return new Response("Invalid maxAge.", { status: 400, headers: { "Cache-Control": "no-store" } });
			}
			maxAge = Math.min(maxAge ?? age, age);
		}
		const { url, setCookies } = await context.core.signIn(
			request,
			context.cookies,
			{
				returnPathname: query.get("returnPathname") ?? options.returnPathname,
				loginHint: options.loginHint,
				maxAge,
				prompt: options.prompt,
			},
			context.call,
		);
		for (const line of setCookies) context.appendSetCookie(line);
		return redirectTo(url, 307);
	} catch (error) {
		context.core.report({ operation: "sign-in", error, context: context.call });
		return failure(request, options);
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
	if (result.ok) context.discardSessionUpdates?.();
	for (const line of result.setCookies) context.appendSetCookie(line);
	if (result.ok) return redirectTo(result.location, 307);
	if (result.reason === "session_access_denied") {
		return new Response(
			options.accessDeniedMessage ?? "Your account does not have access.",
			{
				status: 403,
				headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" },
			},
		);
	}
	context.core.report({ operation: "callback", error: result.error, context: context.call });
	if (options.onError) return options.onError({ reason: result.reason, request });
	return failure(request, options);
}

export async function signOutRoute(request: Request) {
	if (request.method !== "POST") {
		return new Response("Method Not Allowed", {
			status: 405,
			headers: { Allow: "POST" },
		});
	}
	const form = await request.formData().catch(() => undefined);
	const result = await endSession(form?.get("everywhere") === "1");
	return result instanceof Response ? result : redirectTo(result, 303);
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
