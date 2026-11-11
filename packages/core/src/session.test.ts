import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createSessionManager, type Session } from "./session.js";
import { createMemorySessionRegistry } from "./registry.js";
import { createMemoryRefreshCoordinator, type SessionRefreshCoordinator } from "./refresh.js";
import { RefreshNotDispatched, type OidcProvider } from "./provider.js";
import { CHUNK_SIZE } from "./cookies.js";
import { sealValue } from "./seal.js";

const scope = { issuer: "https://issuer.test", clientId: "app" };
const fresh: Session = {
	version: 2, clientId: scope.clientId,
	user: { issuer: scope.issuer, sub: "alice", name: "Alice", roles: ["member"] },
	accessToken: "access", refreshToken: "refresh", idToken: "id", expiresAt: 1300,
	sid: "app-1", idpSid: "provider-1", issuedAt: 1000, lastSeenAt: 1000,
};
const password = "test-only-session-secret-at-least-32-characters";
function apply(jar: Map<string, string>, lines: string[]) {
	for (const line of lines) {
		const pair = line.split(";")[0], i = pair.indexOf("="), name = pair.slice(0, i);
		if (/Max-Age=0(;|$)/.test(line)) jar.delete(name);
		else jar.set(name, decodeURIComponent(pair.slice(i + 1)));
	}
	return jar;
}
function setup({ registry = createMemorySessionRegistry(), coordinator, allowSession = (user: Session["user"]) => user.roles?.includes("member") === true, idleSeconds = 43200 }:
	{ registry?: ReturnType<typeof createMemorySessionRegistry>; coordinator?: SessionRefreshCoordinator; allowSession?: (user: Session["user"]) => boolean | Promise<boolean>; idleSeconds?: number } = {}) {
	const refresh = vi.fn<OidcProvider["refresh"]>().mockResolvedValue({ accessToken: "next", refreshToken: "next-refresh", expiresAt: 2000, roles: ["member"] });
	const manager = createSessionManager({
		cookieName: () => "app_session", cookieOptions: () => ({ path: "/", httpOnly: true, sameSite: "lax" }),
		maxAgeSeconds: 86400, idleSeconds, password: () => password, scope: () => scope,
		registry, refreshCoordinator: coordinator, allowSession, provider: () => ({ refresh }) as unknown as OidcProvider,
	});
	async function jar(session: Session = fresh) {
		await registry.register({ ...scope, sid: session.sid, sub: session.user.sub, idpSid: session.idpSid, expiresAt: session.issuedAt + 86400 });
		return apply(new Map(), await manager.write(new Map(), session));
	}
	return { manager, registry, refresh, jar };
}
beforeEach(() => vi.useFakeTimers({ toFake: ["Date"], now: 1_000_000 }));
afterEach(() => vi.useRealTimers());

test("anonymous without cookies; authenticated only with a live registry entry", async () => {
	const { manager, registry, jar, refresh } = setup();
	expect(await manager.resolve(new Map())).toEqual({ status: "anonymous", reason: "no_session", session: null, setCookies: [] });
	const cookies = await jar();
	expect(await manager.resolve(cookies)).toEqual({ status: "authenticated", session: fresh, setCookies: [] });
	await registry.end({ ...scope, sid: fresh.sid });
	expect(await manager.resolve(cookies)).toMatchObject({ status: "anonymous", reason: "session_ended" });
	expect(refresh).not.toHaveBeenCalled();
});

test("rejects tampering, old formats, and a foreign client or issuer", async () => {
	const { manager, jar } = setup();
	const cookies = await jar();
	cookies.set("app_session", cookies.get("app_session") + "x");
	expect((await manager.resolve(cookies)).reason).toBe("invalid_session");
	for (const session of [{ ...fresh, version: 1 }, { ...fresh, clientId: "other" }, { ...fresh, user: { ...fresh.user, issuer: "https://other.test" } }]) {
		const sealed = await sealValue(session, password, 86400);
		expect((await manager.resolve(new Map([["app_session", sealed]]))).reason).toBe("invalid_session");
	}
});

test("chunks large sealed tokens without exposing them to the registry", async () => {
	const { manager, registry, jar } = setup();
	const register = vi.spyOn(registry, "register");
	const big = { ...fresh, accessToken: "a".repeat(CHUNK_SIZE), idToken: "i".repeat(CHUNK_SIZE) };
	const cookies = await jar(big);
	expect(cookies.size).toBeGreaterThan(1);
	expect((await manager.resolve(cookies)).session).toEqual(big);
	expect(register.mock.calls[0][0]).not.toHaveProperty("accessToken");
});

