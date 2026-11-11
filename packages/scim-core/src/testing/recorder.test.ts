import { expect, test } from "vitest";
import { createScim, type ScimOptions, type ScimUser } from "../index.js";
import { createMemoryAdapter, createTestProvider, recordTraffic, replayTraffic, type ScimDialect, type ScimExchange } from "../testing.js";

const instance = () => {
	const options: ScimOptions<string, ScimUser, undefined> = {
		adapter: createMemoryAdapter<string>(),
		authenticate: async () => "acme",
	};
	return createScim(options);
};

test.each<ScimDialect>(["okta", "okta-wizard", "entra", "authentik"])("a %s recording replays on a fresh instance", async (dialect) => {
	const exchanges: ScimExchange[] = [];
	const scim = recordTraffic(instance(), { onExchange: (e) => exchanges.push(e) });
	const idp = createTestProvider(scim, { dialect });
	expect((await idp.findUser("alice@x.test")).totalResults).toBe(0);
	const alice = await idp.createUser({ userName: "alice@x.test", externalId: "ext-1", givenName: "Alice" });
	const ops = await idp.createGroup("ops");
	await idp.addMember(ops, alice);
	await idp.deactivate(alice);
	await idp.removeMember(ops, alice);

	expect(await replayTraffic(instance(), exchanges)).toEqual([]);
	const text = JSON.stringify(exchanges);
	expect(text).not.toMatch(/alice/i);
	expect(text).toContain("person-1");
});

test("a recording drops credentials and notices a changed status", async () => {
	const exchanges: ScimExchange[] = [];
	const scim = recordTraffic(instance(), { onExchange: (e) => exchanges.push(e) });
	const idp = createTestProvider(scim, { dialect: "okta", token: "super-secret-token" });
	await idp.send("POST", "/Users", {
		userName: "a@x.test",
		password: "hunter2",
		emails: [{ value: "a@x.test" }],
		phoneNumbers: [{ value: "555" }],
		"urn:ietf:params:scim:schemas:extension:enterprise:2.0:User": { manager: { value: "boss@x.test", displayName: "The Boss" } },
	});
	await idp.send("GET", "/Users/missing");
	expect(JSON.stringify(exchanges)).not.toMatch(/hunter2|super-secret-token|555|a@x|boss@x|The Boss/);

	const wrong = await replayTraffic(instance(), [{ ...exchanges[1], status: 200 }]);
	expect(wrong.map((m) => m.status)).toEqual([404]);
});
