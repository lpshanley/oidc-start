import { createContext, createElement, Fragment, useContext, type ReactNode } from "react";
import { useServerFn } from "@tanstack/react-start";
import { hasRole, type AuthSession, type SignInOptions } from "@lpshanley/oidc-start-core/models";
import { getSignInUrl, signOut } from "./functions.js";

const AuthContext = createContext<AuthSession | undefined>(undefined);

/** Supply the root loader's getAuth() result for SSR and client navigation. */
export function OidcAuthProvider({ auth, children }: { auth: AuthSession; children: ReactNode }) {
	return createElement(AuthContext.Provider, { value: auth }, children);
}

/** The user supplied by the current root loader, or null when signed out. */
export function useUser() {
	const auth = useContext(AuthContext);
	if (!auth) throw new Error("Auth hooks require an OidcAuthProvider.");
	return auth.user;
}

/** Render children when the loader has a signed-in user. */
export function SignedIn({ children }: { children: ReactNode }) {
	return useUser() ? createElement(Fragment, null, children) : null;
}

/** Render children when the loader has no signed-in user. */
export function SignedOut({ children }: { children: ReactNode }) {
	return useUser() ? null : createElement(Fragment, null, children);
}

export function useAuth() {
	const user = useUser();
	const signOutAndRedirect = useServerFn(signOut);

	return {
		user,
		hasRole: (role: string) => user !== null && hasRole(user, role),
		async signIn(options?: SignInOptions) {
			window.location.assign(await getSignInUrl({ data: options }));
		},
		signOut: (options?: { everywhere?: boolean }) => signOutAndRedirect({ data: options }),
	};
}
