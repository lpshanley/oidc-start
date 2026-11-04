import { z } from "zod";
import { sealValue, unsealValue } from "./seal.js";

// Per-flow OAuth state, following WorkOS authkit-session's pkce/* modules: the
// sealed state is both the `state` parameter and the value of a verifier
// cookie named after its hash, so concurrent sign-ins in several tabs keep
// separate verifiers.

export const STATE_MAX_AGE_SECONDS = 600;
/** Pending verifiers tolerated before all but the newest are evicted. */
export const MAX_PENDING_VERIFIERS = 5;
const CLOCK_SKEW_MS = 60_000;

/**
 * What a flow's callback completes: the browser's session, or a grant the
 * app keeps on its own. A callback refuses the other purpose's state.
 */
export type FlowPurpose = "session" | "grant";

const flowStateSchema = z.object({
	purpose: z.enum(["session", "grant"]).default("session"),
	nonce: z.string().min(1),
	codeVerifier: z.string().min(1),
	returnPathname: z.string(),
	maxAge: z.number().int().nonnegative().optional(),
	issuedAt: z.number(),
});
export type FlowState = z.infer<typeof flowStateSchema>;

export class OidcStateError extends Error {
	override name = "OidcStateError";
	constructor(readonly reason: "missing" | "mismatch" | "invalid") {
		super(`OAuth state ${reason}`);
	}
}

/** FNV-1a 32-bit hash as 8 hex characters; namespacing only, not security. */
export function fnv1a32Hex(input: string) {
	let hash = 0x811c9dc5;
	for (const byte of new TextEncoder().encode(input)) {
		hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, "0");
}

export function verifierCookieName(prefix: string, sealedState: string) {
	return `${prefix}-verifier-${fnv1a32Hex(sealedState)}`;
}

export function isVerifierCookieName(prefix: string, name: string) {
	return name.startsWith(`${prefix}-verifier-`);
}

export function sealState(
	state: Omit<z.input<typeof flowStateSchema>, "issuedAt">,
	password: string,
) {
	return sealValue(
		{ ...state, issuedAt: Date.now() },
		password,
		STATE_MAX_AGE_SECONDS,
	);
}

function constantTimeEqual(a: string, b: string) {
	const left = new TextEncoder().encode(a);
	const right = new TextEncoder().encode(b);
	let difference = left.length ^ right.length;
	for (let i = 0; i < Math.max(left.length, right.length); i++) {
		difference |= (left[i] ?? 0) ^ (right[i] ?? 0);
	}
	return difference === 0;
}

/**
 * Checks the callback's `state` against its verifier cookie byte for byte,
 * then unseals it and enforces age independently of the seal's own TTL.
 */
export async function verifyCallbackState({
	state,
	cookieValue,
	password,
	purpose = "session",
}: {
	state: string;
	cookieValue: string | undefined;
	password: string;
	purpose?: FlowPurpose;
}): Promise<FlowState> {
	if (cookieValue === undefined) throw new OidcStateError("missing");
	if (!constantTimeEqual(state, cookieValue)) {
		throw new OidcStateError("mismatch");
	}
	let parsed: FlowState;
	try {
		parsed = flowStateSchema.parse(
			await unsealValue(state, password, STATE_MAX_AGE_SECONDS),
		);
	} catch {
		throw new OidcStateError("invalid");
	}
	const age = Date.now() - parsed.issuedAt;
	if (age < -CLOCK_SKEW_MS || age > STATE_MAX_AGE_SECONDS * 1000) {
		throw new OidcStateError("invalid");
	}
	if (parsed.purpose !== purpose) throw new OidcStateError("mismatch");
	return parsed;
}

/**
 * Verifier cookies to delete when minting `keep`: once the total would exceed
 * `max`, every other verifier goes, since hashed names carry no ordering.
 */
export function staleVerifierNames(
	cookieNames: Iterable<string>,
	{
		prefix,
		keep,
		max = MAX_PENDING_VERIFIERS,
	}: {
		prefix: string;
		keep: string;
		max?: number;
	},
) {
	const others = [...cookieNames].filter(
		(name) => name !== keep && isVerifierCookieName(prefix, name),
	);
	return others.length + 1 > max ? others : [];
}
