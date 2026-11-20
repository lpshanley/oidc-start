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

test("a recording scrubs attribute names whatever their case", async () => {
	const exchanges: ScimExchange[] = [];
	const scim = recordTraffic(instance(), { onExchange: (e) => exchanges.push(e) });
	const idp = createTestProvider(scim, { dialect: "okta" });
	await idp.send("POST", "/Users", {
		USERNAME: "a@x.test",
		Password: "hunter2",
		Emails: [{ Value: "a@x.test" }],
		"urn:ietf:params:scim:schemas:extension:enterprise:2.0:User": { Manager: { value: "boss@x.test" } },
	});
	expect(JSON.stringify(exchanges)).not.toMatch(/hunter2|a@x|boss@x/);
});

test("a recording scrubs PATCH values that a path addresses", async () => {
	const exchanges: ScimExchange[] = [];
	const scim = recordTraffic(instance(), { onExchange: (e) => exchanges.push(e) });
	const idp = createTestProvider(scim, { dialect: "entra" });
	const created = await idp.send("POST", "/Users", { userName: "a@x.test", externalId: "alias.a" });
	const patched = await idp.send("PATCH", `/Users/${created.body.id}`, {
		schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
		Operations: [
			{ op: "Replace", path: "userName", value: "renamed@x.test" },
			{ op: "Replace", path: "name.familyName", value: "Lovelace" },
			{ op: "Add", path: 'phoneNumbers[type eq "work"].value', value: "555-0100" },
			{ op: "Add", path: 'addresses[type eq "work"].locality', value: "Testville" },
			{ op: "Add", path: "emails", value: [{ type: "work", value: "work@x.test" }] },
			{ op: "Add", path: "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:manager", value: "boss-id" },
			{ op: "Replace", path: "Password", value: "hunter2" },
			{ op: "Replace", path: "externalId", value: "alias.renamed" },
			{ op: "Replace", path: "active", value: "False" },
			{
				op: "replace",
				value: {
					"name.givenName": "Augusta",
					"urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:department": "Engines",
					"urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:manager": "other-boss",
				},
			},
		],
	});
	expect(patched.status).toBe(200);
	const text = JSON.stringify(exchanges);
	expect(text).not.toMatch(/x\.test|Lovelace|555|Testville|boss|hunter2|alias|Augusta|Engines/);
	// What is not personal stays, so the recording still replays.
	expect(text).toContain('"value":"False"');
	expect(text).toContain('"type":"work"');
	expect(await replayTraffic(instance(), exchanges)).toEqual([]);
});

test("a recording never reads the body of a request that fails authentication", async () => {
	const exchanges: ScimExchange[] = [];
	const options: ScimOptions<string, ScimUser, undefined> = {
		adapter: createMemoryAdapter<string>(),
		authenticate: async () => null,
	};
	const scim = recordTraffic(createScim(options), { onExchange: (e) => exchanges.push(e) });
	let pulled = 0;
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			pulled += 1;
			if (pulled > 4) controller.close();
			else controller.enqueue(new Uint8Array(1024));
		},
	});
	const response = await scim.handle(
		new Request("https://app.test/scim/v2/Users", {
			method: "POST",
			headers: { "content-type": "application/scim+json" },
			body,
			duplex: "half",
		} as RequestInit),
	);
	expect(response.status).toBe(401);
	expect(pulled).toBeLessThanOrEqual(2);
	expect(exchanges).toEqual([]);
});

test("a recording that fails does not change the answer", async () => {
	const scim = recordTraffic(instance(), {
		onExchange: () => {
			throw new Error("disk full");
		},
	});
	const idp = createTestProvider(scim, { dialect: "okta" });
	expect((await idp.findUser("a@x.test")).totalResults).toBe(0);
});
