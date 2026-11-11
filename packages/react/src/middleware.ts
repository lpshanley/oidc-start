import { createMiddleware } from "@tanstack/react-start";
import type { OidcCallContext, OidcMiddlewareOptions } from "@lpshanley/oidc-start-core/config";
import type { OidcContext } from "./context.js";
import type { OidcCore } from "@lpshanley/oidc-start-core";

export type OidcMiddlewareSetup =
	| OidcMiddlewareOptions
	| {
			/**
			 * A core the app composed itself. One middleware serves one core:
			 * this is called once, on the first request, and the result is
			 * reused for every request after. It cannot choose a core per
			 * request. For several tenants, create one middleware per tenant.
			 */
			core: () => OidcCore;
	  };

/** `context.requestContext` from an earlier middleware, when it has the shape. */
function callContext(context: unknown): OidcCallContext | undefined {
	const value = (context as { requestContext?: unknown } | undefined)
		?.requestContext;
	if (typeof value !== "object" || value === null) return undefined;
	const { correlationId, deadline, signal } = value as Record<string, unknown>;
	return {
		...(signal instanceof AbortSignal ? { signal } : {}),
		correlationId:
			typeof correlationId === "string" ? correlationId : undefined,
		deadline: typeof deadline === "number" ? deadline : undefined,
	};
}

/**
 * Request middleware after WorkOS's authkitMiddleware: resolves the session
 * (refreshing or clearing it as needed), exposes it as `context.oidc`, and
 * appends every queued Set-Cookie line to the final response. Create it once
 * outside createStart so discovery and refresh state persist across requests.
 */
export function oidcMiddleware(setup: OidcMiddlewareSetup) {
	let core: OidcCore | undefined;
	return createMiddleware({ type: "request" }).server(
		async ({ request, next, context }) => {
			if ("core" in setup) core ??= setup.core();
			else {
				const { createOidcCore } = await import("@lpshanley/oidc-start-core");
				core ??= createOidcCore(setup);
			}
			const call = callContext(context);
			const { cookies, session, setCookies, status, reason } = await core.resolve(
				request,
				call,
			);
			let sessionUpdates = setCookies;
			const appended: string[] = [];
			const oidc: OidcContext = {
				core,
				request,
				cookies,
				session,
				call,
				auth: () => ({ user: session?.user ?? null, status, reason }),
				appendSetCookie: (line) => appended.push(line),
				discardSessionUpdates: () => { sessionUpdates = []; },
			};
			const result = await next({ context: { oidc } });
			const pending = [...sessionUpdates, ...appended];
			if (pending.length) {
				// Start must receive its original response to serialize RPC redirects.
				const { appendResponseHeader } = await import("@tanstack/react-start/server");
				appendResponseHeader("Set-Cookie", pending);
			}
			return result;
		},
	);
}
