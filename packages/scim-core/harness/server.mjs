// A throwaway SCIM server for pointing a real provider at. It keeps users in
// memory and appends scrubbed traffic to a file. Run `pnpm build` first, then
// `SCIM_HARNESS_TOKEN=... node harness/server.mjs`, and expose the port through
// an HTTPS tunnel. See "Capture real traffic" in the README.
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { createScim } from "../dist/index.js";
import { createMemoryAdapter, recordTraffic } from "../dist/testing.js";

const token = process.env.SCIM_HARNESS_TOKEN;
if (!token || token.length < 32) throw new Error("Set SCIM_HARNESS_TOKEN to at least 32 random characters");
const port = Number(process.env.PORT ?? 8787);
const file = process.env.SCIM_HARNESS_FILE ?? "harness/recording.jsonl";

const scim = recordTraffic(
	createScim({
		adapter: createMemoryAdapter(),
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
	const request = new Request(`http://${incoming.headers.host}${incoming.url}`, {
		method: incoming.method,
		headers: Object.entries(incoming.headers).flatMap(([name, value]) => (typeof value === "string" ? [[name, value]] : [])),
		...(hasBody ? { body: Readable.toWeb(incoming), duplex: "half" } : {}),
	});
	const response = await scim.handle(request);
	outgoing.writeHead(response.status, Object.fromEntries(response.headers));
	outgoing.end(Buffer.from(await response.arrayBuffer()));
}).listen(port, "127.0.0.1", () => console.log(`SCIM harness on http://127.0.0.1:${port}/scim/v2, recording to ${file}`));
