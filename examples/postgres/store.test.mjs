import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import pg from "pg";
import { RefreshNotDispatched } from "@lpshanley/oidc-start-core/provider";
import { createPostgresStore } from "./store.mjs";

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw new Error("Set TEST_DATABASE_URL to a disposable PostgreSQL database");
const admin = new pg.Pool({ connectionString });
const schema = "oidc_test_" + randomUUID().replaceAll("-", "");
const poolOptions = { connectionString, options: "-c search_path=" + schema, statement_timeout: 5000 };
const first = new pg.Pool(poolOptions), second = new pg.Pool(poolOptions);
const a = createPostgresStore(first, "example"), b = createPostgresStore(second, "example");
const now = Math.floor(Date.now() / 1000), scope = { issuer: "https://issuer.test", clientId: "client" };
before(async () => {
  await admin.query("CREATE SCHEMA " + schema);
  await first.query(await readFile(new URL("./schema.sql", import.meta.url), "utf8"));
});
after(async () => {
  await Promise.all([first.end(), second.end()]);
  await admin.query("DROP SCHEMA " + schema + " CASCADE");
  await admin.end();
});

test("logout ends existing sessions, deduplicates atomically, and permits later login", async () => {
  const session = { ...scope, sid: "old", sub: "alice", idpSid: "sso", expiresAt: now + 300 };
  const event = { ...scope, idpSid: "sso", sub: "alice", jti: "one", issuedAt: now, expiresAt: now + 300 };
  await a.registry.register(session);
  assert.equal(await b.registry.isActive(session), true);
  await Promise.all([a.registry.applyLogout(event), b.registry.applyLogout(event)]);
  assert.equal(await b.registry.isActive(session), false);
  const next = { ...session, sid: "new" };
  await b.registry.register(next);
  await a.registry.applyLogout(event);
  assert.equal(await a.registry.isActive(next), true);
  await b.registry.applyLogout({ ...event, jti: "delayed-distinct" });
  assert.equal(await a.registry.isActive(next), false);
});

test("scope isolation, subject matching and expiry do not depend on cleanup", async () => {
  const session = { ...scope, sid: "same-id", sub: "alice", idpSid: "same-sso", expiresAt: now + 300 };
  const foreignClient = { ...session, clientId: "other" }, foreignIssuer = { ...session, issuer: "https://other.test" };
  for (const s of [session, foreignClient, foreignIssuer]) await a.registry.register(s);
  await a.registry.applyLogout({ ...scope, sub: "bob", idpSid: "same-sso", jti: "wrong-subject", issuedAt: now, expiresAt: now + 300 });
  assert.equal(await b.registry.isActive(session), true);
  await a.registry.endAll({ ...scope, sub: "alice" });
  assert.equal(await b.registry.isActive(session), false);
  assert.equal(await b.registry.isActive(foreignClient), true);
  assert.equal(await b.registry.isActive(foreignIssuer), true);
  const expired = { ...session, sid: "expired", expiresAt: now - 1 };
  await a.registry.register(expired);
  assert.equal(await b.registry.isActive(expired), false);
  assert.equal(await createPostgresStore(second, "other-app").registry.isActive(foreignClient), false);
});

test("a logout receipt rolls back with failed session deletion", async () => {
  const session = { ...scope, sid: "rollback", sub: "rollback", expiresAt: now + 300 };
  await a.registry.register(session);
  await first.query(`CREATE FUNCTION fail_delete() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF OLD.subject='rollback' THEN RAISE EXCEPTION 'fixture rejection'; END IF; RETURN OLD; END $$`);
  await first.query("CREATE TRIGGER fail_delete BEFORE DELETE ON oidc_session FOR EACH ROW EXECUTE FUNCTION fail_delete()");
  const event = { ...scope, sub: "rollback", jti: "rollback-event", issuedAt: now, expiresAt: now + 300 };
  await assert.rejects(a.registry.applyLogout(event), /fixture rejection/);
  assert.equal((await first.query("SELECT 1 FROM oidc_logout_receipt WHERE jti='rollback-event'")).rowCount, 0);
  await first.query("DROP TRIGGER fail_delete ON oidc_session");
  await b.registry.applyLogout(event);
  assert.equal(await a.registry.isActive(session), false);
});

test("registration and logout share a transaction order across connections", async () => {
  const blocker = await first.connect();
  await blocker.query("BEGIN");
  await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [JSON.stringify(["example", scope.issuer, scope.clientId])]);
  let registered = false;
  const session = { ...scope, sid: "ordered", sub: "ordered", expiresAt: now + 300 };
  const pending = b.registry.register(session).then(() => { registered = true; });
  await blocker.query("SELECT pg_sleep(0.05)");
  assert.equal(registered, false);
  await blocker.query("COMMIT"); blocker.release();
  await pending;
  await a.registry.endAll({ ...scope, sub: "ordered" });
  assert.equal(await b.registry.isActive(session), false);
});

test("two connections share a result and never dispatch a spent refresh again", async () => {
  const request = { key: "generation-one", until: now + 300, reuseMs: 10000 };
  let calls = 0;
  const produce = async () => { calls++; return "opaque-result"; };
  const results = await Promise.all([a, b].map(store => store.refreshCoordinator.run(request, produce)));
  assert.deepEqual(results, [{ status: "ready", sealedResult: "opaque-result" }, { status: "ready", sealedResult: "opaque-result" }]);
  await first.query("UPDATE oidc_refresh SET completed_at = now() - interval '2 minutes'");
  await first.query(await readFile(new URL("./cleanup.sql", import.meta.url), "utf8"));
  assert.deepEqual(await b.refreshCoordinator.run(request, produce), { status: "reauth_required" });
  assert.equal(calls, 1);
});

test("uncertain refresh is spent; a proven pre-dispatch failure can retry", async () => {
  const request = { key: "lost-response", until: now + 300, reuseMs: 10000 };
  assert.deepEqual(await a.refreshCoordinator.run(request, async () => { throw Error("response lost"); }), { status: "reauth_required" });
  assert.deepEqual(await b.refreshCoordinator.run(request, () => assert.fail("duplicate dispatch")), { status: "reauth_required" });
  const safe = { ...request, key: "not-dispatched" };
  await assert.rejects(a.refreshCoordinator.run(safe, async () => { throw new RefreshNotDispatched("discovery unavailable"); }), RefreshNotDispatched);
  assert.deepEqual(await b.refreshCoordinator.run(safe, async () => "retried"), { status: "ready", sealedResult: "retried" });
});
