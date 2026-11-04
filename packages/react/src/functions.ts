import { createServerFn } from "@tanstack/react-start";
import { redirect } from "@tanstack/react-router";
import { z } from "zod";
import { sanitizeReturnPath, signInOptionsSchema, signOutOptionsSchema } from "@lpshanley/oidc-start-core/models";

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

function redirectToSignIn({ signInPath, returnPathname }: GuardOptions, maxAge?: number): never {
	const url = new URL(sanitizeReturnPath(signInPath), "https://sign-in.invalid");
	url.searchParams.set("returnPathname", sanitizeReturnPath(returnPathname));
	if (maxAge !== undefined) url.searchParams.set("maxAge", String(maxAge));
	throw redirect({ href: url.pathname + url.search + url.hash, reloadDocument: true });
}

/** Guard route navigation and supply a signed-in user to descendant routes. */
export async function requireAuth(options: GuardOptions) {
	const { user } = await getAuth();
	if (!user) redirectToSignIn(options);
	return { user };
}

const getRecentAuth = createServerFn({ method: "GET" })
	.validator(z.object({ maxAge: z.int().nonnegative() }))
	.handler(async ({ data }) => {
		const { getRecentAuthBody } = await import("./functions.server.js");
		return getRecentAuthBody(data.maxAge);
	});

/** Guard navigation using the provider login time. Recheck inside sensitive actions. */
export async function requireRecentAuth(options: GuardOptions & { maxAge: number }) {
	const { user } = await getRecentAuth({ data: { maxAge: options.maxAge } });
	if (!user) redirectToSignIn(options, options.maxAge);
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
	.validator(signOutOptionsSchema.optional())
	.handler(async ({ data }) => {
		const { signOutBody } = await import("./functions.server.js");
		return signOutBody(data);
	});
