import { expect, test } from "vitest";
import { ENTERPRISE, parseFilter, parseGroup, parseUser, paging, patchGroup, patchUser, replaceUser, USER } from "./protocol.js";

const alice = {
	externalId: "sub-1",
	userName: "alice@x.test",
	displayName: "Alice",
	name: { givenName: "Alice", familyName: "Old" },
	emails: [],
	attributes: {},
	active: true,
};
const PATCH = ["urn:ietf:params:scim:api:messages:2.0:PatchOp"];
const patch = (...Operations: unknown[]) => patchUser(alice, { Operations });

test("Okta-style and path-style PATCH both deactivate; string booleans are accepted", () => {
	expect(patchUser(alice, { schemas: PATCH, Operations: [{ op: "replace", value: { active: false } }] }).active).toBe(false);
	expect(patch({ op: "Replace", path: "active", value: "False" }).active).toBe(false);
	expect(() => patch({ op: "replace", path: "active", value: "maybe" })).toThrow("active must be a boolean");
});

test("a user keeps every name part, and displayName stays its own attribute", () => {
	expect(parseUser({ userName: "bob", name: { givenName: "Bob", familyName: "B" } })).toEqual({
		userName: "bob",
		externalId: null,
		displayName: null,
		name: { givenName: "Bob", familyName: "B" },
		emails: [],
		attributes: {},
		active: true,
	});
	expect(() => parseUser({ externalId: "x" })).toThrow("userName");
});

test("PATCH updates one name part by path, dotted key, schema prefix or whole value", () => {
	const name = { givenName: "Alicia", familyName: "Old" };
	expect(patch({ op: "replace", path: "name.givenName", value: "Alicia" }).name).toEqual(name);
	expect(patch({ op: "replace", value: { "name.givenName": "Alicia" } }).name).toEqual(name);
	expect(patch({ op: "replace", path: `${USER}:name.givenName`, value: "Alicia" }).name).toEqual(name);
	expect(patch({ op: "replace", path: "name", value: { givenName: "Alicia" } }).name).toEqual(name);
	expect(patch({ op: "replace", path: "name.givenName", value: "Alicia" }).displayName).toBe("Alice");
});

test("remove clears optional attributes, needs a target, and refuses required ones", () => {
	expect(patch({ op: "remove", path: "name.familyName" }).name).toEqual({ givenName: "Alice" });
	expect(patch({ op: "remove", path: "name" }).name).toBeNull();
	expect(patch({ op: "remove", path: "displayName" }).displayName).toBeNull();
	expect(patch({ op: "remove", path: "title" })).toEqual(alice);
	for (const path of ["active", "userName", "externalId"])
		expect(() => patch({ op: "remove", path })).toThrow(expect.objectContaining({ scimType: "mutability" }));
	const remove = { Operations: [{ op: "remove" }] };
	expect(() => patchUser(alice, remove)).toThrow(expect.objectContaining({ status: 400, scimType: "noTarget" }));
	expect(() => patchGroup(remove)).toThrow(expect.objectContaining({ status: 400, scimType: "noTarget" }));
});

test("user PATCH applies operations in order", () => {
	expect(
		patch(
			{ op: "replace", path: "displayName", value: "First" },
			{ op: "remove", path: "displayName" },
			{ op: "replace", path: "displayName", value: "Last" },
		).displayName,
	).toBe("Last");
});

test("PUT keeps active and externalId when the provider omits them", () => {
	expect(replaceUser(alice, { userName: "alice@x.test", active: false })).toMatchObject({
		externalId: "sub-1",
		active: false,
	});
	expect(replaceUser({ ...alice, active: false }, { userName: "alice@x.test" }).active).toBe(false);
	expect(() => replaceUser(alice, { userName: "alice@x.test", active: "maybe" })).toThrow("active must be a boolean");
});

test("group PATCH keeps the order of its changes, in every provider form", () => {
	expect(
		patchGroup({
			Operations: [
				{ op: "remove", path: 'members[value eq "u2"]' },
				{ op: "add", path: "members", value: [{ value: "u1" }] },
				{ op: "Remove", path: "members", value: [{ $ref: null, value: "u3" }] },
				{ op: "replace", path: "displayName", value: "Ops" },
				{ op: "remove", path: "members" },
			],
		}),
	).toEqual([
		{ kind: "remove", ids: ["u2"] },
		{ kind: "add", ids: ["u1"] },
		{ kind: "remove", ids: ["u3"] },
		{ kind: "rename", displayName: "Ops" },
		{ kind: "replace", ids: [] },
	]);
});

test("a no-path add appends members, and a no-path replace replaces them", () => {
	const value = { members: [{ value: "u1" }] };
	expect(patchGroup({ Operations: [{ op: "add", value }] })).toEqual([{ kind: "add", ids: ["u1"] }]);
	expect(patchGroup({ Operations: [{ op: "replace", value }] })).toEqual([{ kind: "replace", ids: ["u1"] }]);
});

