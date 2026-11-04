export async function completeProviderSignIn(page, login) {
	await page.getByPlaceholder("Enter any login").fill(login);
	await page.locator('input[name="password"]').fill("local-test-only");
	await page.getByRole("button", { name: "Sign-in", exact: true }).click();
	await page.getByRole("button", { name: "Continue", exact: true }).click();
}
