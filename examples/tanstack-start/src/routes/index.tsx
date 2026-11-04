import { displayName } from "@lpshanley/oidc-start-react";
import { useAuth } from "@lpshanley/oidc-start-react/client";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
	component: Home,
});

function Home() {
	const { user, signIn, signOut } = useAuth();
	return (
		<main>
			<h1>OIDC sign-in</h1>
			{user ? (
				<>
					<p>Signed in as {displayName(user)}.</p>
					<button onClick={signOut}>Sign out</button>
				</>
			) : (
				<button onClick={() => signIn()}>Sign in</button>
			)}
		</main>
	);
}
