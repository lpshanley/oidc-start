import { createOidcCore, createMemorySessionRegistry } from "@lpshanley/oidc-start-react/server";

// Single-process development only. Deploy with the shared PostgreSQL example.
export const auth = createOidcCore({
	cookiePrefix: "example", callbackPath: "/callback", postLogoutPath: "/",
	registry: createMemorySessionRegistry(),
});
