import { expect, test } from "@playwright/test";

test("dismissing a callback error preserves the rest of the URL and replaces the history entry", async ({ page, baseURL }) => {
	await page.goto("/");
	await page.goto("/login?tab=account&auth_error=sign_in_expired#retry", { waitUntil: "networkidle" });
	const alert = page.getByRole("alert");
	await expect(alert).toHaveText("Your sign-in request expired. Please start again.");
	await page.getByRole("button", { name: "Dismiss" }).click();
	await expect(page).toHaveURL(baseURL + "/login?tab=account#retry");
	await expect(alert).toHaveCount(0);
	await page.goBack();
	await expect(page).toHaveURL(baseURL + "/");
});
