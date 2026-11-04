import { beforeEach, describe, expect, test, vi } from "vitest";
import { redirect } from "@tanstack/react-router";
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
	setResponseStatus: vi.fn(),
	appendResponseHeader: vi.fn(),
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
	setResponseStatus: start.setResponseStatus,
	appendResponseHeader: start.appendResponseHeader,
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

const alice = { issuer: "https://idp.test/application/o/sage/", sub: "alice", email: "alice@sage.test", name: "Alice" };

function context(overrides: Partial<OidcContext> = {}) {
	const appended: string[] = [];
	start.context = {
		core: core as unknown as OidcContext["core"],
		request: new Request("https://sage.test/"),
		cookies: new Map(),
		session: null,
		call: { correlationId: "req-1" },
		auth: () => ({ status: "anonymous", user: null }),
		appendSetCookie: (line) => appended.push(line),
		...overrides,
	};
	return appended;
}

beforeEach(() => {
	start.context = undefined;
});

describe("oidcMiddleware", () => {
	test("preserves a router redirect while appending refreshed and queued cookies", async () => {
		oidcMiddleware({ core: () => core as unknown as OidcContext["core"] });
		core.resolve.mockResolvedValue({
			cookies: new Map([["a", "1"]]),
			session: { user: alice }, status: "authenticated",
			setCookies: ["sage_session=refreshed"],
		});
		const request = new Request("https://sage.test/");

		const response = redirect({ href: "https://idp.test/logout", reloadDocument: true });

		const result = (await start.server?.({
			request,
			context: { requestContext: { correlationId: "req-1", deadline: 5 } },
			next: async (options) => {
				const { oidc } = (options as { context: { oidc: OidcContext } })
					.context;
				expect(oidc.auth()).toEqual({ status: "authenticated", user: alice, reason: undefined });
				expect(oidc.request).toBe(request);
				expect(oidc.call).toEqual({ correlationId: "req-1", deadline: 5 });
				oidc.appendSetCookie("sage-verifier-1=x");
				return { request, response };
			},
		})) as { response: Response };

		expect(core.resolve).toHaveBeenCalledWith(request, {
			correlationId: "req-1",
			deadline: 5,
		});
		expect(result.response).toBe(response);
		expect(start.appendResponseHeader).toHaveBeenCalledWith("Set-Cookie", [
			"sage_session=refreshed",
			"sage-verifier-1=x",
		]);
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

	test("a successful account switch supersedes all writes for the old session", async () => {
		oidcMiddleware({ core: () => core as unknown as OidcContext["core"] });
		core.resolve.mockResolvedValueOnce({
			cookies: new Map([["s.0", "old-chunk"]]), session: { user: alice }, status: "authenticated",
			setCookies: ["s=alice", "s.0=; Max-Age=0"],
		});
		const newSession = ["s.0=bob-0", "s.1=bob-1", "v=; Max-Age=0"];
		core.callback.mockResolvedValueOnce({ ok: true, location: "https://sage.test/account", setCookies: newSession });
		const request = new Request("https://sage.test/callback");
		await start.server?.({ request, next: async (options) => {
			const { oidc } = (options as { context: { oidc: OidcContext } }).context;
			start.context = oidc;
			oidc.appendSetCookie("theme=dark");
			return routes.callbackRoute(request, {});
		} });
		expect(start.appendResponseHeader).toHaveBeenLastCalledWith("Set-Cookie", ["theme=dark", ...newSession]);
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
			{ prompt: "select_account" },
		);

		expect(core.signIn).toHaveBeenCalledWith(
			expect.any(Request),
			expect.any(Map),
			{ returnPathname: "/p", prompt: "select_account" },
			{ correlationId: "req-1" },
		);
		expect(response.status).toBe(307);
		expect(response.headers.get("location")).toBe(
			"https://idp.test/authorize?x=1",
		);
		expect(appended).toEqual(["sage-verifier-1=x"]);
	});

	test.each([[undefined, "300", 300], [60, "300", 60], [60, "0", 0]] as const)(
		"a sign-in link can tighten the route's maxAge (%s, %s)", async (configured, query, expected) => {
			context();
			core.signIn.mockResolvedValue({ url: "https://idp.test/authorize", setCookies: [] });
			const response = await routes.signInRoute(new Request("https://sage.test/sign-in?maxAge=" + query), { maxAge: configured });
			expect(response.status).toBe(307);
			expect(core.signIn.mock.lastCall?.[2].maxAge).toBe(expected);
		},
	);

	test("rejects invalid maxAge before starting sign-in", async () => {
		context();
		core.signIn.mockClear();
		const response = await routes.signInRoute(new Request("https://sage.test/sign-in?maxAge=-1"), {});
		expect(response.status).toBe(400);
		expect(core.signIn).not.toHaveBeenCalled();
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

	test("customizes callback failures after verifier cleanup and preserves host policy denial", async () => {
		const appended = context();
		const request = new Request("https://sage.test/callback");
		const onError = vi.fn(async () => new Response("Retry later", { status: 503 }));
		for (const reason of ["token_exchange_failed", "session_access_denied"]) {
			core.callback.mockResolvedValueOnce({ ok: false, reason, error: new Error(), setCookies: ["v=; Max-Age=0"] });
			const response = await routes.callbackRoute(request, { onError, errorRedirectUrl: "/fallback" });
			expect(response.status).toBe(reason === "session_access_denied" ? 403 : 503);
		}
		expect(onError).toHaveBeenCalledExactlyOnceWith({ reason: "token_exchange_failed", request });
		expect(appended).toEqual(["v=; Max-Age=0", "v=; Max-Age=0"]);
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
			{ everywhere: false },
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

test("recent auth uses the provider login time, including the boundary, and fails closed", async () => {
	const { checkRecentAuth } = await import("./server.js");
	vi.spyOn(Date, "now").mockReturnValue(1_000_000);
	try {
		context();
		expect(checkRecentAuth({ maxAge: 300 }).isStale).toBe(true);
		for (const [authTime, expected] of [[undefined, true], [699, true], [700, false], [1000, false], [1001, true]] as const) {
			context({ session: { issuedAt: 1000, authTime } as OidcContext["session"] });
			expect(checkRecentAuth({ maxAge: 300 }).isStale).toBe(expected);
		}
		expect(() => checkRecentAuth({ maxAge: NaN })).toThrow(RangeError);
	} finally {
		vi.restoreAllMocks();
	}
});

describe("server function bodies", () => {
	test("recent auth returns only a fresh user", () => {
		const authTime = Math.floor(Date.now() / 1000) - 60;
		context({ session: { authTime } as OidcContext["session"], auth: () => ({ status: "authenticated", user: alice }) });
		expect(functions.getRecentAuthBody(300)).toEqual({ user: alice });
		expect(functions.getRecentAuthBody(30)).toEqual({ user: null });
	});

	test("getAuth returns only the user and is not cached", () => {
		context({ auth: () => ({ status: "authenticated", user: alice }) });

		expect(functions.getAuthBody()).toEqual({ user: alice });
		expect(start.setResponseHeader).toHaveBeenCalledWith(
			"Cache-Control",
			"no-store",
		);
	});

	test.each([undefined, true])("signOut forwards everywhere=%s and follows provider logout", async (everywhere) => {
		const appended = context();
		core.signOut.mockResolvedValue({
			location: "https://idp.test/logout",
			setCookies: ["s=; Max-Age=0"],
		});

		const thrown = await functions
			.signOutBody({ everywhere })
			.catch((error: unknown) => error);

		expect(core.signOut.mock.lastCall?.[4]).toEqual({ everywhere });
		expect(appended).toEqual(["s=; Max-Age=0"]);
		expect(thrown).toMatchObject({
			options: { href: "https://idp.test/logout", reloadDocument: true },
		});
	});
});

test.each(["denied", "unavailable"] as const)("getAuth surfaces %s without pretending the user is signed out", async status => {
	context({ auth: () => ({ status, user: null, reason: status === "denied" ? "access_denied" : "registry_unavailable" }) });
	const response = await Promise.resolve().then(() => functions.getAuthBody()).catch((error: unknown) => error);
	expect(response).toBeInstanceOf(Error);
	expect((response as Response).status).toBe(status === "denied" ? 403 : 503);
	expect(start.setResponseStatus).toHaveBeenCalledWith(status === "denied" ? 403 : 503);
	expect(start.setResponseHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
});
