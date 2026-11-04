import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizePath, type Plugin } from "vite";

function modulePath(specifier: string) {
	return normalizePath(fileURLToPath(import.meta.resolve(specifier)));
}

const coreDir = dirname(modulePath("@lpshanley/oidc-start-core"));
const models = modulePath("@lpshanley/oidc-start-core/models");
const functions = modulePath("@lpshanley/oidc-start-react/functions");
const serverContext = dirname(functions) + "/context.js";
const providerDependency = /(?:^|\/node_modules\/)(?:openid-client|oauth4webapi|jose|iron-webcrypto)(?:\/|$)/;

function isServerOnly(id: string) {
	return (id.startsWith(coreDir + "/") && id !== models)
		|| id === serverContext
		|| /\.server\.[cm]?[jt]sx?$/.test(id)
		|| providerDependency.test(id)
		|| id.startsWith("node:")
		|| (id === "@lpshanley/oidc-start-core")
		|| (id.startsWith("@lpshanley/oidc-start-core/") && id !== "@lpshanley/oidc-start-core/models")
		|| id === "@lpshanley/oidc-start-react/server";
}

export function checkClientBundle(): Plugin {
	return {
		name: "oidc-example-check-client-bundle",
		apply: "build",
		applyToEnvironment: (environment) => environment.name === "client",
		generateBundle(_, bundle) {
			let includesAuthFunctions = false;
			for (const chunk of Object.values(bundle)) {
				if (chunk.type !== "chunk") continue;
				// Ignore modules removed by tree shaking. Check external imports too.
				const rendered = Object.entries(chunk.modules)
					.filter(([, module]) => module.renderedLength > 0)
					.map(([id]) => id);
				for (const id of [...rendered, ...chunk.imports, ...chunk.dynamicImports]) {
					const path = normalizePath(id.split("?")[0]);
					if (isServerOnly(path)) this.error(`Server-only code in ${chunk.fileName}: ${id}`);
					if (path === functions) includesAuthFunctions = true;
				}
			}
			if (!includesAuthFunctions) this.error("Client build did not exercise the OIDC server functions.");
		},
	};
}
