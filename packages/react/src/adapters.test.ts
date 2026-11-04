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
	setResponseHeader: vi.fn(),
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
vi.mock("@tanstack/react-start/server", () => ({
	setResponseHeader: start.setResponseHeader,
}));

const core = {
	resolve: vi.fn(),
	signIn: vi.fn(),
	callback: vi.fn(),
	signOut: vi.fn(),
	report: vi.fn(),
};
const createOidcCore = vi.fn(() => core);
vi.mock("@lpshanley/oidc-start-core", () => ({
	createOidcCore,
	SessionAccessDeniedError: class SessionAccessDeniedError extends Error {},
}));

const { oidcMiddleware } = await import("./middleware.js");
const routes = await import("./routes.server.js");
const functions = await import("./functions.server.js");

const alice = { sub: "alice", email: "alice@sage.test", name: "Alice" };

function context(overrides: Partial<OidcContext> = {}) {
	const appended: string[] = [];
	start.context = {
		core: core as unknown as OidcContext["core"],
		request: new Request("https://sage.test/"),
		cookies: new Map(),
		session: null,
		call: { correlationId: "req-1" },
		auth: () => ({ user: null }),
		appendSetCookie: (line) => appended.push(line),
		...overrides,
	};
	return appended;
}

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

describe("route handlers", () => {
	test("sign-in redirects to the provider and queues the verifier", async () => {
		const appended = context();
		core.signIn.mockResolvedValue({
			url: "https://idp.test/authorize?x=1",
			setCookies: ["sage-verifier-1=x"],
		});

		const response = await routes.signInRoute(
			new Request("https://sage.test/api/auth/sign-in?returnPathname=%2Fp"),
			{},
		);

		expect(core.signIn).toHaveBeenCalledWith(
			expect.any(Request),
			expect.any(Map),
			"/p",
			{ correlationId: "req-1" },
		);
		expect(response.status).toBe(307);
		expect(response.headers.get("location")).toBe(
			"https://idp.test/authorize?x=1",
		);
		expect(appended).toEqual(["sage-verifier-1=x"]);
	});

	test("callback redirects on success and reports hidden failures", async () => {
		const appended = context();
		const request = new Request("https://sage.test/api/auth/callback?code=c");
		core.callback
			.mockResolvedValueOnce({
				ok: true,
				location: "https://sage.test/p",
				setCookies: ["s=1"],
			})
			.mockResolvedValueOnce({
				ok: false,
				error: new Error("secret detail"),
				setCookies: ["v=; Max-Age=0"],
			})
			.mockResolvedValueOnce({
				ok: false,
				error: new Error("secret detail"),
				setCookies: [],
			});

		const ok = await routes.callbackRoute(request, {});
		const redirected = await routes.callbackRoute(request, {
			errorRedirectUrl: "/login?error=1",
		});
		const plain = await routes.callbackRoute(request, {});

		expect([ok.status, ok.headers.get("location")]).toEqual([
			307,
			"https://sage.test/p",
		]);
		expect([redirected.status, redirected.headers.get("location")]).toEqual([
			303,
			"https://sage.test/login?error=1",
		]);
		expect(plain.status).toBe(400);
		expect(await plain.text()).not.toContain("secret detail");
		expect(core.report).toHaveBeenCalledTimes(2);
		expect(core.report).toHaveBeenCalledWith({
			operation: "callback",
			error: new Error("secret detail"),
			context: { correlationId: "req-1" },
		});
		expect(appended).toEqual(["s=1", "v=; Max-Age=0"]);
	});

	test("sign-out accepts only POST and redirects to the provider logout", async () => {
		const appended = context({
			session: { user: alice } as OidcContext["session"],
		});
		core.signOut.mockResolvedValue({
			location: "https://idp.test/logout",
			setCookies: ["s=; Max-Age=0"],
		});

		const get = await routes.signOutRoute(
			new Request("https://sage.test/logout"),
		);
		const post = await routes.signOutRoute(
			new Request("https://sage.test/logout", { method: "POST" }),
		);

		expect([get.status, get.headers.get("allow")]).toEqual([405, "POST"]);
		expect([post.status, post.headers.get("location")]).toEqual([
			303,
			"https://idp.test/logout",
		]);
		expect(core.signOut).toHaveBeenCalledWith(
			expect.any(Request),
			expect.any(Map),
			{ user: alice },
			{ correlationId: "req-1" },
			false,
		);
		expect(appended).toEqual(["s=; Max-Age=0"]);
	});
});

test("both sign-out entry points return 503 and preserve cookies when revocation fails", async () => {
	const appended = context();
	const failure = new Error("private database details");
	core.signOut.mockRejectedValueOnce(failure).mockRejectedValueOnce(failure);
	const req = new Request("https://sage.test/logout", { method: "POST" });
	const route = await routes.signOutRoute(req);
	const rpc = await functions.signOutBody().catch((error: unknown) => error);
	for (const response of [route, rpc]) {
		expect(response).toBeInstanceOf(Response);
		expect((response as Response).status).toBe(503);
		expect(await (response as Response).text()).toBe("Sign-out could not be recorded. Try again.");
	}
	expect(appended).toEqual([]);
});

describe("server function bodies", () => {
	test("getAuth returns only the user and is not cached", () => {
		context({ auth: () => ({ user: alice }) });

		expect(functions.getAuthBody()).toEqual({ user: alice });
		expect(start.setResponseHeader).toHaveBeenCalledWith(
			"Cache-Control",
			"no-store",
		);
	});

	test("signOut queues the cleared session and throws a document redirect", async () => {
		const appended = context();
		core.signOut.mockResolvedValue({
			location: "https://idp.test/logout",
			setCookies: ["s=; Max-Age=0"],
		});

		const thrown = await functions
			.signOutBody()
			.catch((error: unknown) => error);

		expect(appended).toEqual(["s=; Max-Age=0"]);
		expect(thrown).toMatchObject({
			options: { href: "https://idp.test/logout", reloadDocument: true },
		});
	});
});
