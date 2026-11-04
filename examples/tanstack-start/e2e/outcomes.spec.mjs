import { expect, test } from "@playwright/test";
import { completeProviderSignIn } from "./sign-in.mjs";

test.skip(process.env.OIDC_PACKED_FAULTS !== "1", "Requires the isolated packed-consumer fault fixture");
for (const [account, status] of [["denied-after-login", 403], ["store-down", 503]]) {
  test(`${account} returns ${status} without restarting sign-in or deleting its cookie`, async ({ page, context, baseURL }) => {
    await page.goto("/account");
    await completeProviderSignIn(page, account);
    await page.waitForURL(baseURL + "/account");
    const response = await page.request.get("/account", { maxRedirects: 0 });
    expect(response.status()).toBe(status);
    expect(response.headers()["location"]).toBeUndefined();
    expect(response.headers()["cache-control"]).toContain("no-store");
    expect(response.headersArray().filter(h => h.name.toLowerCase() === "set-cookie").some(h => h.value.includes("Max-Age=0"))).toBe(false);
    expect((await context.cookies(baseURL)).some(c => c.name.includes("example_session"))).toBe(true);
  });
}
