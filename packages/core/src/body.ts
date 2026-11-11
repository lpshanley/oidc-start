/** Largest back-channel logout body read, in bytes. Real tokens are a few KiB. */
export const MAX_LOGOUT_BODY_BYTES = 16 * 1024;
/** Longest accepted `logout_token`, in characters. */
export const MAX_LOGOUT_TOKEN_LENGTH = 8 * 1024;
/** Longest the whole body may take to arrive, in milliseconds. */
export const LOGOUT_BODY_TIMEOUT_MS = 5_000;

export type ReadLogoutTokenOptions = {
	/** Overall time allowed for the body; defaults to LOGOUT_BODY_TIMEOUT_MS. */
	timeoutMs?: number;
	/** The request's cancellation signal, when the host provides one. */
	signal?: AbortSignal;
};

/**
 * The `logout_token` of a form-encoded POST, or undefined when the request
 * is not that. The size limit is enforced while the stream is read, so a
 * client that lies about (or omits) Content-Length cannot buffer more.
 */
export async function readLogoutToken(
	request: Request,
	{ timeoutMs = LOGOUT_BODY_TIMEOUT_MS, signal }: ReadLogoutTokenOptions = {},
): Promise<string | undefined> {
	const type = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
	if (type !== "application/x-www-form-urlencoded") return undefined;
	const declared = Number(request.headers.get("content-length"));
	if (declared > MAX_LOGOUT_BODY_BYTES) return undefined;
	if (!request.body) return undefined;

	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	// A client that trickles bytes would otherwise hold the read open forever.
	let stop!: () => void;
	const stopped = new Promise<"stopped">((resolve) => (stop = () => resolve("stopped")));
	const timer = setTimeout(stop, timeoutMs);
	signal?.addEventListener("abort", stop, { once: true });
	if (signal?.aborted) stop();
	try {
		for (;;) {
			const next = await Promise.race([reader.read(), stopped]);
			if (next === "stopped") {
				await reader.cancel().catch(() => {});
				return undefined;
			}
			const { done, value } = next;
			if (done) break;
			size += value.byteLength;
			if (size > MAX_LOGOUT_BODY_BYTES) {
				await reader.cancel().catch(() => {});
				return undefined;
			}
			chunks.push(value);
		}
	} catch {
		return undefined;
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", stop);
	}

	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	const tokens = new URLSearchParams(new TextDecoder().decode(bytes)).getAll("logout_token");
	const [token] = tokens;
	if (tokens.length !== 1 || !token || token.length > MAX_LOGOUT_TOKEN_LENGTH) return undefined;
	return token;
}
