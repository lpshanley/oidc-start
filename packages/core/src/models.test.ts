import { expect, test } from "vitest";
import { authServiceOptionsSchema } from "./config.js";
import {
	authLogoutResultSchema,
	authSessionSchema,
	displayName,
	isAuthUser,
	sanitizeReturnPath,
} from "./models.js";

test("the user guard validates the complete public identity before display helpers use it", () => {
	for (const name of [undefined, 42, {}, []]) {
		expect(isAuthUser({ sub: "alice", email: "alice@test", name })).toBe(false);
	}
	const user = { sub: "alice", email: "alice@test", name: null };
	expect(isAuthUser(user)).toBe(true);
	expect(displayName(user)).toBe("alice@test");
	expect(authSessionSchema.parse({ user: null })).toEqual({ user: null });
	expect(
		authSessionSchema.safeParse({ user: { ...user, sub: "" } }).success,
	).toBe(false);
});

test("canonical auth options retain defaults and public logout results validate redirect URLs", () => {
	expect(authServiceOptionsSchema.parse({})).toEqual({
		cookiePrefix: "oidc",
		sessionMaxAgeSeconds: 60 * 60 * 24 * 14,
		sessionIdleSeconds: 60 * 60 * 12,
		callbackPath: "/api/auth/callback",
		grantCallbackPath: "/api/auth/grant-callback",
		postLogoutPath: "/login",
		providerTimeoutMs: 5_000,
	});
	expect(authLogoutResultSchema.parse({ endSessionUrl: null })).toEqual({
		endSessionUrl: null,
	});
	expect(authLogoutResultSchema.safeParse({ endSessionUrl: 42 }).success).toBe(
		false,
	);
});

test.each([
	"/a/..//elsewhere.test/",
	"/a/%2e%2e//elsewhere.test/",
	"/a/%2E%2E//elsewhere.test/",
	"/a/.%2e//elsewhere.test/",
	"/a/%2e.//elsewhere.test/",
	"/a/b/../..//elsewhere.test/?from=chat#reply",
	"/a/..///elsewhere.test/",
])("normalized return path %s cannot produce an external Location header", (path) => {
	expect(sanitizeReturnPath(path)).toBe("/");
});

test("local return paths preserve queries, fragments and safe path normalization", () => {
	expect(sanitizeReturnPath("/settings/../c/chat?from=settings#reply")).toBe(
		"/c/chat?from=settings#reply",
	);
	expect(sanitizeReturnPath("/settings//voice?from=chat#preview")).toBe(
		"/settings//voice?from=chat#preview",
	);
});

test("the user picture is optional, http(s) only, and never invalidates a session", () => {
	const user = { sub: "alice", email: "alice@test", name: null };

	expect(authSessionSchema.parse({ user }).user?.picture).toBeUndefined();
	expect(
		authSessionSchema.parse({
			user: { ...user, picture: "https://cdn.test/a.png" },
		}).user?.picture,
	).toBe("https://cdn.test/a.png");
	expect(
		authSessionSchema.parse({
			user: { ...user, picture: "javascript:alert(1)" },
		}).user?.picture,
	).toBeUndefined();
});
