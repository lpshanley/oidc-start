import { z } from "zod";

const promptValues = new Set(["none", "login", "consent", "select_account"]);
export const promptSchema = z.string().trim().min(1).refine((value) => {
	const values = value.split(/\s+/);
	return values.every((v) => promptValues.has(v)) && new Set(values).size === values.length
		&& (!values.includes("none") || values.length === 1);
}, "Invalid OIDC prompt combination");

export const signOutOptionsSchema = z.object({
	everywhere: z.boolean().optional(),
	providerLogout: z.boolean().optional(),
});
export type SignOutOptions = z.infer<typeof signOutOptionsSchema>;

/** Options for a single authorization request. Omit prompt to allow provider SSO. */
export const signInOptionsSchema = z.object({
	returnPathname: z.string().optional(),
	/** Maximum authentication age in seconds. Zero requests a fresh login. */
	maxAge: z.number().int().nonnegative().optional(),
	loginHint: z.string().min(1).optional(),
	prompt: promptSchema.optional(),
});
export type SignInOptions = z.infer<typeof signInOptionsSchema>;

export const authUserSchema = z.object({
	issuer: z.url(),
	sub: z.string().min(1),
	email: z.string().min(1).optional(),
	name: z.string().nullable(),
	/** Profile image URL from the OIDC `picture` claim; absent when not provided. */
	picture: z
		.url({ protocol: /^https?$/ })
		.nullable()
		.optional()
		.catch(undefined),
	/** Role names from the configured roles claim; absent in older sessions. */
	roles: z.array(z.string()).optional().catch(undefined),
});
export type AuthUser = z.infer<typeof authUserSchema>;

export const authSessionSchema = z.object({ user: authUserSchema.nullable() });
export type AuthSession = z.infer<typeof authSessionSchema>;

export const authLogoutResultSchema = z.object({
	endSessionUrl: z.url().nullable(),
});
export type AuthLogoutResult = z.infer<typeof authLogoutResultSchema>;

export function isAuthUser(user: unknown): user is AuthUser {
	return authUserSchema.safeParse(user).success;
}

export { displayName, hasRole, initials, sanitizeReturnPath } from "./helpers.js";
