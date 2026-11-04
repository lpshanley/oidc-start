import assert from "node:assert/strict";
import test from "node:test";
import app from "./dist/server/server.js";

test("rejects a sibling-origin form before dispatching any server function", async () => {
	const response = await app.fetch(new Request("https://app.example.test/_serverFn/probe", {
		method: "POST",
		headers: { Origin: "https://sibling.example.test", "Sec-Fetch-Site": "same-site" },
		body: new URLSearchParams(),
	}));
	assert.equal(response.status, 403);
	assert.deepEqual(response.headers.getSetCookie(), []);
});

test("lets the provider redirect reach the callback without an Origin header", async () => {
	const response = await app.fetch(new Request("https://app.example.test/callback"));
	assert.equal(response.status, 303);
	assert.equal(response.headers.get("location"), "/login?auth_error=invalid_callback");
});

test("protected navigation redirects a guest locally without starting a provider flow", async () => {
	const request = new Request("https://app.example.test/account?tab=profile");
	const response = await app.fetch(request);
	assert.ok(response.status >= 300 && response.status < 400);
	const location = new URL(response.headers.get("location"), request.url);
	assert.equal(location.origin + location.pathname, "https://app.example.test/sign-in");
	assert.equal(location.searchParams.get("returnPathname"), "/account?tab=profile");
	assert.deepEqual(response.headers.getSetCookie(), []);
});

test("the recent-auth guard carries the requested login age into sign-in", async () => {
	const request = new Request("https://app.example.test/settings");
	const response = await app.fetch(request);
	assert.ok(response.status >= 300 && response.status < 400);
	const location = new URL(response.headers.get("location"), request.url);
	assert.equal(location.pathname, "/sign-in");
	assert.equal(location.searchParams.get("maxAge"), "300");
	assert.equal(location.searchParams.get("returnPathname"), "/settings");
	assert.deepEqual(response.headers.getSetCookie(), []);
});
