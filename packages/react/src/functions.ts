import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { signInOptionsSchema } from "@lpshanley/oidc-start-core/models";

// Server functions after WorkOS's server-functions.ts; bodies load lazily so
// server code stays out of the client bundle.

/** The signed-in user, or null. Never returns tokens. */
export const getAuth = createServerFn({ method: "GET" }).handler(async () => {
	const { getAuthBody } = await import("./functions.server.js");
	return getAuthBody();
});

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
