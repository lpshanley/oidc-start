import { type SealOptions, seal, unseal } from "iron-webcrypto";

// iron-session compatible seals, following WorkOS authkit-session's
// ironWebcryptoEncryption: AES-256-CBC with a SHA-256 HMAC, a password id of
// "1", and a "~2" version suffix.
const VERSION_SUFFIX = "~2";

function sealOptions(ttlSeconds: number): SealOptions {
	return {
		encryption: {
			saltBits: 256,
			algorithm: "aes-256-cbc",
			iterations: 1,
			minPasswordlength: 32,
		},
		integrity: {
			saltBits: 256,
			algorithm: "sha256",
			iterations: 1,
			minPasswordlength: 32,
		},
		ttl: ttlSeconds * 1000,
		timestampSkewSec: 60,
		localtimeOffsetMsec: 0,
	};
}

/** Encrypts and signs `data`; it can be unsealed for `ttlSeconds`. */
export async function sealValue(
	data: unknown,
	password: string,
	ttlSeconds: number,
): Promise<string> {
	const sealed = await seal(
		data,
		{ id: "1", secret: password },
		sealOptions(ttlSeconds),
	);
	return `${sealed}${VERSION_SUFFIX}`;
}

/** Verifies and decrypts a seal; throws when tampered, foreign, or expired. */
export async function unsealValue(
	sealed: string,
	password: string,
	ttlSeconds: number,
): Promise<unknown> {
	const [body = "", version] = sealed.split("~");
	if (`~${version}` !== VERSION_SUFFIX) throw new Error("Unsupported seal");
	return unseal(body, { "1": password }, sealOptions(ttlSeconds));
}
