import { randomBytes } from "node:crypto";
import { Provider } from "oidc-provider";

const apps = JSON.parse(process.env.APP_CLIENTS);
const provider = new Provider(process.env.OIDC_ISSUER, {
	// This disposable fixture intentionally posts only to its registered loopback apps.
	fetch: (url, { dispatcher: _dispatcher, ...options }) => {
		if (!apps.some(app => url === app.origin + "/backchannel-logout")) throw new Error("Unexpected fixture request");
		return fetch(url, options);
	},
	clients: apps.map(({ origin, clientId, secret }) => ({
		client_id: clientId,
		client_secret: secret,
		redirect_uris: [origin + "/callback"],
		post_logout_redirect_uris: [origin + "/"],
		backchannel_logout_uri: origin + "/backchannel-logout",
		backchannel_logout_session_required: true,
		response_types: ["code"],
		grant_types: ["authorization_code", "refresh_token"],
		token_endpoint_auth_method: "client_secret_post",
	})),
	claims: { email: ["email"], profile: ["name", "roles"] },
	cookies: { keys: [randomBytes(32).toString("hex")] },
	features: { devInteractions: { enabled: true }, revocation: { enabled: true }, backchannelLogout: { enabled: true } },
	findAccount: async (_ctx, accountId) => ({
		accountId,
		claims: async () => ({
			sub: accountId, email: "tester@example.test", name: "Round Trip Tester",
			roles: accountId === "test-admin" ? ["member", "admin"] : ["member"],
		}),
	}),
	issueRefreshToken: async (_ctx, client) => client.grantTypeAllowed("refresh_token"),
	// Exercise refresh on the first authenticated request.
	ttl: { AccessToken: (ctx) => ctx.oidc.params.grant_type === "authorization_code" ? 20 : 3600 },
});
provider.on("backchannel.error", (_ctx, err) => console.error("backchannel delivery failed", err.response?.status ?? err.code ?? err.name));
provider.on("backchannel.success", () => console.info("backchannel delivered"));
provider.listen(Number(new URL(process.env.OIDC_ISSUER).port), "127.0.0.1");
