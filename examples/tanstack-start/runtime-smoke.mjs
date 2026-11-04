import assert from "node:assert/strict";
import { handleCallbackRoute, hasRole, oidcMiddleware } from "@lpshanley/oidc-start-react";
import { createOidcCore } from "@lpshanley/oidc-start-react/server";

const core = createOidcCore({
	environment: () => ({
		APP_ORIGIN: "https://app.example.test",
		OIDC_ISSUER: "https://issuer.example.test",
		OIDC_CLIENT_ID: "runtime-smoke",
		OIDC_CLIENT_SECRET: "fixture",
		SESSION_SECRET: "local-runtime-smoke-test-secret-32-chars",
	}),
	allowSession: user => hasRole(user, "member"),
	revocations: { isRevoked: async () => false },
});
core.assertConfigured();
assert.equal((await core.resolve(new Request("https://app.example.test/"))).session, null);
assert.equal(typeof oidcMiddleware, "function");
assert.equal(typeof handleCallbackRoute(), "function");

// Run in plain Node so an abandoned provider rejection also fails the process.
await assert.rejects(core.refreshGrant("fixture", { deadline: Date.now() - 1 }), {
	name: "OidcDeadlineError",
});
