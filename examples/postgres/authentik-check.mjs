// Opt-in integration check. Use only the disposable provider described in docs/authentik.md.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import pg from "pg";
import { createOidcCore } from "@lpshanley/oidc-start-core";
import { createPostgresStore } from "./store.mjs";
const { chromium } = createRequire(new URL("../tanstack-start/package.json", import.meta.url))("@playwright/test");
const origin = "http://127.0.0.1:19872";
const env = {
  OIDC_ISSUER: "http://localhost:19871/application/o/oidc-start-050/",
  OIDC_CLIENT_ID: "oidc-start-050", OIDC_CLIENT_SECRET: "oidc-fixture-only",
  SESSION_SECRET: randomBytes(32).toString("hex"), APP_ORIGIN: origin,
  OIDC_ROLES_CLAIM: "groups",
};
const connectionString = process.env.TEST_DATABASE_URL;
assert.ok(connectionString, "Set TEST_DATABASE_URL to a disposable database");
const admin = new pg.Pool({ connectionString });
const schema = "authentik_test_" + randomUUID().replaceAll("-", "");
const pools = [0, 1].map(() => new pg.Pool({ connectionString, options: "-c search_path=" + schema, statement_timeout: 5000 }));
await admin.query("CREATE SCHEMA " + schema);
await pools[0].query(await readFile(new URL("./schema.sql", import.meta.url), "utf8"));
const cores = pools.map(pool => createOidcCore({ ...createPostgresStore(pool, "authentik"),
  environment: () => env, cookiePrefix: "fixture", callbackPath: "/callback", postLogoutPath: "/",
  onError: event => console.error(JSON.stringify({ operation: event.operation, reason: event.reason })),
}));
let turn = 0;
const notifications = [];
const seen = [];
const server = createServer(async (req, res) => {
  try {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const request = new Request(origin + req.url, { method: req.method, headers: req.headers,
      ...(req.method !== "GET" && req.method !== "HEAD" ? { body: Buffer.concat(chunks) } : {}) });
    const path = new URL(request.url).pathname;
    const core = cores[path === "/backchannel-logout" ? 1 : turn++ % 2];
    const result = await core.resolve(request);
    const reply = (status, body, cookies = [], location) => {
      res.writeHead(status, { "Content-Type": "text/html", "Cache-Control": "no-store", "Set-Cookie": cookies,
        ...(location ? { Location: location } : {}) }); res.end(body);
    };
    if (path === "/backchannel-logout") {
      const body = await request.clone().text();
      const logout = await core.backchannelLogout(request);
      notifications.push({ body, status: logout.status });
      return reply(logout.status, "");
    }
    if (path === "/callback") {
      const callback = await core.callback(request, result.cookies);
      if (!callback.ok) console.error("callback category", new URL(request.url).searchParams.get("error") ?? callback.reason);
      return reply(callback.ok ? 303 : 400, callback.ok ? "" : callback.reason, callback.setCookies, callback.ok ? callback.location : undefined);
    }
    if (path === "/login" || (path === "/protected" && result.status === "anonymous")) {
      const login = await core.signIn(request, result.cookies, { returnPathname: "/protected" });
      return reply(303, "", login.setCookies, login.url);
    }
    if (path === "/logout" && req.method === "POST") {
      if (req.headers.origin !== origin) return reply(403, "Forbidden");
      const logout = await core.signOut(request, result.cookies, result.session);
      return reply(303, "", logout.setCookies, logout.location);
    }
    if (result.session) seen.push(result.session);
    reply(200, `<h1>${result.status}</h1><form method="post" action="/logout"><button>Sign out</button></form>`, result.setCookies);
  } catch (error) { console.error(error.name); res.writeHead(500); res.end("Fixture failure"); }
});
await new Promise(resolve => server.listen(19872, "0.0.0.0", resolve));
const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();
page.setDefaultTimeout(15_000);
page.setDefaultNavigationTimeout(15_000);
async function waitFor(check, label) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error("Timed out: " + label);
}
async function finishLogin(first) {
  if (first) {
    await page.locator('input[name="uidField"]').fill("oidc-user");
    await page.getByRole("button", { name: "Log in", exact: true }).click();
    await page.getByRole("button", { name: "Continue", exact: true }).waitFor();
    await page.locator('input[name="password"]').fill("oidc-fixture-only");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
  }
  await waitFor(async () => {
    if (page.url().startsWith(origin)) return true;
    const consent = page.getByRole("button", { name: "Continue", exact: true });
    if (await consent.isVisible()) await consent.click({ timeout: 300 }).catch(() => {});
    return false;
  }, "provider login/consent");
  assert.equal(await page.locator("h1").textContent(), "authenticated");
}
try {
  await page.goto(origin + "/protected");
  await finishLogin(true);
  const originalCookies = await context.cookies(origin);
  const originalSession = seen.at(-1);
  assert.ok(originalSession.idpSid);
  // Both instances consume the same session and durable registry.
  await page.reload(); await page.reload();
  assert.equal(seen.at(-1).sid, originalSession.sid);
  const currentCookies = await context.cookies(origin);
  const cookie = currentCookies.map(c => c.name + "=" + c.value).join("; ");
  const rotated = await Promise.all(cores.map(core => core.resolve(new Request(origin, { headers: { cookie } }))));
  assert.ok(rotated.every(result => result.status === "authenticated"));
  assert.equal(rotated[0].session.refreshToken, rotated[1].session.refreshToken);
  assert.equal(rotated[0].session.accessToken, rotated[1].session.accessToken);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await waitFor(() => notifications.length > 0, "real Authentik back-channel delivery");
  assert.equal(notifications[0].status, 200);
  await page.getByRole("heading", { name: "You've logged out of OIDC 0.5 fixture." }).waitFor();
  // The default flow displays its logout page and retains SSO. Return as a user would.
  await page.goto(origin + "/");
  assert.equal(await page.locator("h1").textContent(), "anonymous");
  await context.addCookies(originalCookies); await page.reload();
  assert.equal(await page.locator("h1").textContent(), "anonymous");
  await page.goto(origin + "/protected"); await finishLogin(false);
  const current = seen.at(-1);
  assert.notEqual(current.sid, originalSession.sid);
  assert.equal(current.idpSid, originalSession.idpSid, "default provider invalidation keeps the Authentik SSO sid");
  const duplicate = await fetch(origin + "/backchannel-logout", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: notifications[0].body });
  assert.equal(duplicate.status, 200);
  await page.reload();
  assert.equal(await page.locator("h1").textContent(), "authenticated");
  console.log(JSON.stringify({ provider: "Authentik 2026.8.5", instances: 2, checks: ["automatic sign-in", "consent prompt", "shared rotating refresh", "provider notification", "old-cookie rejection", "stable provider sid re-login", "duplicate notification preserves new session"], passed: true }));
} catch (error) {
  // Text only, no URLs, cookies, provider errors, or token-bearing traces.
  console.error("Fixture path:", new URL(page.url()).pathname, "headings:", await page.getByRole("heading").allTextContents());
  await page.screenshot({ path: "/private/tmp/authentik-fixture.png" });
  throw new Error("Authentik fixture check failed: " + error.name);
} finally {
  await browser.close(); await new Promise(resolve => server.close(resolve));
  await Promise.all(pools.map(pool => pool.end()));
  await admin.query("DROP SCHEMA " + schema + " CASCADE"); await admin.end();
}
