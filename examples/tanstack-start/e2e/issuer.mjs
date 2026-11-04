import { randomBytes } from "node:crypto";
import { Provider } from "oidc-provider";

const origins = process.env.APP_ORIGINS.split(" ");
const provider = new Provider(process.env.OIDC_ISSUER, {
	clients: [{
		client_id: process.env.OIDC_CLIENT_ID,
		client_secret: process.env.OIDC_CLIENT_SECRET,
		redirect_uris: origins.map((origin) => origin + "/callback"),
		post_logout_redirect_uris: origins.map((origin) => origin + "/"),
		response_types: ["code"],
		grant_types: ["authorization_code", "refresh_token"],
		token_endpoint_auth_method: "client_secret_post",
	}],
	claims: { email: ["email"], profile: ["name", "roles"] },
	cookies: { keys: [randomBytes(32).toString("hex")] },
	features: { devInteractions: { enabled: true }, revocation: { enabled: true } },
	findAccount: async (_ctx, accountId) => ({
		accountId,
		claims: async () => ({
			sub: accountId, email: "tester@example.test", name: "Round Trip Tester", roles: ["member"],
		}),
	}),
	issueRefreshToken: async (_ctx, client) => client.grantTypeAllowed("refresh_token"),
	// Exercise refresh on the first authenticated request.
	ttl: { AccessToken: (ctx) => ctx.oidc.params.grant_type === "authorization_code" ? 20 : 3600 },
});
provider.listen(Number(new URL(process.env.OIDC_ISSUER).port), "127.0.0.1");
