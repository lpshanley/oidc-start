// A throwaway SCIM server for pointing a real provider at. It keeps users in
// memory and appends scrubbed traffic to a file. Run `pnpm build` first, then
// `SCIM_HARNESS_TOKEN=... node harness/server.mjs`, and expose the port through
// an HTTPS tunnel. See "Capture real traffic" in the README.
//
// To see how a provider reacts to a failure, write a fault file while it runs:
//   echo '{"mode":"unavailable","times":2}' > harness/fault.json
// The next two writes then fail inside the package, which answers 503 (mode
// "unavailable") or 409 (mode "conflict"). Reads still succeed, and the fault
// clears itself once `times` reaches zero.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { createScim, createScimAdapter, ScimConflictError } from "../dist/index.js";
import { createMemoryAdapter, recordTraffic } from "../dist/testing.js";

const token = process.env.SCIM_HARNESS_TOKEN;
if (!token || token.length < 32) throw new Error("Set SCIM_HARNESS_TOKEN to at least 32 random characters");
const port = Number(process.env.PORT ?? 8787);
const file = process.env.SCIM_HARNESS_FILE ?? "harness/recording.jsonl";
const faultFile = process.env.SCIM_HARNESS_FAULT_FILE ?? "harness/fault.json";

function takeFault() {
	try {
		const fault = JSON.parse(readFileSync(faultFile, "utf8"));
		if (!(fault.times > 0)) return undefined;
		writeFileSync(faultFile, JSON.stringify({ ...fault, times: fault.times - 1 }));
		console.warn("fault injected:", fault.mode);
		return fault.mode;
	} catch {
		return undefined;
	}
}

const storage = createMemoryAdapter();
const adapter = createScimAdapter({
	read: (connection) => storage.read(connection),
	async transaction(connection, fn) {
		const mode = takeFault();
		if (mode === "unavailable") throw new Error("injected storage failure");
		if (mode === "conflict") throw new ScimConflictError("injected conflict");
		return storage.transaction(connection, fn);
	},
});

const scim = recordTraffic(
	createScim({
		adapter,
		authenticate: async (given) => (given === token ? "harness" : null),
		onProblem: ({ kind, method, status }) => console.warn("problem", kind, method, status ?? ""),
	}),
	{
		onExchange(exchange) {
			appendFileSync(file, `${JSON.stringify(exchange)}\n`);
			console.log(exchange.method, exchange.path, exchange.status);
		},
	},
);

createServer(async (incoming, outgoing) => {
	const hasBody = incoming.method !== "GET" && incoming.method !== "HEAD";
	// Behind an HTTPS tunnel the public scheme arrives in a header, and resource locations must use it.
	const scheme = incoming.headers["x-forwarded-proto"] === "https" ? "https" : "http";
	const request = new Request(`${scheme}://${incoming.headers.host}${incoming.url}`, {
		method: incoming.method,
		headers: Object.entries(incoming.headers).flatMap(([name, value]) => (typeof value === "string" ? [[name, value]] : [])),
		...(hasBody ? { body: Readable.toWeb(incoming), duplex: "half" } : {}),
	});
	const response = await scim.handle(request);
	outgoing.writeHead(response.status, Object.fromEntries(response.headers));
	outgoing.end(Buffer.from(await response.arrayBuffer()));
}).listen(port, "127.0.0.1", () => console.log(`SCIM harness on http://127.0.0.1:${port}/scim/v2, recording to ${file}`));
