import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizePath, type Plugin } from "vite";

function modulePath(specifier: string) {
	return normalizePath(fileURLToPath(import.meta.resolve(specifier)));
}

const functions = modulePath("@lpshanley/oidc-start-react/functions");
const serverEntry = modulePath("@lpshanley/oidc-start-react/server");
const serverContext = dirname(functions) + "/context.js";
const serverDependency = /(?:^|\/node_modules\/)(?:openid-client|oauth4webapi|jose|iron-webcrypto|zod)(?:\/|$)/;

function isServerOnly(id: string, helpers: string) {
	return (id.startsWith(dirname(helpers) + "/") && id !== helpers)
		|| id === serverEntry
		|| id === serverContext
		|| /\.server\.[cm]?[jt]sx?$/.test(id)
		|| serverDependency.test(id)
		|| id.startsWith("node:")
		|| (id === "@lpshanley/oidc-start-core")
		|| (id.startsWith("@lpshanley/oidc-start-core/") && id !== "@lpshanley/oidc-start-core/helpers")
		|| id === "@lpshanley/oidc-start-react/server";
}

export function checkClientBundle(): Plugin {
	return {
		name: "oidc-example-check-client-bundle",
		apply: "build",
		applyToEnvironment: (environment) => environment.name === "client",
		async generateBundle(_, bundle) {
			// Resolve core from its direct dependent in workspace and packed installs.
			const helpers = await this.resolve("@lpshanley/oidc-start-core/helpers", functions);
			if (!helpers || helpers.external) this.error("Could not resolve the adapter's browser-safe core helpers.");
			let includesAuthFunctions = false;
			for (const chunk of Object.values(bundle)) {
				if (chunk.type !== "chunk") continue;
				// Ignore modules removed by tree shaking. Check external imports too.
				const rendered = Object.entries(chunk.modules)
					.filter(([, module]) => module.renderedLength > 0)
					.map(([id]) => id);
				for (const id of [...rendered, ...chunk.imports, ...chunk.dynamicImports]) {
					const path = normalizePath(id.split("?")[0]);
					if (isServerOnly(path, normalizePath(helpers.id))) this.error(`Server-only code in ${chunk.fileName}: ${id}`);
					if (path === functions) includesAuthFunctions = true;
				}
			}
			if (!includesAuthFunctions) this.error("Client build did not exercise the OIDC server functions.");
		},
	};
}
