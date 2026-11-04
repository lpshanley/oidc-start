import type { SignOutOptions } from "@lpshanley/oidc-start-core/models";
import { getOidcContext } from "./context.js";

export async function endSession(options: SignOutOptions = {}): Promise<string | Response> {
	const context = getOidcContext();
	// A failed revocation must leave the incoming cookie available for retry.
	// A successful sign-out supplies all deletions for that same incoming jar.
	context.discardSessionUpdates?.();
	let result;
	try {
		result = await context.core.signOut(
			context.request, context.cookies, context.session, context.call, options,
		);
	} catch (error) {
		context.core.report({ operation: "end-session", error, context: context.call });
		return new Response("Sign-out could not be recorded. Try again.", {
			status: 503,
			headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" },
		});
	}
	for (const line of result.setCookies) context.appendSetCookie(line);
	return result.location;
}
