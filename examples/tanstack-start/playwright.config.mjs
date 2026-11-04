import { randomBytes } from "node:crypto";
import { defineConfig } from "@playwright/test";

const issuer = "http://localhost:19867";
const apps = [
	{ name: "dev", port: 19866, args: "" },
	{ name: "production", port: 19868, args: "preview" },
].map((app) => ({ ...app, origin: `http://127.0.0.1:${app.port}` }));
const client = {
	OIDC_ISSUER: issuer,
	OIDC_CLIENT_ID: "roundtrip",
	OIDC_CLIENT_SECRET: randomBytes(32).toString("hex"),
};

export default defineConfig({
	testDir: "./e2e",
	workers: 1,
	projects: apps.map(({ name, origin }) => ({ name, use: { baseURL: origin } })),
	webServer: [
		{
			command: "node e2e/issuer.mjs",
			url: `${issuer}/.well-known/openid-configuration`,
			env: { ...client, APP_ORIGINS: apps.map((app) => app.origin).join(" ") },
		},
		...apps.map(({ origin, port, args }) => ({
			command: `node node_modules/vite/bin/vite.js ${args} --host 127.0.0.1 --port ${port} --strictPort`,
			url: origin,
			env: { ...client, APP_ORIGIN: origin, SESSION_SECRET: randomBytes(32).toString("hex") },
		})),
	],
});
