import { oidcMiddleware } from "@lpshanley/oidc-start-react";
import { createCsrfMiddleware, createServerOnlyFn, createStart } from "@tanstack/react-start";
import { auth } from "./auth.server";

const csrf = createCsrfMiddleware({ filter: (ctx) => ctx.handlerType === "serverFn" });
const middleware = oidcMiddleware({ core: createServerOnlyFn(() => auth) });

export const startInstance = createStart(() => ({
	requestMiddleware: [csrf, middleware],
}));