test("group input refuses a blank name and an unknown operation", () => {
	expect(() => parseGroup({ displayName: " " })).toThrow("displayName must be a string");
	expect(() => patchGroup({ Operations: [{ op: "replace", path: "displayName", value: "" }] })).toThrow(
		"displayName must be a string",
	);
	expect(() => patchGroup({ Operations: [{ op: "move", path: "members" }] })).toThrow("Unsupported group operation");
});

test("PATCH refuses a body that is not a PatchOp", () => {
	expect(() => patchUser(alice, {})).toThrow("Operations are required");
	expect(() => patchUser(alice, { schemas: ["other"], Operations: [{ op: "add" }] })).toThrow("PatchOp");
});

test("only eq filters on supported attributes are accepted", () => {
	expect(parseFilter('USERNAME eq "a\\"b@x.test"', ["userName"])).toEqual({ userName: 'a"b@x.test' });
	expect(parseFilter(null, ["userName"])).toEqual({});
	expect(() => parseFilter('userName co "a"', ["userName"])).toThrow(expect.objectContaining({ scimType: "invalidFilter" }));
	expect(() => parseFilter('title eq "a"', ["userName"])).toThrow("Unsupported filter");
});

test("paging is one-based and capped", () => {
	expect(paging(new URLSearchParams("startIndex=11&count=5"))).toEqual({ offset: 10, limit: 5, startIndex: 11 });
	expect(paging(new URLSearchParams("startIndex=0&count=9999"))).toEqual({ offset: 0, limit: 200, startIndex: 1 });
	expect(paging(new URLSearchParams("count=0")).limit).toBe(0);
});

test("an operation that is not an object is refused", () => {
	expect(() => patch(null)).toThrow("Each operation must be an object");
	expect(() => patchGroup({ Operations: [1] })).toThrow("Each operation must be an object");
});

test("add and replace need a value, so a missing one cannot clear an attribute", () => {
	expect(() => patch({ op: "add", path: "displayName" })).toThrow("add needs a value");
	expect(() => patch({ op: "Replace", path: "name.givenName" })).toThrow("replace needs a value");
	expect(() => patchGroup({ Operations: [{ op: "replace", path: "members" }] })).toThrow("replace needs a value");
	expect(patch({ op: "replace", path: "displayName", value: null }).displayName).toBeNull();
});

test("group PATCH sets and clears externalId, with or without a path", () => {
	expect(patchGroup({ Operations: [{ op: "replace", path: "externalId", value: "g-1" }] })).toEqual([
		{ kind: "externalId", externalId: "g-1" },
	]);
	expect(patchGroup({ Operations: [{ op: "replace", value: { externalId: "g-2" } }] })).toEqual([
		{ kind: "externalId", externalId: "g-2" },
	]);
	expect(patchGroup({ Operations: [{ op: "remove", path: "externalId" }] })).toEqual([{ kind: "externalId", externalId: null }]);
});

const full = {
	schemas: [USER, ENTERPRISE],
	userName: "alice@x.test",
	password: "never kept",
	groups: [{ value: "g-1" }],
	fooBar: "not a SCIM attribute",
	title: "CTO",
	preferredLanguage: "en-US",
	name: { honorificPrefix: "Dr", givenName: "Alice" },
	emails: [
		{ type: "work", value: "alice@x.test", primary: "True" },
		{ type: "other", value: "a@x.test", primary: true },
		{ type: "other", value: "a@x.test" },
		{ value: "" },
	],
	phoneNumbers: [{ type: "mobile", value: "1" }],
	[ENTERPRISE]: { department: "Eng", manager: { value: "m-1", displayName: "Boss" }, secret: "dropped" },
};

test("a user keeps emails and known attributes, one primary, and nothing unknown or secret", () => {
	const user = parseUser(full);
	expect(user.name).toEqual({ honorificPrefix: "Dr", givenName: "Alice" });
	expect(user.emails).toEqual([
		{ value: "alice@x.test", type: "work", primary: false },
		{ value: "a@x.test", type: "other", primary: true },
	]);
	expect(user.attributes).toEqual({
		title: "CTO",
		preferredLanguage: "en-US",
		phoneNumbers: [{ type: "mobile", value: "1" }],
		[ENTERPRISE]: { department: "Eng", manager: { value: "m-1", displayName: "Boss" } },
	});
	expect(JSON.stringify(user)).not.toContain("never kept");
});

test("PATCH writes the paths Entra documents", () => {
	const user = patch(
		{ op: "Add", path: 'emails[type eq "work"].value', value: "new@x.test" },
		{ op: "Add", path: 'emails[type eq "work"].primary', value: "True" },
		{ op: "Add", path: "title", value: "CTO" },
		{ op: "Replace", path: 'phoneNumbers[type eq "mobile"].value', value: "2" },
		{ op: "Add", path: 'addresses[type eq "work"].locality', value: "Oslo" },
		{ op: "Add", path: `${ENTERPRISE}:department`, value: "Sales" },
		{ op: "Add", path: `${ENTERPRISE}:manager`, value: "m-1" },
	);
	expect(user.emails).toEqual([{ value: "new@x.test", type: "work", primary: true }]);
	expect(user.attributes).toEqual({
		title: "CTO",
		phoneNumbers: [{ type: "mobile", value: "2" }],
		addresses: [{ type: "work", locality: "Oslo" }],
		[ENTERPRISE]: { department: "Sales", manager: { value: "m-1" } },
	});
});

