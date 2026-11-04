import { expect, test } from "@playwright/test";
import { completeProviderSignIn } from "./sign-in.mjs";

test("the signOut RPC navigates the document through provider logout", async ({ page, context, baseURL }) => {
	await context.route((url) => !["localhost", "127.0.0.1"].includes(url.hostname), (route) => route.abort());
	const signIn = page.getByRole("button", { name: "Sign in", exact: true });
	const identity = page.getByText("Signed in as Round Trip Tester.", { exact: true });
	// The SSR button is visible while Vite is still loading the client entry.
	await page.goto("/", { waitUntil: "networkidle" });
	await signIn.click();
	await completeProviderSignIn(page, "tester");
	await expect(identity).toBeVisible();
	// The root loader supplies the account on the first render, before hydration.
	const ssr = await page.request.get("/");
	expect(await ssr.text()).toContain("Round Trip Tester");
	const account = await page.request.get("/account", { maxRedirects: 0 });
	expect(account.status()).toBe(200);
	expect(await account.text()).toContain("Account for");
	await page.reload({ waitUntil: "networkidle" });
	await expect(identity).toBeVisible();
	const sessionCookies = async () => (await context.cookies(baseURL)).filter((c) => c.name.includes("example_session"));
	const original = await sessionCookies();
	expect(original.length).toBeGreaterThan(0);

	await page.getByRole("button", { name: "Sign out", exact: true }).click();
	await expect(page).toHaveURL((url) => url.origin === "http://localhost:19867" && url.pathname === "/session/end");
	await page.getByRole("button", { name: "Yes, sign me out" }).click();
	await expect(page).toHaveURL(baseURL + "/");
	await page.reload();
	await expect(signIn).toBeVisible();
	expect(await sessionCookies()).toHaveLength(0);
	await context.addCookies(original);
	await page.reload();
	await expect(signIn).toBeVisible();
});
