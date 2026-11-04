import { expect, test } from "@playwright/test";
import { completeProviderSignIn } from "./sign-in.mjs";

test("a guest signs in and returns to the admin route with the admin role", async ({ page, baseURL }) => {
	await page.goto("/admin?tab=overview");
	await completeProviderSignIn(page, "test-admin");
	await expect(page).toHaveURL(baseURL + "/admin?tab=overview");
	await expect(page.getByRole("heading", { name: "Admin dashboard" })).toBeVisible();
});

test("a signed-in member is sent to a forbidden page", async ({ page, baseURL }) => {
	await page.goto("/admin");
	await completeProviderSignIn(page, "test-member");
	await expect(page).toHaveURL(baseURL + "/forbidden");
	await expect(page.getByText("You need the admin role to view this page.")).toBeVisible();
	const response = await page.request.get("/admin");
	expect(response.status()).toBe(403);
	expect(response.url()).toBe(baseURL + "/forbidden");
});
