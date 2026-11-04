import { displayName } from "@lpshanley/oidc-start-core/models";
import { getAuth, getSignInUrl, signOut } from "@lpshanley/oidc-start-react/functions";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";

export const Route = createFileRoute("/")({
	loader: () => getAuth(),
	component: Home,
});

function Home() {
	const { user } = Route.useLoaderData();
	const signOutAndRedirect = useServerFn(signOut);
	return (
		<main>
			<h1>OIDC sign-in</h1>
			{user ? (
				<>
					<p>Signed in as {displayName(user)}.</p>
					<button onClick={() => signOutAndRedirect()}>Sign out</button>
				</>
			) : (
				<button onClick={async () => location.assign(await getSignInUrl())}>Sign in</button>
			)}
		</main>
	);
}
