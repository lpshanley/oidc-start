import { describe, expect, test } from "vitest";
import { MAX_LOGOUT_BODY_BYTES, MAX_LOGOUT_TOKEN_LENGTH, readFormBody, readLogoutToken } from "./body.js";

const form = "application/x-www-form-urlencoded";
const post = (body: BodyInit | null, headers: Record<string, string> = { "content-type": form }) =>
	new Request("https://app.test/logout", { method: "POST", headers, body, duplex: "half" } as RequestInit);

/** A body that never ends and records how much was pulled from it. */
function endless() {
	const state = { pulled: 0 };
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			state.pulled += 1024;
			controller.enqueue(new Uint8Array(1024).fill(97));
		},
	});
	return { state, body };
}

describe("readLogoutToken", () => {
	test("reads a token from a form body", async () => {
		expect(await readLogoutToken(post("logout_token=a.b.c"))).toBe("a.b.c");
	});

	test("accepts a charset parameter on the content type", async () => {
		const request = post("logout_token=x", { "content-type": `${form}; charset=UTF-8` });
		expect(await readLogoutToken(request)).toBe("x");
	});

	test.each([
		["multipart", { "content-type": "multipart/form-data; boundary=x" }],
		["json", { "content-type": "application/json" }],
		["none", {}],
	])("refuses %s encoding", async (_, headers) => {
		expect(await readLogoutToken(post("logout_token=x", headers))).toBeUndefined();
	});

	test("refuses a missing, empty or repeated token", async () => {
		expect(await readLogoutToken(post(""))).toBeUndefined();
		expect(await readLogoutToken(post("other=1"))).toBeUndefined();
		expect(await readLogoutToken(post("logout_token="))).toBeUndefined();
		expect(await readLogoutToken(post("logout_token=a&logout_token=b"))).toBeUndefined();
	});

	test("accepts a token at the length limit and refuses one past it", async () => {
		const at = "a".repeat(MAX_LOGOUT_TOKEN_LENGTH);
		expect(await readLogoutToken(post(`logout_token=${at}`))).toBe(at);
		expect(await readLogoutToken(post(`logout_token=${at}a`))).toBeUndefined();
	});

	test("refuses a body past the byte limit", async () => {
		const padding = "&pad=" + "a".repeat(MAX_LOGOUT_BODY_BYTES);
		expect(await readLogoutToken(post(`logout_token=x${padding}`))).toBeUndefined();
	});

	test("refuses on a declared Content-Length without reading", async () => {
		const { state, body } = endless();
		const request = post(body, { "content-type": form, "content-length": String(MAX_LOGOUT_BODY_BYTES + 1) });
		expect(await readLogoutToken(request)).toBeUndefined();
		expect(state.pulled).toBeLessThanOrEqual(1024); // the stream's own initial pull
	});

	test("stops reading an unbounded stream that declares no length", async () => {
		const { state, body } = endless();
		expect(await readLogoutToken(post(body))).toBeUndefined();
		expect(state.pulled).toBeLessThanOrEqual(MAX_LOGOUT_BODY_BYTES + 4096);
	});

	test("stops reading when the declared length understates the stream", async () => {
		const { state, body } = endless();
		const request = post(body, { "content-type": form, "content-length": "10" });
		expect(await readLogoutToken(request)).toBeUndefined();
		expect(state.pulled).toBeLessThanOrEqual(MAX_LOGOUT_BODY_BYTES + 4096);
	});

	/** One valid fragment, then silence: a slow client. */
	function stalled() {
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("logout_token="));
			},
			cancel() {
				cancelled = true;
			},
		});
		return { body, wasCancelled: () => cancelled };
	}

	test("gives up on a body that stalls past the timeout", async () => {
		const { body, wasCancelled } = stalled();
		expect(await readLogoutToken(post(body), { timeoutMs: 20 })).toBeUndefined();
		expect(wasCancelled()).toBe(true);
	});

	test("gives up when the request is aborted", async () => {
		const { body, wasCancelled } = stalled();
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 10);
		expect(await readLogoutToken(post(body), { signal: controller.signal, timeoutMs: 10_000 })).toBeUndefined();
		expect(wasCancelled()).toBe(true);
	});

	test("does not start on an already-aborted request", async () => {
		const { body } = stalled();
		expect(await readLogoutToken(post(body), { signal: AbortSignal.abort(), timeoutMs: 10_000 })).toBeUndefined();
	});
});

describe("readFormBody", () => {
	test("reads the fields of a form body", async () => {
		expect((await readFormBody(post("everywhere=1&x=2"), { maxBytes: 64 }))?.get("everywhere")).toBe("1");
	});

	test("ignores a body that is not form-encoded", async () => {
		expect(await readFormBody(post("everywhere=1", { "content-type": "text/plain" }))).toBeUndefined();
	});

	test("stops reading an endless body at the limit", async () => {
		const { state, body } = endless();
		expect(await readFormBody(post(body), { maxBytes: 4096 })).toBeUndefined();
		expect(state.pulled).toBeLessThan(64 * 1024);
	});

	test("gives up on a body that stalls", async () => {
		const body = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}) });
		expect(await readFormBody(post(body), { timeoutMs: 20 })).toBeUndefined();
	});
});
