import { expect, test } from "@playwright/test";

test("the sign-in RPC is an uncacheable same-origin POST that sets the verifier cookie", async ({ page, baseURL }) => {
	await page.goto("/login");
	await page.waitForLoadState("networkidle");
	const [request] = await Promise.all([
		page.waitForRequest(req => req.url().includes("/_serverFn/")),
		page.getByRole("button", { name: "Sign in", exact: true }).click(),
	]);
	const response = await request.response();

	expect(request.method()).toBe("POST");
	expect(response.status()).toBe(200);
	expect(response.headers()["cache-control"]).toContain("no-store");
	const cookies = (await response.headersArray()).filter(h => h.name.toLowerCase() === "set-cookie");
	expect(cookies.length).toBeGreaterThan(0);
	expect(cookies.every(h => /HttpOnly/i.test(h.value))).toBe(true);
	await page.waitForURL(/\/authorize|\/application|:19867/);

	// Replaying the call from another origin is refused before any flow starts.
	const replay = headers => page.request.post(request.url(), { headers: { ...request.headers(), ...headers }, data: request.postDataBuffer() });
	const forged = await replay({ origin: "https://evil.example", "sec-fetch-site": "cross-site" });
	expect(forged.status()).toBe(403);
	expect((await forged.headersArray()).filter(h => h.name.toLowerCase() === "set-cookie")).toEqual([]);

	// The click above is the accepted same-origin case.
});
