import { z } from "zod";

export type AuthEnvironment = Readonly<Record<string, string | undefined>>;
export type AuthEnvironmentProvider = () => AuthEnvironment;

export const authServiceOptionsSchema = z.object({
	/** Cookie names start with this prefix. Defaults to `oidc`. */
	cookiePrefix: z
		.string()
		.regex(
			/^[A-Za-z0-9_-]+$/,
			"cookiePrefix must contain only letters, numbers, underscores or hyphens",
		)
		.default("oidc"),
	/** Application session lifetime in seconds. Defaults to 14 days. */
	sessionMaxAgeSeconds: z
		.number()
		.int("sessionMaxAgeSeconds must be a positive integer")
		.positive("sessionMaxAgeSeconds must be a positive integer")
		.default(60 * 60 * 24 * 14),
	/** Session lifetime without requests, in seconds. Defaults to 12 hours. */
	sessionIdleSeconds: z
		.number()
		.int()
		.positive()
		.default(60 * 60 * 12),
	/** Callback path when OIDC_REDIRECT_URI is unset. */
	callbackPath: z.string().default("/api/auth/callback"),
	/** Application path after provider logout. Defaults to `/login`. */
	postLogoutPath: z.string().default("/login"),
	/** Timeout for each provider request. Defaults to 5 seconds. */
	providerTimeoutMs: z.number().int().positive().default(5_000),
});
export type AuthServiceOptions = z.input<typeof authServiceOptionsSchema>;

export const sessionConfigurationSchema = z.object({
	SESSION_SECRET: z
		.string({ error: "Missing required environment variable: SESSION_SECRET" })
		.min(1, "Missing required environment variable: SESSION_SECRET")
		.min(32, "SESSION_SECRET must be at least 32 characters"),
});

export const oidcConfigurationSchema = z.object({
	OIDC_ISSUER: z
		.string({
			error: "Missing required environment variable: OIDC_ISSUER",
		})
		.min(1, "Missing required environment variable: OIDC_ISSUER")
		.pipe(z.url({ error: "OIDC_ISSUER must be a valid URL" })),
	OIDC_CLIENT_ID: z
		.string({
			error: "Missing required environment variable: OIDC_CLIENT_ID",
		})
		.min(1, "Missing required environment variable: OIDC_CLIENT_ID"),
	OIDC_CLIENT_SECRET: z
		.string({
			error: "Missing required environment variable: OIDC_CLIENT_SECRET",
		})
		.min(1, "Missing required environment variable: OIDC_CLIENT_SECRET"),
	/** Space-separated scopes; offline_access requests a refresh token. */
	OIDC_SCOPES: z.preprocess(
		(value) => (value === "" ? undefined : value),
		z.string().default("openid profile email offline_access"),
	),
	/** The claim holding the user's roles, read into `AuthUser.roles`. */
	OIDC_ROLES_CLAIM: z.preprocess(
		(value) => (value === "" ? undefined : value),
		z.string().default("roles"),
	),
});
export type OidcConfiguration = z.output<typeof oidcConfigurationSchema>;

export const authOriginConfigurationSchema = z.object({
	APP_ORIGIN: z.preprocess(
		(value) => (value === "" ? undefined : value),
		z.url({ error: "APP_ORIGIN must be a valid URL" }).optional(),
	),
	OIDC_REDIRECT_URI: z.url().optional().catch(undefined),
	NODE_ENV: z.string().optional(),
});

export function assertOidcConfigured(env: AuthEnvironment) {
	const issues = [
		oidcConfigurationSchema,
		sessionConfigurationSchema,
		authOriginConfigurationSchema,
	].flatMap((schema) => schema.safeParse(env).error?.issues ?? []);
	if (issues.length) {
		throw new Error(
			`Invalid OIDC configuration: ${issues.map((issue) => issue.message).join("; ")}`,
		);
	}
}
