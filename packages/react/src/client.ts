import { createContext, createElement, useContext, type ReactNode } from "react";
import { useServerFn } from "@tanstack/react-start";
import type { AuthSession, SignInOptions } from "@lpshanley/oidc-start-core/models";
import { getSignInUrl, signOut } from "./functions.js";

const AuthContext = createContext<AuthSession | undefined>(undefined);

/** Supply the root loader's getAuth() result for SSR and client navigation. */
export function OidcAuthProvider({ auth, children }: { auth: AuthSession; children: ReactNode }) {
	return createElement(AuthContext.Provider, { value: auth }, children);
}

export function useAuth() {
	const auth = useContext(AuthContext);
	const signOutAndRedirect = useServerFn(signOut);
	if (!auth) throw new Error("useAuth() requires an OidcAuthProvider.");

	return {
		user: auth.user,
		async signIn(options?: SignInOptions) {
			window.location.assign(await getSignInUrl({ data: options }));
		},
		signOut: (options?: { everywhere?: boolean }) => signOutAndRedirect({ data: options }),
	};
}
