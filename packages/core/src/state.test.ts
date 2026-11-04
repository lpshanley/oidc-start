import { afterEach, describe, expect, test, vi } from "vitest";
import { sealValue } from "./seal.js";
import {
	fnv1a32Hex,
	OidcStateError,
	sealState,
	staleVerifierNames,
	verifierCookieName,
	verifyCallbackState,
} from "./state.js";

const password = "test-only-session-secret-at-least-32-characters";
const flow = { state: "transaction", purpose: "session", nonce: "n", codeVerifier: "v", returnPathname: "/projects" } as const;

afterEach(() => vi.useRealTimers());

describe("flow state", () => {
	test("names verifier cookies by a stable hash of the public state", () => {
		expect(fnv1a32Hex("")).toBe("811c9dc5");
		expect(verifierCookieName("sage", flow.state)).toBe(
			`sage-verifier-${fnv1a32Hex(flow.state)}`,
		);
	});

	test("verifies a matching state and cookie", async () => {
		const sealed = await sealState(flow, password);

		await expect(
			verifyCallbackState({ state: flow.state, cookieValue: sealed, password }),
		).resolves.toMatchObject(flow);
	});

	test.each([
		["missing", undefined],
		["invalid", "something-else"],
	] as const)("rejects a %s cookie", async (reason, cookieValue) => {
		await expect(
			verifyCallbackState({ state: flow.state, cookieValue, password }),
		).rejects.toEqual(new OidcStateError(reason));
	});

	test("rejects a valid verifier from another transaction and the old mirrored format", async () => {
		const verifier = await sealState(flow, password);
		await expect(verifyCallbackState({ state: "other", cookieValue: verifier, password }))
			.rejects.toEqual(new OidcStateError("mismatch"));
		const { state: _, ...legacy } = flow;
		const old = await sealValue({ ...legacy, issuedAt: Date.now() }, password, 600);
		await expect(verifyCallbackState({ state: old, cookieValue: old, password }))
			.rejects.toEqual(new OidcStateError("invalid"));
	});

	test("rejects a forged seal, a foreign shape, and an expired flow", async () => {
		const forged = await sealState(
			flow,
			"another-secret-that-is-at-least-32-chars",
		);
		const shape = await sealValue({ nonce: "n" }, password, 600);
		vi.useFakeTimers({ toFake: ["Date"], now: 0 });
		const old = await sealState(flow, password);
		vi.setSystemTime(601_000);

		for (const cookieValue of [forged, shape, old]) {
			await expect(
				verifyCallbackState({ state: flow.state, cookieValue, password }),
			).rejects.toEqual(new OidcStateError("invalid"));
		}
	});
});

describe("verifier eviction", () => {
	const names = (count: number) =>
		Array.from({ length: count }, (_, i) => `sage-verifier-${i}`);

	test("keeps up to five pending verifiers", () => {
		expect(
			staleVerifierNames([...names(4), "sage_session", "sage-verifierX"], {
				prefix: "sage",
				keep: "sage-verifier-new",
			}),
		).toEqual([]);
	});

	test("evicts every other verifier past the limit", () => {
		expect(
			staleVerifierNames([...names(5), "sage_session"], {
				prefix: "sage",
				keep: "sage-verifier-new",
			}),
		).toEqual(names(5));
	});
});