test("PATCH replaces, merges, removes and clears extra attributes", () => {
	const start = { ...alice, ...parseUser(full) };
	const replaced = patchUser(start, {
		Operations: [{ op: "replace", value: { emails: [{ value: "b@x.test" }], [ENTERPRISE]: { division: "D" } } }],
	});
	expect(replaced.emails).toEqual([{ value: "b@x.test" }]);
	expect(replaced.attributes[ENTERPRISE]).toMatchObject({ department: "Eng", division: "D" });
	const added = patchUser(start, { Operations: [{ op: "add", path: "emails", value: [{ value: "c@x.test", primary: true }] }] });
	expect(added.emails.map((e) => e.primary)).toEqual([false, false, true]);
	const removed = patchUser(start, {
		Operations: [
			{ op: "remove", path: 'emails[type eq "other"]' },
			{ op: "remove", path: "title" },
			{ op: "remove", path: "phoneNumbers" },
			{ op: "remove", path: `${ENTERPRISE}:manager` },
			{ op: "replace", path: "preferredLanguage", value: null },
		],
	});
	expect(removed.emails.map((e) => e.type)).toEqual(["work"]);
	expect(removed.attributes).toEqual({ [ENTERPRISE]: { department: "Eng" } });
	const cleared = patchUser(removed, { Operations: [{ op: "remove", path: `${ENTERPRISE}:department` }] });
	expect(cleared.attributes).toEqual({});
});

test("a value filter that matches nothing is noTarget unless it names a type", () => {
	const start = { ...alice, emails: [{ value: "a@x.test", type: "work" }] };
	expect(() => patchUser(start, { Operations: [{ op: "replace", path: 'emails[value eq "z@x.test"].type', value: "home" }] })).toThrow(
		"No value matches the path",
	);
	expect(() => patchUser(start, { Operations: [{ op: "add", path: "emails.value", value: "z@x.test" }] })).toThrow("needs a filter");
	expect(patchUser(start, { Operations: [{ op: "replace", path: "fooBar", value: "x" }] })).toEqual(start);
});

test("filters join eq clauses with and, and reach emails", () => {
	const users = ["id", "userName", "externalId", "email", "emailType"] as const;
	expect(parseFilter('userName eq "a" and externalId eq "b"', users)).toEqual({ userName: "a", externalId: "b" });
	expect(parseFilter('USERNAME eq "x and y"  AND id eq "1"', users)).toEqual({ userName: "x and y", id: "1" });
	expect(parseFilter('emails.value eq "a@x.test"', users)).toEqual({ email: "a@x.test" });
	expect(parseFilter('emails[type eq "work"].value eq "a@x.test"', users)).toEqual({ email: "a@x.test", emailType: "work" });
	for (const bad of ['userName eq "a" or id eq "1"', 'userName eq "a" and userName eq "b"', "active eq true", 'emails.type eq "x"'])
		expect(() => parseFilter(bad, users), bad).toThrow("Unsupported filter");
	expect(() => parseFilter('emails.value eq "a"', ["displayName"])).toThrow("Unsupported filter");
});

test("attribute names match in any case, and the canonical spelling wins", () => {
	expect(parseUser({ USERNAME: "bob", Active: false, DisplayName: "B", EMAILS: [{ VALUE: "b@x.test", TYPE: "work" }] })).toMatchObject({
		userName: "bob",
		active: false,
		displayName: "B",
		emails: [{ value: "b@x.test", type: "work" }],
	});
	expect(parseUser({ userName: "bob", active: false, Active: true }).active).toBe(false);
	expect(parseUser({ userName: "bob", Active: true, active: false }).active).toBe(false);
	expect(parseGroup({ DISPLAYNAME: "ops", Members: [{ Value: "u1" }] })).toMatchObject({ displayName: "ops", memberIds: ["u1"] });
	expect(() => parseUser({ Active: false })).toThrow("userName");
	expect(patchUser(alice, { operations: [{ OP: "replace", PATH: "active", VALUE: false }] }).active).toBe(false);
	expect(patchUser(alice, { schemas: [PATCH[0].toUpperCase()], Operations: [{ op: "replace", path: "active", value: false }] }).active).toBe(false);
});

test("key handling cannot touch an object's prototype", () => {
	const user = parseUser(JSON.parse('{"userName":"bob","__proto__":{"admin":true},"emails":[{"value":"b@x.test","__proto__":{"admin":true}}]}'));
	expect((user as { admin?: boolean }).admin).toBeUndefined();
	expect(({} as { admin?: boolean }).admin).toBeUndefined();
});
