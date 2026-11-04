import { afterEach, expect, test, vi } from "vitest";
import { parseCookies } from "./cookies.js";
import { createOidcCore } from "./core.js";
import { isAuthorizationDenied } from "./provider.js";
import { OidcStateError } from "./state.js";

afterEach(() => vi.unstubAllGlobals());

test.each(["session", "grant"])("%s callback verifies browser state before returning a provider denial", async (purpose) => {
	const issuer = "https://idp.test";
	const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(Response.json({
		issuer,
		authorization_endpoint: issuer + "/authorize",
		token_endpoint: issuer + "/token",
		jwks_uri: issuer + "/keys",
	}));
	vi.stubGlobal("fetch", fetch);
	const auth = createOidcCore({
		environment: () => ({
			OIDC_ISSUER: issuer, OIDC_CLIENT_ID: "app", OIDC_CLIENT_SECRET: "client-secret",
			SESSION_SECRET: "test-only-session-secret-at-least-32-characters",
		}),
		allowSession: () => true,
		registry: { isActive: vi.fn(), register: vi.fn(), end: vi.fn(), endAll: vi.fn(), applyLogout: vi.fn() },
	});
	const request = new Request("https://app.test/");
	const begin = purpose === "session" ? auth.signIn : auth.startGrant;
	const finish = purpose === "session" ? auth.callback : auth.finishGrant;
	const start = await begin(request, new Map(), "/");
	const authorization = new URL(start.url).searchParams;
	const callback = new URL(authorization.get("redirect_uri")!);
	callback.searchParams.set("state", authorization.get("state")!);
	callback.searchParams.set("error", "access_denied");
	const verifier = parseCookies(start.setCookies[0].split(";")[0]);

	const unbound = await finish(new Request(callback), new Map());
	expect(unbound).toMatchObject({ ok: false, reason: "sign_in_expired", error: expect.any(OidcStateError) });

	const denied = await finish(new Request(callback), verifier);
	expect(denied).toMatchObject({ ok: false, reason: "access_denied" });
	expect(!denied.ok && isAuthorizationDenied(denied.error)).toBe(true);
	const [verifierName] = verifier.keys();
	expect(denied.setCookies).toEqual([expect.stringContaining(verifierName + "=; Max-Age=0")]);

	callback.searchParams.set("error", "login_required");
	const other = await finish(new Request(callback), verifier);
	expect(other).toMatchObject({ ok: false, reason: "provider_error", error: { error: "login_required" } });
	expect(!other.ok && isAuthorizationDenied(other.error)).toBe(false);
	expect(fetch).toHaveBeenCalledTimes(1); // Discovery only. A denial never exchanges tokens.
});
