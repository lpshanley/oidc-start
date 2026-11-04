import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import pg from "pg";
import { createPostgresStore } from "./store.mjs";

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw new Error("Set TEST_DATABASE_URL to a disposable PostgreSQL database");
const admin = new pg.Pool({ connectionString });
const schema = "oidc_test_" + randomUUID().replaceAll("-", "");
const poolOptions = { connectionString, options: "-c search_path=" + schema, statement_timeout: 5000 };
const first = new pg.Pool(poolOptions);
const second = new pg.Pool(poolOptions);
const a = createPostgresStore(first, "example");
const b = createPostgresStore(second, "example");
const now = Math.floor(Date.now() / 1000);
before(async () => {
	await admin.query("CREATE SCHEMA " + schema);
	await first.query(await readFile(new URL("./schema.sql", import.meta.url), "utf8"));
});
after(async () => {
	await Promise.all([first.end(), second.end()]);
	await admin.query("DROP SCHEMA " + schema + " CASCADE");
	await admin.end();
});

test("revocations survive reconnects, duplicates and out-of-order writes", async () => {
	const query = { sid: "app-1", idpSid: "provider-1", sub: "alice", issuedAt: now };
	assert.equal(await a.revocations.isRevoked(query), false);
	await Promise.all([a.revocations.revokeIdpSession("provider-1", now + 300), b.revocations.revokeIdpSession("provider-1", now - 10)]);
	await b.revocations.revokeIdpSession("provider-1", now - 1);
	assert.equal(await b.revocations.isRevoked(query), true);
	const other = { ...query, idpSid: undefined };
	assert.equal(await a.revocations.isRevoked(other), false);
	await a.revocations.revokeAllFor("alice", now);
	await b.revocations.revokeAllFor("alice", now - 10);
	assert.equal(await b.revocations.isRevoked(other), true);
	const newer = { ...other, issuedAt: now + 1 };
	assert.equal(await b.revocations.isRevoked(newer), false);
	await a.revocations.revoke("app-1", now - 1);
	assert.equal(await b.revocations.isRevoked(newer), false);
	await a.revocations.revoke("app-1", now + 300);
	assert.equal(await b.revocations.isRevoked(newer), true);
	assert.equal(await createPostgresStore(second, "other-app").revocations.isRevoked(query), false);
});

test("two connections share one result and never dispatch a spent refresh again", async () => {
	const request = { key: "generation-one", until: now + 300, reuseMs: 10000 };
	let calls = 0;
	const produce = async () => { calls++; return "opaque-result"; };
	const results = await Promise.all([a, b].map(store => store.refreshCoordinator.run(request, produce)));
	assert.deepEqual(results, ["opaque-result", "opaque-result"]);
	await first.query("UPDATE oidc_refresh SET completed_at = now() - interval '2 minutes'");
	await first.query(await readFile(new URL("./cleanup.sql", import.meta.url), "utf8"));
	assert.equal(await b.refreshCoordinator.run(request, produce), null);
	assert.equal(calls, 1);
});

test("an uncertain refresh leaves a committed reservation after the connection closes", async () => {
	const request = { key: "lost-response", until: now + 300, reuseMs: 10000 };
	await assert.rejects(a.refreshCoordinator.run(request, async () => { throw Error("response lost"); }), /response lost/);
	assert.equal(await b.refreshCoordinator.run(request, () => assert.fail("duplicate dispatch")), null);
});
