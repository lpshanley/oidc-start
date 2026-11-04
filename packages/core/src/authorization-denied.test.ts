import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { AuthorizationResponseError } from "openid-client";
import { expect, test } from "vitest";
import { isAuthorizationDenied } from "./provider.js";

test("recognizes access_denied from another instance of the OAuth library", async () => {
	// openid-client re-exports this class. A second ESM URL gives it a distinct constructor.
	const requireFromClient = createRequire(import.meta.resolve("openid-client"));
	const moduleUrl = pathToFileURL(requireFromClient.resolve("oauth4webapi"));
	moduleUrl.search = "consumer-bundle";
	const consumer = await import(moduleUrl.href);
	const error = new consumer.AuthorizationResponseError("Authorization failed", {
		cause: new URLSearchParams({ error: "access_denied" }),
	});

	expect(error).not.toBeInstanceOf(AuthorizationResponseError);
	expect(isAuthorizationDenied(error)).toBe(true);
});

test.each([
	new AuthorizationResponseError("Login required", { cause: new URLSearchParams({ error: "login_required" }) }),
	new DOMException("The provider timed out", "TimeoutError"),
	{ code: "OAUTH_RESPONSE_BODY_ERROR", error: "access_denied" },
	{ error: "access_denied" },
	null,
	"access_denied",
])("does not classify other failures as a consent denial (%#)", (error) => {
	expect(isAuthorizationDenied(error)).toBe(false);
});
