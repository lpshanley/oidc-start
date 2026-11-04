import { z } from "zod";

/** Options for a single authorization request. Omit prompt to allow provider SSO. */
export const signInOptionsSchema = z.object({
	returnPathname: z.string().optional(),
	/** Maximum authentication age in seconds. Zero requests a fresh login. */
	maxAge: z.number().int().nonnegative().optional(),
	loginHint: z.string().min(1).optional(),
	prompt: z.enum(["none", "login", "consent", "select_account"]).optional(),
});
export type SignInOptions = z.infer<typeof signInOptionsSchema>;

export const authUserSchema = z.object({
	sub: z.string().min(1),
	email: z.string().min(1),
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

/** Whether the user holds the role; users without a roles claim hold none. */
export function hasRole(user: AuthUser, role: string) {
	return user.roles?.includes(role) ?? false;
}

export function displayName(user: AuthUser) {
	const name = user.name?.trim();
	return name && name.length > 0 ? name : user.email;
}

export function initials(user: AuthUser) {
	const source = displayName(user);
	const parts = source.split(/[\s@.]+/).filter(Boolean);
	const letters = `${parts[0]?.[0] ?? "U"}${parts[1]?.[0] ?? ""}`;
	return letters.toUpperCase().slice(0, 2);
}

export function sanitizeReturnPath(path: string | null | undefined) {
	if (
		!path ||
		!path.startsWith("/") ||
		path.startsWith("//") ||
		path.includes("\\")
	) {
		return "/";
	}
	const origin = "https://return-path.invalid";
	try {
		const url = new URL(path, origin);
		// Dot segments can normalize a local path into a protocol-relative URL.
		if (
			url.origin !== origin ||
			!url.pathname.startsWith("/") ||
			url.pathname.startsWith("//")
		) {
			return "/";
		}
		return `${url.pathname}${url.search}${url.hash}`;
	} catch {
		return "/";
	}
}
