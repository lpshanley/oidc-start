import { createContext, createElement, Fragment, useContext, type ReactElement, type ReactNode } from "react";
import { useServerFn } from "@tanstack/react-start";
import { hasRole, type AuthSession, type SignInOptions, type SignOutOptions } from "@lpshanley/oidc-start-core/models";
import { getSignInUrl, signOut } from "./functions.js";

const AuthContext = createContext<AuthSession | undefined>(undefined);

/** Supply the root loader's getAuth() result for SSR and client navigation. */
export function AuthProvider({ auth, children }: { auth: AuthSession; children: ReactNode }) {
	return createElement(AuthContext.Provider, { value: auth }, children);
}

/** The user supplied by the current root loader, or null when signed out. */
export function useUser() {
	const auth = useContext(AuthContext);
	if (!auth) throw new Error("Wrap components that use auth hooks in <AuthProvider>.");
	return auth.user;
}

/** Render children when the loader has a signed-in user. */
export function SignedIn({ children }: { children: ReactNode }): ReactElement | null {
	return useUser() ? createElement(Fragment, null, children) : null;
}

/** Render children when the loader has no signed-in user. */
export function SignedOut({ children }: { children: ReactNode }): ReactElement | null {
	return useUser() ? null : createElement(Fragment, null, children);
}

export function useAuth() {
	const user = useUser();
	const signOutAndRedirect = useServerFn(signOut);

	// Keep the zero-argument click handler and send only the declared RPC option.
	function signOutUser(): Promise<never>;
	function signOutUser(options?: SignOutOptions): Promise<never>;
	function signOutUser(options?: SignOutOptions) {
		return signOutAndRedirect({ data: options ? {
			everywhere: options.everywhere === true,
			providerLogout: options.providerLogout,
		} : undefined });
	}

	return {
		user,
		hasRole: (role: string) => user !== null && hasRole(user, role),
		async signIn(options?: SignInOptions) {
			window.location.assign(await getSignInUrl({ data: options }));
		},
		signOut: signOutUser,
	};
}
