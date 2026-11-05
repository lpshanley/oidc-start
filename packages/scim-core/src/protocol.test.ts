import { expect, test } from "vitest";
import { parseFilter, parseGroup, parseUser, paging, patchGroup, patchUser, replaceUser, USER } from "./protocol.js";

const alice = {
	externalId: "sub-1",
	userName: "alice@x.test",
	displayName: "Alice",
	name: { givenName: "Alice", familyName: "Old" },
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
