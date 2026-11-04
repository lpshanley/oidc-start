import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { CHUNK_SIZE } from "./cookies.js";
import { createSessionManager, type Session } from "./session.js";

const password = "test-only-session-secret-at-least-32-characters";
const user = { sub: "alice", email: "alice@sage.test", name: "Alice" };
const fresh: Session = {
	user,
	accessToken: "access",
	refreshToken: "refresh",
	idToken: "id",
	expiresAt: 1_000 + 300,
	sid: "sid-1",
	issuedAt: 1_000,
	lastSeenAt: 1_000,
};

function apply(jar: Map<string, string>, lines: string[]) {
	for (const line of lines) {
		const [pair = ""] = line.split(";");
		const name = pair.slice(0, pair.indexOf("="));
		if (/Max-Age=0(;|$)/.test(line)) jar.delete(name);
		else jar.set(name, decodeURIComponent(pair.slice(name.length + 1)));
	}
	return jar;
}

const revocations = {
	isRevoked: vi.fn(async () => false),
	revoke: vi.fn(),
	revokeAllFor: vi.fn(),
	revokeIdpSession: vi.fn(),
};

function setup() {
	const manager = createSessionManager({
		cookieName: () => "sage_session",
		cookieOptions: () => ({ path: "/", httpOnly: true, sameSite: "lax" }),
		maxAgeSeconds: 60 * 60 * 24 * 30,
		idleSeconds: 60 * 60 * 12,
		revocations,
		allowSession: (u: Session["user"]) => !u.roles || u.roles.includes("stellar"),
		password: () => password,
	});
	return { manager };
}

async function jarWith(session: Session) {
	const { manager } = setup();
	return apply(new Map(), await manager.write(new Map(), session));
}

beforeEach(() => vi.useFakeTimers({ toFake: ["Date"], now: 1_000_000 }));
afterEach(() => vi.useRealTimers());

describe("session manager", () => {
	test("is anonymous without a cookie and writes nothing", async () => {
		await expect(setup().manager.resolve(new Map())).resolves.toEqual({
			session: null,
			setCookies: [],
		});
	});

	test("returns a valid session", async () => {
		const { manager } = setup();

		const result = await manager.resolve(await jarWith(fresh));

		expect(result).toEqual({ session: fresh, setCookies: [] });
	});

	test("clears a tampered or foreign session", async () => {
		const jar = await jarWith(fresh);
		jar.set("sage_session", `${jar.get("sage_session")}x`);

		const result = await setup().manager.resolve(jar);

		expect(result.session).toBeNull();
		expect(apply(jar, result.setCookies).size).toBe(0);
	});

	test("chunks a session with large tokens and reads it back", async () => {
		const big = {
			...fresh,
			accessToken: "a".repeat(CHUNK_SIZE),
			idToken: "i".repeat(CHUNK_SIZE),
		};
		const jar = await jarWith(big);

		expect([...jar.keys()].sort()).toEqual(
			expect.arrayContaining(["sage_session.0", "sage_session.1"]),
		);
		await expect(setup().manager.resolve(jar)).resolves.toMatchObject({
			session: big,
		});
	});
});

describe("session lifetime and revocation", () => {
	const at = (seconds: number) => vi.setSystemTime(seconds * 1000);

	test("ends sessions that are revoked, idle, too old, or no longer members", async () => {
		const { manager } = setup();

		revocations.isRevoked.mockResolvedValueOnce(true);
		expect((await manager.resolve(await jarWith(fresh))).session).toBeNull();

		at(1_000 + 60 * 60 * 12 + 1);
		expect((await manager.resolve(await jarWith(fresh))).session).toBeNull();

		at(1_000 + 60 * 60 * 24 * 30 + 1);
		const old = {
			...fresh,
			lastSeenAt: 1_000 + 60 * 60 * 24 * 30,
			expiresAt: 1e9,
		};
		expect((await manager.resolve(await jarWith(old))).session).toBeNull();

		at(1_000);
		const denied = { ...fresh, user: { ...user, roles: [] } };
		const removed = await manager.resolve(await jarWith(denied));
		expect((await manager.resolve(await jarWith({ ...fresh, expiresAt: 999 }))).session).toBeNull();
		expect(removed.session).toBeNull();
		expect(removed.setCookies.join()).toContain("Max-Age=0");
	});

	test("fails closed but keeps the cookie when the revocation store is down", async () => {
		const { manager } = setup();
		revocations.isRevoked.mockRejectedValueOnce(
			new Error("database unavailable"),
		);
		expect(await manager.resolve(await jarWith(fresh))).toEqual({
			session: null,
			setCookies: [],
		});
	});
});
