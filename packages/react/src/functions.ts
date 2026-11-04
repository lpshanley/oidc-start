import { createServerFn } from "@tanstack/react-start";
import { redirect } from "@tanstack/react-router";
import { z } from "zod";
import { sanitizeReturnPath, signInOptionsSchema } from "@lpshanley/oidc-start-core/models";

// Server functions after WorkOS's server-functions.ts; bodies load lazily so
// server code stays out of the client bundle.

/** The signed-in user, or null. Never returns tokens. */
export const getAuth = createServerFn({ method: "GET" }).handler(async () => {
	const { getAuthBody } = await import("./functions.server.js");
	return getAuthBody();
});

type GuardOptions = {
	/** App-local GET endpoint mounted with handleSignInRoute(). */
	signInPath: string;
	/** App-local destination to resume after the callback. */
	returnPathname: string;
};

function redirectToSignIn({ signInPath, returnPathname }: GuardOptions): never {
	const url = new URL(sanitizeReturnPath(signInPath), "https://sign-in.invalid");
	url.searchParams.set("returnPathname", sanitizeReturnPath(returnPathname));
	throw redirect({ href: url.pathname + url.search + url.hash, reloadDocument: true });
}

/** Guard route navigation and supply a signed-in user to descendant routes. */
export async function requireAuth(options: GuardOptions) {
	const { user } = await getAuth();
	if (!user) redirectToSignIn(options);
	return { user };
}

/** An authorization URL; also queues the flow's verifier cookie. */
export const getSignInUrl = createServerFn({ method: "GET" })
	.validator(signInOptionsSchema.optional())
	.handler(async ({ data }) => {
		const { getSignInUrlBody } = await import("./functions.server.js");
		return getSignInUrlBody(data);
	});

/** Clears the session and redirects to provider logout. In a component, call via useServerFn. */
export const signOut = createServerFn({ method: "POST" })
	.validator(z.object({ everywhere: z.boolean().optional() }).optional())
	.handler(async ({ data }) => {
		const { signOutBody } = await import("./functions.server.js");
		return signOutBody(data?.everywhere);
	});
