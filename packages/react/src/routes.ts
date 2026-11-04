import type { SignOutOptions } from "@lpshanley/oidc-start-core/models";
// Server route handler factories, after WorkOS's handleCallbackRoute. They run
// behind oidcMiddleware, which applies the cookies they queue.

import type { CallbackRouteOptions, SignInRouteOptions } from "./routes.server.js";

export type { CallbackRouteOptions, SignInRouteOptions };

type RouteHandler = (args: { request: Request }) => Promise<Response>;

/** GET: redirects to the provider; `?returnPathname=` sets the destination. */
export function handleSignInRoute(
	options: SignInRouteOptions = {},
): RouteHandler {
	return async ({ request }) => {
		const { signInRoute } = await import("./routes.server.js");
		return signInRoute(request, options);
	};
}

/** GET: completes sign-in and redirects to the sanitized return path. */
export function handleCallbackRoute(
	options: CallbackRouteOptions = {},
): RouteHandler {
	return async ({ request }) => {
		const { callbackRoute } = await import("./routes.server.js");
		return callbackRoute(request, options);
	};
}

/** POST: the provider's back-channel logout; ends the sessions its token names. */
export function handleBackchannelLogoutRoute(): RouteHandler {
	return async ({ request }) => {
		const { backchannelLogoutRoute } = await import("./routes.server.js");
		return backchannelLogoutRoute(request);
	};
}

/** POST: clears the session and redirects to the provider logout. */
export function handleSignOutRoute(options: SignOutOptions = {}): RouteHandler {
	return async ({ request }) => {
		const { signOutRoute } = await import("./routes.server.js");
		return signOutRoute(request, options);
	};
}
