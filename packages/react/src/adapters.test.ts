import { beforeEach, describe, expect, test, vi } from "vitest";
import type { OidcContext } from "./context.js";

const start = vi.hoisted(() => ({
	server: undefined as
		| undefined
		| ((args: {
				request: Request;
				context?: unknown;
				next: (o: unknown) => Promise<unknown>;
		  }) => Promise<unknown>),
	context: undefined as OidcContext | undefined,
}));
vi.mock("@tanstack/react-start", () => ({
	createMiddleware: () => ({
		server: (fn: typeof start.server) => {
			start.server = fn;
			return {};
		},
	}),
	getGlobalStartContext: () => ({ oidc: start.context }),
}));
const core = {
	resolve: vi.fn(),
	report: vi.fn(),
};
const createOidcCore = vi.fn(() => core);
vi.mock("@lpshanley/oidc-start-core", () => ({
	createOidcCore,
	SessionAccessDeniedError: class SessionAccessDeniedError extends Error {},
}));

const { oidcMiddleware } = await import("./middleware.js");

const alice = { sub: "alice", email: "alice@sage.test", name: "Alice" };

beforeEach(() => {
	start.context = undefined;
});

describe("oidcMiddleware", () => {
	test("exposes the session and appends refreshed and queued cookies", async () => {
		oidcMiddleware({ core: () => core as unknown as OidcContext["core"] });
		core.resolve.mockResolvedValue({
			cookies: new Map([["a", "1"]]),
			session: { user: alice },
			setCookies: ["sage_session=refreshed"],
		});
		const request = new Request("https://sage.test/");

		const result = (await start.server?.({
			request,
			context: { requestContext: { correlationId: "req-1", deadline: 5 } },
			next: async (options) => {
				const { oidc } = (options as { context: { oidc: OidcContext } })
					.context;
				expect(oidc.auth()).toEqual({ user: alice });
				expect(oidc.request).toBe(request);
				expect(oidc.call).toEqual({ correlationId: "req-1", deadline: 5 });
				oidc.appendSetCookie("sage-verifier-1=x");
				return {
					request,
					response: new Response("ok", {
						status: 201,
						headers: { "x-kept": "1" },
					}),
				};
			},
		})) as { response: Response };

		expect(core.resolve).toHaveBeenCalledWith(request, {
			correlationId: "req-1",
			deadline: 5,
		});
		expect(result.response.status).toBe(201);
		expect(result.response.headers.get("x-kept")).toBe("1");
		expect(result.response.headers.getSetCookie()).toEqual([
			"sage_session=refreshed",
			"sage-verifier-1=x",
		]);
		expect(await result.response.text()).toBe("ok");
	});

	test("uses a core composed by the app", async () => {
		createOidcCore.mockClear();
		const composed = { ...core };
		oidcMiddleware({
			core: (context) =>
				(context as { composed: OidcContext["core"] }).composed,
		});
		composed.resolve = vi.fn().mockResolvedValue({
			cookies: new Map(),
			session: null,
			setCookies: [],
		});

		await start.server?.({
			request: new Request("https://sage.test/"),
			context: { composed },
			next: async () => ({ response: new Response("ok") }),
		});

		expect(composed.resolve).toHaveBeenCalledOnce();
		expect(createOidcCore).not.toHaveBeenCalled();
	});

	test("passes the response through untouched with nothing queued", async () => {
		oidcMiddleware({ core: () => core as unknown as OidcContext["core"] });
		core.resolve.mockResolvedValue({
			cookies: new Map(),
			session: null,
			setCookies: [],
		});
		const response = new Response("ok");

		const result = (await start.server?.({
			request: new Request("https://sage.test/"),
			next: async () => ({ response }),
		})) as { response: Response };

		expect(result.response).toBe(response);
	});
});

describe("getOidcContext", () => {
	test("explains a missing middleware", async () => {
		const { getOidcContext } = await import("./context.js");

		expect(getOidcContext).toThrow("Add oidcMiddleware()");
	});
});
