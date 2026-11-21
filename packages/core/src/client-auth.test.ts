import { afterEach, expect, test, vi } from "vitest";
import { createOidcCore, createMemorySessionRegistry } from "./index.js";

const basic = "client_secret_basic";
const post = "client_secret_post";
type Method = typeof basic | typeof post;

function provider(registered: Method, advertised?: Method[], configured?: Method) {
	const issuer = "https://issuer.test";
	vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
		if (url === issuer + "/.well-known/openid-configuration") return Response.json({
			issuer, token_endpoint: issuer + "/token",
			...(advertised && { token_endpoint_auth_methods_supported: advertised }),
		});
		expect(url).toBe(issuer + "/token");
		const form = new URLSearchParams(String(init.body));
		const authorization = new Headers(init.headers).get("authorization");
		const accepted = registered === basic
			? authorization === "Basic " + btoa("app:secret") && !form.has("client_secret")
			: !authorization && form.get("client_id") === "app" && form.get("client_secret") === "secret";
		if (!accepted) return Response.json({ error: "invalid_client" }, { status: 401 });
		return Response.json({ access_token: "renewed", token_type: "Bearer", expires_in: 300 });
	}));
	return createOidcCore({
		registry: createMemorySessionRegistry(),
		environment: () => ({ OIDC_ISSUER: issuer, OIDC_CLIENT_ID: "app", OIDC_CLIENT_SECRET: "secret",
			OIDC_TOKEN_ENDPOINT_AUTH_METHOD: configured }),
	});
}

afterEach(() => vi.unstubAllGlobals());

test.each<{ registered: Method; advertised?: Method[]; configured?: Method }>([
	{ registered: basic },
	{ registered: basic, advertised: [basic] },
	{ registered: basic, advertised: [post, basic], configured: basic },
	{ registered: post, advertised: [basic, post], configured: post },
	{ registered: post, advertised: [basic, post] },
])("authenticates the registered client ($registered, advertised $advertised, configured $configured)", async ({ registered, advertised, configured }) => {
	const auth = provider(registered, advertised, configured);
	expect(await auth.refreshGrant("fixture")).toMatchObject({ status: "refreshed", tokens: { accessToken: "renewed" } });
});

test("a registration that conflicts with discovery never sends credentials", async () => {
	const auth = provider(basic, [post], basic);
	await expect(auth.refreshGrant("fixture")).rejects.toThrow();
	expect(vi.mocked(fetch).mock.calls.map(([url]) => String(url))).toEqual([
		"https://issuer.test/.well-known/openid-configuration",
	]);
});
