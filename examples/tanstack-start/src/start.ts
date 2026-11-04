import { oidcMiddleware } from "@lpshanley/oidc-start-react";
import { createServerOnlyFn, createStart } from "@tanstack/react-start";
import { auth } from "./auth.server";

const middleware = oidcMiddleware({ core: createServerOnlyFn(() => auth) });

export const startInstance = createStart(() => ({
	requestMiddleware: [middleware],
}));