test.each([60, 1])("idle activity and absolute expiry remain enforced (%i seconds)", async idleSeconds => {
	const { manager, jar } = setup({ idleSeconds });
	const cookies = await jar({ ...fresh, expiresAt: 100000 });
	for (let i = 1; i <= 2; i++) {
		vi.setSystemTime((1000 + idleSeconds * i) * 1000);
		const result = await manager.resolve(cookies);
		expect(result.status).toBe("authenticated");
		apply(cookies, result.setCookies);
	}
	vi.setSystemTime((1000 + idleSeconds * 3 + 1) * 1000);
	expect((await manager.resolve(cookies)).reason).toBe("session_expired");
	const old = await jar({ ...fresh, sid: "absolute-expiry", lastSeenAt: 100000, expiresAt: 100000 });
	vi.setSystemTime((fresh.issuedAt + 86400) * 1000);
	expect((await manager.resolve(old)).reason).toBe("session_expired");
});

test("denial persists without signing in again; renewed claims may restore access", async () => {
	const { manager, jar, refresh } = setup();
	const cookies = await jar({ ...fresh, user: { ...fresh.user, roles: [] } });
	for (let i = 0; i < 2; i++) expect(await manager.resolve(cookies)).toMatchObject({ status: "denied", reason: "access_denied", setCookies: [] });
	vi.setSystemTime(1_280_000);
	const recovered = await manager.resolve(cookies);
	expect(recovered.status).toBe("authenticated");
	expect(refresh).toHaveBeenCalledOnce();
});

test("refresh persists changed credentials even when the updated policy denies access", async () => {
	const { manager, jar, refresh } = setup();
	refresh.mockResolvedValue({ accessToken: "next", refreshToken: "rotated", expiresAt: 2000, roles: [] });
	const cookies = await jar({ ...fresh, expiresAt: 1010 });
	const denied = await manager.resolve(cookies);
	expect(denied.status).toBe("denied");
	apply(cookies, denied.setCookies);
	expect((await manager.resolve(cookies)).status).toBe("denied");
	expect(refresh).toHaveBeenCalledOnce();
});

test("registry and policy outages are unavailable, retain cookies, and propagate bounded reasons", async () => {
	const { manager, registry, jar } = setup();
	const cookies = await jar();
	const failure = new Error("private store details");
	vi.spyOn(registry, "isActive").mockRejectedValue(failure);
	const report = vi.fn();
	expect(await manager.resolve(cookies, report)).toMatchObject({ status: "unavailable", reason: "registry_unavailable", setCookies: [] });
	expect(report).toHaveBeenCalledWith(failure, "registry-read", "registry_unavailable");
	await expect(manager.readSession(cookies, "sign-out")).rejects.toBe(failure);
	const other = setup({ allowSession: () => { throw failure; } });
	expect(await other.manager.resolve(await other.jar())).toMatchObject({ status: "unavailable", reason: "policy_unavailable", setCookies: [] });
});

test.each(["rotated", "refresh"])("two replicas rotate only once, including a nonrotating token (%s)", async refreshToken => {
	const registry = createMemorySessionRegistry(), coordinator = createMemoryRefreshCoordinator();
	const a = setup({ registry, coordinator }), b = setup({ registry, coordinator });
	const tokens = { accessToken: "next", refreshToken, expiresAt: 1010, roles: ["member"] };
	a.refresh.mockResolvedValue(tokens); b.refresh.mockResolvedValue(tokens);
	const cookies = await a.jar({ ...fresh, expiresAt: 1010, authTime: 700 });
	const [one, two] = await Promise.all([a.manager.resolve(cookies), b.manager.resolve(cookies)]);
	expect(one.session).toEqual(two.session);
	expect(one.session?.authTime).toBe(700);
	expect(one.session?.refreshGeneration).toBe(1);
	expect(a.refresh.mock.calls.length + b.refresh.mock.calls.length).toBe(1);
	const next = apply(new Map(cookies), one.setCookies);
	expect((await b.manager.resolve(next)).session?.refreshGeneration).toBe(2);
	vi.setSystemTime(1_011_000);
	expect(await a.manager.resolve(cookies)).toMatchObject({ status: "anonymous", reason: "reauth_required", setCookies: [] });
	expect(a.refresh.mock.calls.length + b.refresh.mock.calls.length).toBe(2);
});

