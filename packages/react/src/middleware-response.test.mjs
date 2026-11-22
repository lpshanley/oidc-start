import { expect, test } from "vitest";
import { createServerEntry } from "@tanstack/react-start/server";
import { createMemorySessionRegistry } from "@lpshanley/oidc-start-core";
import { oidcMiddleware } from "./middleware.ts";

test("a downstream error response carries pending session updates", async () => {
	const middleware = oidcMiddleware({
		registry: createMemorySessionRegistry(),
		environment: () => ({ SESSION_SECRET: "test-session-secret-at-least-32-characters" }),
	});
	const app = createServerEntry({
		fetch: (request) => middleware.options.server({
			request, context: {},
			next: async () => { throw Object.assign(new Error("route failed"), { status: 500 }); },
		}),
	});
	const response = await app.fetch(new Request("http://app.test/", { headers: { cookie: "oidc_session=invalid" } }));
	expect(response.status).toBe(500);
	expect(response.headers.getSetCookie()).toEqual(["oidc_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax"]);
});
