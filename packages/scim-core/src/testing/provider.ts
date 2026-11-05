import { USER } from "../protocol.js";

const PATCH = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
const GROUP = "urn:ietf:params:scim:schemas:core:2.0:Group";

/** `okta` is an OIN integration. `okta-wizard` is an App Integration Wizard app, which updates with PUT. */
export type ScimDialect = "okta" | "okta-wizard" | "entra" | "authentik";
export type TestUser = { id: string; userName: string; externalId?: string };
export type TestGroup = { id: string; displayName: string };
type Person = { userName: string; externalId?: string; givenName?: string; familyName?: string };
type Operation = Record<string, unknown>;
type Exchange = { method: string; path: string; body?: unknown; status: number };

const resource = (person: Person, active: boolean) => ({
	schemas: [USER],
	userName: person.userName,
	...(person.externalId ? { externalId: person.externalId } : {}),
	name: { givenName: person.givenName ?? "Test", familyName: person.familyName ?? "User" },
	emails: [{ type: "work", value: person.userName, primary: true }],
	active,
});
const list = (member: TestUser, ref?: boolean) => [{ ...(ref ? { $ref: null } : {}), value: member.id }];

/**
 * Plays an identity provider against a `createScim` instance, in the request
 * shapes each one documents. These are modelled on vendor documentation and
 * notes from one authentik deployment, not captured traffic: passing here is
 * not proof that a real push works.
 */
export function createTestProvider(
	scim: { handle(request: Request): Promise<Response> },
	options: { dialect: ScimDialect; token?: string; origin?: string; basePath?: string },
) {
	const { dialect, token = "test-token", origin = "https://app.test", basePath = "/scim/v2" } = options;
	const requests: Exchange[] = [];

	async function send(method: string, path: string, body?: unknown) {
		const response = await scim.handle(
			new Request(origin + basePath + path, {
				method,
				headers: {
					authorization: `Bearer ${token}`,
					accept: "application/scim+json",
					...(body === undefined ? {} : { "content-type": "application/scim+json" }),
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			}),
		);
		const text = await response.text();
		requests.push({ method, path, ...(body === undefined ? {} : { body }), status: response.status });
		return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : undefined };
	}
	async function ok(method: string, path: string, body?: unknown) {
		const result = await send(method, path, body);
		if (result.status >= 400) throw new Error(`${method} ${path} answered ${result.status}: ${JSON.stringify(result.body)}`);
		return result.body;
	}
	const patch = (path: string, ...Operations: Operation[]) => ok("PATCH", path, { schemas: [PATCH], Operations });
	const member = (op: "add" | "remove", user: TestUser): Operation => {
		if (dialect === "entra")
			return { op: op === "add" ? "Add" : "Remove", path: "members", value: list(user, true) };
		return op === "add"
			? { op, path: "members", value: list(user) }
			: { op, path: `members[value eq "${user.id}"]` };
	};
	const wizard = dialect === "okta-wizard";
	/** Okta reads the resource, then sends it back with its change. */
	const putBack = async (user: TestUser, change: Record<string, unknown>) =>
		ok("PUT", `/Users/${user.id}`, { ...(await ok("GET", `/Users/${user.id}`)), ...change });
	const putMembers = async (group: TestGroup, change: (members: { value: string }[]) => { value: string }[]) => {
		const current = await ok("GET", `/Groups/${group.id}`);
		return ok("PUT", `/Groups/${group.id}`, { ...current, members: change(current.members) });
	};
	const setActive = async (user: TestUser, person: Person, active: boolean) => {
		if (wizard) return putBack(user, { active });
		if (dialect === "okta") return patch(`/Users/${user.id}`, { op: "replace", value: { active } });
		if (dialect === "entra")
			return patch(`/Users/${user.id}`, { op: "Replace", path: "active", value: active ? "True" : "False" });
		return ok("PUT", `/Users/${user.id}`, { ...resource(person, active), id: user.id });
	};

	return {
		/** Every exchange so far, for asserting on the traffic itself. */
		requests,
		/** Sends anything, for shapes these helpers do not cover. Does not throw on a refusal. */
		send,
		createUser: (person: Person): Promise<TestUser> => ok("POST", "/Users", resource(person, true)),
		getUser: (id: string) => send("GET", `/Users/${id}`),
		findUser: (userName: string) =>
			ok("GET", `/Users?filter=${encodeURIComponent(`userName eq "${userName}"`)}&startIndex=1&count=100`),
		deactivate: (user: TestUser) => setActive(user, user, false),
		reactivate: (user: TestUser) => setActive(user, user, true),
		/** Changes a given name, including the attributes each provider sends alongside it. */
		rename: (user: TestUser, givenName: string) => {
			if (wizard) return putBack(user, { name: { givenName, familyName: "User" } });
			if (dialect === "entra")
				return patch(
					`/Users/${user.id}`,
					{ op: "Replace", path: "name.givenName", value: givenName },
					{ op: "Replace", path: 'emails[type eq "work"].value', value: user.userName },
				);
			return ok("PUT", `/Users/${user.id}`, { ...resource({ ...user, givenName }, true), id: user.id });
		},
		deleteUser: (user: TestUser) => ok("DELETE", `/Users/${user.id}`),
		/** authentik creates a group empty, then adds its members by PATCH. */
		createGroup: async (displayName: string, members: TestUser[] = []): Promise<TestGroup> => {
			const inline = dialect !== "authentik";
			const group = await ok("POST", "/Groups", {
				schemas: [GROUP],
				displayName,
				members: inline ? members.flatMap((m) => list(m)) : [],
			});
			if (!inline && members.length) await patch(`/Groups/${group.id}`, ...members.map((m) => member("add", m)));
			return group;
		},
		addMember: (group: TestGroup, user: TestUser) =>
			wizard
				? putMembers(group, (members) => [...members, { value: user.id }])
				: patch(`/Groups/${group.id}`, member("add", user)),
		removeMember: (group: TestGroup, user: TestUser) =>
			wizard
				? putMembers(group, (members) => members.filter((m) => m.value !== user.id))
				: patch(`/Groups/${group.id}`, member("remove", user)),
		/** Okta recommends a no-path replace carrying the group's id. */
		renameGroup: (group: TestGroup, displayName: string) =>
			patch(`/Groups/${group.id}`, { op: "replace", value: { id: group.id, displayName } }),
		getGroup: (id: string) => ok("GET", `/Groups/${id}`),
		deleteGroup: (group: TestGroup) => ok("DELETE", `/Groups/${group.id}`),
	};
}
