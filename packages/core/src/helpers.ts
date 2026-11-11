import type { AuthUser } from "./models.js";

// Browser code imports these from here, so that it does not load the schemas.

/** Whether the user holds the role; users without a roles claim hold none. */
export function hasRole(user: AuthUser, role: string) {
	return user.roles?.includes(role) ?? false;
}

export function displayName(user: AuthUser) {
	const name = user.name?.trim();
	return name && name.length > 0 ? name : user.email ?? "Account";
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
