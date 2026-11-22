/** Maximum bytes accepted by SCIM or retained for a traffic recording. */
export const MAX_BODY_BYTES = 1 << 20;

/** Returns undefined on overflow. A sibling fetch stream may still own the source. */
export async function readBody(message: Request | Response): Promise<string | undefined> {
	if (!message.body) return "";
	const reader = message.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return Buffer.concat(chunks).toString("utf8");
			size += value.byteLength;
			if (size > MAX_BODY_BYTES) {
				void reader.cancel().catch(() => {});
				return undefined;
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
}
