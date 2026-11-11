# @lpshanley/oidc-start-react

Add OpenID Connect sign-in to a TanStack Start app. Loaders can read the current user, components can start sign-in or sign-out, and Start’s middleware handles the session cookies. The server exchanges the authorization code. Loaders and React components receive the user profile.

The quickstart connects a root loader, a home page at `/` and a callback at `/callback`. The example also includes `/sign-in`, a guarded `/account` page and a `/settings` page that requires a recent login. [Complete example app](https://github.com/lpshanley/oidc-start/tree/main/examples/tanstack-start)

For multi-replica deployment, see the [production guide](https://github.com/lpshanley/oidc-start/blob/main/docs/production.md) and [tested PostgreSQL example](https://github.com/lpshanley/oidc-start/tree/main/examples/postgres).

## 1. Install and configure the server

Use Node.js 22.12 or newer. Your app supplies `@tanstack/react-start@^1.169.2` and `@tanstack/react-router@^1.170.44`. Install the React adapter. It brings in the OIDC core as a dependency.

```sh
npm install @lpshanley/oidc-start-react
```

Register a confidential web client with your OIDC provider. If your app runs at `http://localhost:5173`, register these exact URLs. Use your public HTTPS origin in production.

| Provider setting | Local value |
| --- | --- |
| Sign-in redirect URI | `http://localhost:5173/callback` |
| Post-logout redirect URI | `http://localhost:5173/` |

Set these values in your **server environment**. Generate `SESSION_SECRET` once with `openssl rand -hex 32` and reuse it across server instances. Email is optional. Use `displayName(user)` for a name, email, or neutral account label.

```dotenv
APP_ORIGIN=http://localhost:5173
OIDC_ISSUER=https://id.example.com
OIDC_CLIENT_ID=your-client-id
OIDC_CLIENT_SECRET=your-client-secret
# Paste the generated secret here before starting the app.
SESSION_SECRET=
```

Import `createOidcCore` and the `SessionRegistry` type from `@lpshanley/oidc-start-react/server` in your server module. For local development, copy the example’s `auth.server.ts` into `src/auth.server.ts`. It exports an `auth` instance configured with `callbackPath: '/callback'` and `postLogoutPath: '/'`. The example admits any authenticated user and keeps active sessions in memory. For deployment, set `allowSession` to your access policy and use a durable session registry shared by all instances. [Copy auth.server.ts](https://github.com/lpshanley/oidc-start/blob/main/examples/tanstack-start/src/auth.server.ts) · [Core configuration and storage](https://www.npmjs.com/package/@lpshanley/oidc-start-core)

## 2. Register the request middleware

In `src/start.ts`, add Start’s CSRF middleware before the OIDC middleware. The first checks the origin of browser calls to server functions, including sign-out. The second resolves the session for the request and writes any refreshed cookies. The `createServerOnlyFn` wrapper keeps your `auth` instance out of the client bundle.

```ts
import { oidcMiddleware } from '@lpshanley/oidc-start-react'
import { createCsrfMiddleware, createServerOnlyFn, createStart } from '@tanstack/react-start'
import { auth } from './auth.server'

const csrf = createCsrfMiddleware({ filter: ctx => ctx.handlerType === 'serverFn' })
const oidc = oidcMiddleware({ core: createServerOnlyFn(() => auth) })

export const startInstance = createStart(() => ({
  requestMiddleware: [csrf, oidc],
}))
```

`oidcMiddleware` serves one core. The `core` function takes no arguments and runs once, on the first request; its result is reused for every request after. It cannot pick a configuration per request.

## 3. Add the callback route

Create `src/routes/callback.ts`. The handler checks the provider response, establishes the session, and redirects to the local path chosen at sign-in.

```ts
import { handleCallbackRoute } from '@lpshanley/oidc-start-react'
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/callback')({
  server: { handlers: { GET: handleCallbackRoute() } },
})
```

## 4. Load the user in the root route

In `src/routes/__root.tsx`, call `getAuth()` from the loader. It returns `{ user }`, with `user: null` for a guest. Pass the result to `AuthProvider` so descendants share the user on the first render and after navigation. [Example root route](https://github.com/lpshanley/oidc-start/blob/main/examples/tanstack-start/src/routes/__root.tsx)

```tsx
import { AuthProvider } from '@lpshanley/oidc-start-react/client'
import { getAuth } from '@lpshanley/oidc-start-react/functions'
import { createRootRoute, HeadContent, Outlet, Scripts } from '@tanstack/react-router'

export const Route = createRootRoute({ loader: () => getAuth(), component: Root })

function Root() {
  const auth = Route.useLoaderData()
  return (
    <html lang="en">
      <head><HeadContent /></head>
      <body>
        <AuthProvider auth={auth}><Outlet /></AuthProvider>
        <Scripts />
      </body>
    </html>
  )
}
```

Upgrading from 0.3.x? Rename the `OidcAuthProvider` import and JSX tags to `AuthProvider`. It takes the same `auth` and `children` props.

## 5. Connect the buttons

In `src/routes/index.tsx`, read the user and actions from `useAuth()`. The hook handles navigation to the provider for both sign-in and sign-out. [Example home page](https://github.com/lpshanley/oidc-start/blob/main/examples/tanstack-start/src/routes/index.tsx)

```tsx
import { displayName } from '@lpshanley/oidc-start-react'
import { useAuth } from '@lpshanley/oidc-start-react/client'
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/')({ component: Home })

function Home() {
  const { user, signIn, signOut } = useAuth()
  if (!user) return <button onClick={() => signIn()}>Sign in</button>
  return (
    <main>
      <p>Signed in as {displayName(user)}.</p>
      <button onClick={signOut}>Sign out</button>
    </main>
  )
}
```

Call `signOut()` for the current session or `signOut({ everywhere: true })` for all of this user's sessions in this app. Use `signOut({ providerLogout: false })` to end only the application session. These options use the same CSRF-protected POST server function. If the session registry is unavailable, the server returns 503 so the user can retry.

Use `useAuth().hasRole('admin')` to show role-specific UI. It returns false for signed-out users and sessions without a roles claim. Check authorization again in the server handler that reads private data or performs the action.

Import `useUser` from `@lpshanley/oidc-start-react/client` when a component only needs the loader's `AuthUser | null`.

For navigation links, import `SignedIn` and `SignedOut` from that same entry. Inside the provider, `<SignedIn><AccountMenu /></SignedIn>` shows the menu to a signed-in user and `<SignedOut><SignInButton /></SignedOut>` shows a button to a guest. Both use the loader's user during SSR and client navigation.

**Try it.** Open `/` in a fresh browser session and choose **Sign in**. After the provider redirects you back, your name should appear and survive a reload. Choose **Sign out**, finish logout at the provider if prompted, and reload. You should see **Sign in** again.

### Recheck the session when a tab regains focus

To pick up a sign-out from another tab, add this effect to the root component that reads the auth loader. Invalidating the root match reruns `getAuth()` and supplies the new user to the provider. The server function returns only `{ user }` and sets `Cache-Control: no-store`.

```tsx
import { rootRouteId, useRouter } from '@tanstack/react-router'
import { useEffect } from 'react'

function useRecheckAuthOnFocus() {
  const router = useRouter()
  useEffect(() => {
    const recheck = () => {
      void router.invalidate({ filter: match => match.routeId === rootRouteId })
    }
    window.addEventListener('focus', recheck)
    return () => window.removeEventListener('focus', recheck)
  }, [router])
}
```

Call `useRecheckAuthOnFocus()` once in the root component to opt in. A session check can update the idle timestamp, so a periodic timer in an unattended tab can extend its session.

### Sign in and return here

From a page with a sign-in button, pass its local pathname when the user clicks. The server sanitizes the path and binds it to this sign-in flow. Omitting the option keeps the default destination of `/`.

```tsx
function SignInHere() {
  const { signIn } = useAuth()
  return <button onClick={() => signIn({ returnPathname: window.location.pathname })}>Sign in</button>
}
```

If the page needs its current filters or anchor after sign-in, append `window.location.search` or `window.location.hash` to the pathname. From a dedicated login page, pass the intended destination instead. The server function accepts the same option, for example `getSignInUrl({ data: { returnPathname: '/account' } })`.

To prefill an account, pass `loginHint`. For an account picker, call `signIn({ prompt: 'select_account' })`. The hook, `getSignInUrl({ data: options })`, and `handleSignInRoute(options)` accept the same sign-in options. Supported prompts are `login`, `consent`, `select_account`, and `none`. Omitting `prompt` leaves the provider's usual SSO behavior in place.

## HTTP routes and server access

The buttons above call server functions through `useAuth()`. To call those functions directly, import `getSignInUrl` and `signOut` from `@lpshanley/oidc-start-react/functions`. Bind the latter with `useServerFn(signOut)` in a component so the router follows the sign-out redirect. For ordinary links and forms, mount these handlers from `@lpshanley/oidc-start-react` behind the same OIDC middleware. Choose the paths in your app.

| Method | Handler | When to use it |
| --- | --- | --- |
| GET | `handleSignInRoute()` | Link to sign-in. Use `returnPathname` for the local return path and `maxAge` to request a recent provider login. |
| GET | `handleCallbackRoute()` | Mount at the exact callback path registered with your provider. |
| POST | `handleSignOutRoute()` | Submit a same-origin form. Include the field `everywhere=1` to revoke all of the user's app sessions. Add `server.middleware: [createCsrfMiddleware()]` to this route because the global filter above only covers server functions. |
| POST | `handleBackchannelLogoutRoute()` | Register this URL with your provider for back-channel logout. The provider sends a signed logout token without a browser Origin header. Keep the browser CSRF check scoped to the browser routes. |

In a server handler, import `getOidcContext` from `@lpshanley/oidc-start-react/server` to access the resolved session and core for the current request. Use `getAuth()` from `/functions` when a loader or component only needs the user.

### Protect route navigation

Mount `GET: handleSignInRoute()` at a local path such as `/sign-in`. A protected route can then use the following option with `requireAuth` from `@lpshanley/oidc-start-react/functions`.

```ts
beforeLoad: ({ location }) => requireAuth({ signInPath: '/sign-in', returnPathname: location.href })
```

The helper reads the session on the server. A guest follows a document redirect to the sign-in route. A signed-in user is available as `Route.useRouteContext().user`. Enforce authorization in every server function or endpoint that serves private data, including those called by the guarded route.

### Restrict an admin route by role

Import `requireAuth` from `@lpshanley/oidc-start-react/functions`, `hasRole` from the package root, and `redirect` from `@tanstack/react-router`. Compose them in the admin route's `beforeLoad`.

```ts
beforeLoad: async ({ location }) => {
  const { user } = await requireAuth({ signInPath: '/sign-in', returnPathname: location.href })
  if (!hasRole(user, 'admin')) throw redirect({ href: '/forbidden', reloadDocument: true })
  return { user }
}
```

Guests sign in and return to the requested URL. An admin sees the dashboard. A signed-in user without the role goes to the app's `/forbidden` endpoint, which returns HTTP 403. Use role names from your provider's configured roles claim. [Admin route](https://github.com/lpshanley/oidc-start/blob/main/examples/tanstack-start/src/routes/admin.tsx) · [Forbidden response](https://github.com/lpshanley/oidc-start/blob/main/examples/tanstack-start/src/routes/forbidden.ts)

Private endpoints must also check the current request before reading admin data or performing a mutation. In a server route handler, import `getOidcContext` from `@lpshanley/oidc-start-react/server` and check the resolved user.

```ts
const { user } = getOidcContext().auth()
if (!user) return new Response(null, { status: 401 })
if (!hasRole(user, 'admin')) return new Response(null, { status: 403 })
// Perform the authorized operation here.
```

### Customize callback failures

Pass `onError({ reason, request })` to `handleCallbackRoute` to return a custom response. It takes precedence over `errorRedirectUrl`. A provider cancellation is `access_denied`, and a missing verifier (for example after its cookie expires) is `sign_in_expired`. Other reasons are `invalid_callback`, `invalid_state`, `provider_error`, `token_exchange_failed`, and `session_failed`. The middleware still clears the failed flow's verifier. A rejection by your own `allowSession` policy takes its separate 403 path.

To show a message on your own login page, redirect the classified reason to a fixed local route.

```ts
GET: handleCallbackRoute({
  onError: ({ reason }) => new Response(null, {
    status: 303,
    headers: {
      Location: '/login?' + new URLSearchParams({ auth_error: reason }),
      'Cache-Control': 'no-store',
    },
  }),
})
```

On the login page, read `auth_error` with `Route.useSearch()`. When the parameter is present, render `<p role="alert">{authErrorMessage(auth_error)}</p>` using `authErrorMessage` from `@lpshanley/oidc-start-react`. Unknown values receive a generic retry message. Host access denials keep their 403 response.

Keep the message visible until the user chooses **Dismiss**. Inside the login component, bind `const navigate = Route.useNavigate()` and use this click handler. It removes only the error parameter, preserves the fragment and replaces the current history entry so Back returns to the preceding page.

```tsx
<button onClick={() => navigate({
  search: previous => ({ ...previous, auth_error: undefined }),
  hash: true,
  replace: true,
  resetScroll: false,
})}>Dismiss</button>
```

The working example wires the callback to the login page and includes the route's search validation. [Callback](https://github.com/lpshanley/oidc-start/blob/main/examples/tanstack-start/src/routes/callback.ts) · [Dismissible login error](https://github.com/lpshanley/oidc-start/blob/main/examples/tanstack-start/src/routes/login.tsx)

### Require a recent login

Use `requireRecentAuth` from `@lpshanley/oidc-start-react/functions` in `beforeLoad` for a page that requires a recent provider login.

```ts
beforeLoad: ({ location }) => requireRecentAuth({
  maxAge: 300, signInPath: '/sign-in', returnPathname: location.href,
})
```

A guest or stale session is sent to the local sign-in endpoint with the same `maxAge` in seconds. A `maxAge` configured on `handleSignInRoute` caps the value the URL can request. Choose a positive window that gives the user time to return from the provider.

Inside the server handler for a sensitive action, call `checkRecentAuth({ maxAge: 300 })` from `@lpshanley/oidc-start-react/server` before performing the action. If `isStale` is true, stop the mutation and offer `signIn({ maxAge: 300, returnPathname: '/settings' })`. Check again when the user submits the action after returning. Pick the maximum age in the server's policy.

The age is in seconds and comes from the provider's ID-token `auth_time`. Signed-out users, existing sessions without that claim, and expired authentication all require sign-in. Token refresh preserves the original authentication time. A sign-in with `maxAge: 0` requests fresh authentication.

## Upgrading to 0.5

See the [migration guide](https://github.com/lpshanley/oidc-start/blob/main/docs/migration-0.5.md). `getAuth` and guards distinguish absent sessions from denied admission (403) and temporary authentication outages (503); only an absent session starts automatic sign-in. User email is optional and issuer identity is explicit.