test("a refresh that finishes after logout cannot restore the session", async () => {
	const { manager, registry, jar, refresh } = setup();
	let finish!: () => void;
	const waiting = new Promise<void>(resolve => { finish = resolve; });
	let dispatched!: () => void;
	const started = new Promise<void>(resolve => { dispatched = resolve; });
	refresh.mockImplementation(async () => { dispatched(); await waiting; return { roles: ["member"], accessToken: "late", expiresAt: 2000 }; });
	const cookies = await jar({ ...fresh, expiresAt: 1010 });
	const resolving = manager.resolve(cookies);
	await started;
	await registry.end({ ...scope, sid: fresh.sid });
	finish();
	expect(await resolving).toMatchObject({ status: "anonymous", reason: "session_ended" });
});

test("only a proven pre-dispatch failure permits retry of the same refresh token", async () => {
	const a = setup();
	const cookies = await a.jar({ ...fresh, expiresAt: 1010 });
	a.refresh.mockRejectedValueOnce(new RefreshNotDispatched("discovery down"));
	expect(await a.manager.resolve(cookies)).toMatchObject({ status: "unavailable", setCookies: [] });
	expect((await a.manager.resolve(cookies)).status).toBe("authenticated");
	expect(a.refresh).toHaveBeenCalledTimes(2);
	const b = setup();
	const lost = await b.jar({ ...fresh, expiresAt: 1010 });
	b.refresh.mockRejectedValueOnce(new Error("response lost after dispatch"));
	for (let i = 0; i < 2; i++) expect((await b.manager.resolve(lost)).reason).toBe("reauth_required");
	expect(b.refresh).toHaveBeenCalledOnce();
});

test("a refresh that fails after dispatch is reported once, and a refused grant is not", async () => {
	const failed = setup();
	const error = new Error("HTTP 500 from the token endpoint");
	failed.refresh.mockRejectedValueOnce(error);
	const report = vi.fn();
	const cookies = await failed.jar({ ...fresh, expiresAt: 1010 });
	for (let i = 0; i < 2; i++) expect((await failed.manager.resolve(cookies, report)).reason).toBe("reauth_required");
	expect(report.mock.calls).toEqual([[error, "refresh", "reauth_required"]]);
	const refused = setup();
	refused.refresh.mockRejectedValueOnce(Object.assign(new Error("expired"), { error: "invalid_grant" }));
	const quiet = vi.fn();
	expect((await refused.manager.resolve(await refused.jar({ ...fresh, expiresAt: 1010 }), quiet)).reason).toBe("reauth_required");
	expect(quiet).not.toHaveBeenCalled();
});

test.each(["busy", "reauth_required"] as const)("coordination distinguishes %s without deleting a peer's cookie", async status => {
	const { manager, jar, refresh } = setup({ coordinator: { run: async () => ({ status }) } });
	expect(await manager.resolve(await jar({ ...fresh, expiresAt: 1010 }))).toMatchObject({ status: status === "busy" ? "unavailable" : "anonymous", setCookies: [] });
	expect(refresh).not.toHaveBeenCalled();
});

test("a short caller deadline cannot erase a successful peer's cookie", async () => {
	const { manager, jar, refresh } = setup();
	const cookies = await jar({ ...fresh, expiresAt: 1010 });
	const [one, late] = await Promise.all([manager.resolve(cookies), manager.resolve(cookies, undefined, { deadline: Date.now() - 1 })]);
	expect(one.status).toBe("authenticated");
	expect(late).toMatchObject({ status: "unavailable", setCookies: [] });
	apply(cookies, one.setCookies); apply(cookies, late.setCookies);
	expect((await manager.resolve(cookies)).status).toBe("authenticated");
	expect(refresh).toHaveBeenCalledOnce();
});

test.each(["registry", "policy"])("preserves a completed rotation through a subsequent %s outage", async dependency => {
  const allowSession = vi.fn().mockResolvedValue(true);
  const { manager, registry, jar, refresh } = setup({ allowSession });
  const cookies = await jar({ ...fresh, expiresAt: 1010 });
  const isActive = vi.spyOn(registry, "isActive");
  if (dependency === "registry") isActive.mockResolvedValueOnce(true).mockRejectedValueOnce(new Error("unavailable"));
  else allowSession.mockRejectedValueOnce(new Error("unavailable"));
  const failed = await manager.resolve(cookies);
  expect(failed.status).toBe("unavailable");
  apply(cookies, failed.setCookies);
  vi.setSystemTime(1_011_000);
  expect((await manager.resolve(cookies)).status).toBe("authenticated");
  expect(refresh).toHaveBeenCalledOnce();
});
