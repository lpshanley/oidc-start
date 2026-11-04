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
	assert.equal(response.status, 400);
	assert.match(await response.text(), /Restart sign-in/);
});
