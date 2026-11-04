import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { CHUNK_SIZE } from "./cookies.js";
import type { OidcProvider } from "./provider.js";
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
	const refresh = vi.fn<OidcProvider["refresh"]>();
	const manager = createSessionManager({
		cookieName: () => "sage_session",
		cookieOptions: () => ({ path: "/", httpOnly: true, sameSite: "lax" }),
		maxAgeSeconds: 60 * 60 * 24 * 30,
		idleSeconds: 60 * 60 * 12,
		revocations,
		allowSession: (u: Session["user"]) => !u.roles || u.roles.includes("stellar"),
		password: () => password,
		provider: () => ({ refresh }) as unknown as OidcProvider,
	});
	return { manager, refresh };
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

	test("returns a valid session without refreshing", async () => {
		const { manager, refresh } = setup();

		const result = await manager.resolve(await jarWith(fresh));

		expect(result).toEqual({ session: fresh, setCookies: [] });
		expect(refresh).not.toHaveBeenCalled();
	});

	test("clears a tampered or foreign session", async () => {
		const jar = await jarWith(fresh);
		jar.set("sage_session", `${jar.get("sage_session")}x`);

		const result = await setup().manager.resolve(jar);

		expect(result.session).toBeNull();
		expect(apply(jar, result.setCookies).size).toBe(0);
	});

	test("refreshes near expiry once for concurrent requests and keeps the ID token", async () => {
		const { manager, refresh } = setup();
		const jar = await jarWith({ ...fresh, expiresAt: 1_000 + 10 });
		refresh.mockResolvedValue({
			roles: ["stellar"],
			accessToken: "access-2",
			refreshToken: "refresh-2",
			expiresAt: 1_000 + 600,
		});

		const [first, second] = await Promise.all([
			manager.resolve(jar),
			manager.resolve(jar),
		]);

		expect(refresh).toHaveBeenCalledOnce();
		expect(refresh).toHaveBeenCalledWith("refresh", "alice", undefined);
		expect(first.session).toEqual({
			...fresh,
			user: { ...user, roles: ["stellar"] },
			lastSeenAt: 1_000,
			accessToken: "access-2",
			refreshToken: "refresh-2",
			expiresAt: 1_600,
		});
		expect(second.session).toEqual(first.session);
		const next = await manager.resolve(apply(jar, first.setCookies));
		expect(next.session?.accessToken).toBe("access-2");
	});

	test("reuses a just-completed refresh for a stale cookie, then expires it", async () => {
		const { manager, refresh } = setup();
		const jar = await jarWith({ ...fresh, expiresAt: 1_000 + 10 });
		refresh.mockResolvedValue({
			roles: ["stellar"],
			accessToken: "access-2",
			refreshToken: "refresh-2",
			expiresAt: 1_000 + 600,
		});

		await manager.resolve(jar);
		const stale = await manager.resolve(jar);
		vi.setSystemTime(1_000_000 + 11_000);
		await manager.resolve(jar);

		expect(stale.session?.accessToken).toBe("access-2");
		expect(refresh).toHaveBeenCalledTimes(2);
	});

	test("retries a refresh after a failure instead of caching it", async () => {
		const { manager, refresh } = setup();
		const jar = await jarWith({ ...fresh, expiresAt: 1_000 + 10 });
		refresh.mockRejectedValueOnce(new Error("network")).mockResolvedValue({
			roles: ["stellar"],
			accessToken: "access-2",
			expiresAt: 1_000 + 600,
		});

		await manager.resolve(jar);
		const retried = await manager.resolve(jar);

		expect(retried.session?.accessToken).toBe("access-2");
		expect(retried.session?.refreshToken).toBe("refresh");
	});

	test.each([
		["the refresh fails", true],
		["there is no refresh token", false],
	])("clears an expired session when %s", async (_, hasRefreshToken) => {
		const { manager, refresh } = setup();
		const jar = await jarWith({
			...fresh,
			refreshToken: hasRefreshToken ? "refresh" : undefined,
			expiresAt: 900,
		});
		refresh.mockRejectedValue(new Error("invalid_grant"));
		const onRefreshError = vi.fn();

		const result = await manager.resolve(jar, onRefreshError);

		expect(result.session).toBeNull();
		expect(apply(jar, result.setCookies).size).toBe(0);
		expect(onRefreshError).toHaveBeenCalledTimes(hasRefreshToken ? 1 : 0);
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

	test("clears an idle session while its access token is still valid", async () => {
		const { manager, refresh } = setup();
		const idleLimit = 12 * 60 * 60;
		const jar = await jarWith({ ...fresh, expiresAt: fresh.issuedAt + 2 * idleLimit });

		at(fresh.lastSeenAt + idleLimit + 1);
		const result = await manager.resolve(jar);

		expect(result.session).toBeNull();
		expect(apply(jar, result.setCookies).size).toBe(0);
		expect(refresh).not.toHaveBeenCalled();
	});

	test("ends sessions that are revoked, too old, or no longer members", async () => {
		const { manager, refresh } = setup();

		revocations.isRevoked.mockResolvedValueOnce(true);
		expect((await manager.resolve(await jarWith(fresh))).session).toBeNull();

		at(1_000 + 60 * 60 * 24 * 30 + 1);
		const old = {
			...fresh,
			lastSeenAt: 1_000 + 60 * 60 * 24 * 30,
			expiresAt: 1e9,
		};
		expect((await manager.resolve(await jarWith(old))).session).toBeNull();

		at(1_000);
		refresh.mockResolvedValueOnce({
			accessToken: "a2",
			expiresAt: 2_000,
			roles: [],
		});
		const expiring = { ...fresh, expiresAt: 1_000 + 10 };
		const removed = await manager.resolve(await jarWith(expiring));
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
