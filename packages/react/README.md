# @lpshanley/oidc-start-react

Add OpenID Connect sign-in to a TanStack Start app. Loaders can read the current user, components can start sign-in or sign-out, and Start’s middleware handles the session cookies. The code exchange and provider tokens stay on the server.

This guide adds two routes to an existing app. The home page at `/` shows who is signed in. The callback at `/callback` receives the browser when the provider sends it back. [Complete example app](https://github.com/lpshanley/oidc-start/tree/main/examples/tanstack-start)

## 1. Install and configure the server

Use Node.js 22.12 or newer. Your app supplies `@tanstack/react-start@^1.169.2` and `@tanstack/react-router@^1.170.44`. Install both OIDC packages because your app imports the core directly.

```sh
npm install @lpshanley/oidc-start-react@next @lpshanley/oidc-start-core@next
```

Register a confidential web client with your OIDC provider. If your app runs at `http://localhost:5173`, register these exact URLs. Use your public HTTPS origin in production.

| Provider setting | Local value |
| --- | --- |
| Sign-in redirect URI | `http://localhost:5173/callback` |
| Post-logout redirect URI | `http://localhost:5173/` |

Set these values in your **server environment**. Generate `SESSION_SECRET` once with `openssl rand -hex 32` and reuse it across server instances. Your provider must supply the account’s email in the ID token or through UserInfo.

```dotenv
APP_ORIGIN=http://localhost:5173
OIDC_ISSUER=https://id.example.com
OIDC_CLIENT_ID=your-client-id
OIDC_CLIENT_SECRET=your-client-secret
# Paste the generated secret here before starting the app.
SESSION_SECRET=
```

For local development, copy the example’s `auth.server.ts` into `src/auth.server.ts`. It exports an `auth` instance configured with `callbackPath: '/callback'` and `postLogoutPath: '/'`. The example admits any authenticated user and keeps revocations in memory. For deployment, set `allowSession` to your access policy and use a durable revocation store shared by all instances. [Copy auth.server.ts](https://github.com/lpshanley/oidc-start/blob/main/examples/tanstack-start/src/auth.server.ts) · [Core configuration and storage](https://www.npmjs.com/package/@lpshanley/oidc-start-core)

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

## 3. Add the callback route

Create `src/routes/callback.ts`. The handler checks the provider response, establishes the session, and redirects to the local path chosen at sign-in.

```ts
import { handleCallbackRoute } from '@lpshanley/oidc-start-react'
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/callback')({
  server: { handlers: { GET: handleCallbackRoute() } },
})
```

## 4. Connect the buttons

In `src/routes/index.tsx`, call `getAuth()` from the loader. It returns `{ user }`, with `user: null` for a signed-out visitor. Bind `signOut` with `useServerFn` so TanStack follows the redirect to the provider when the user clicks the button.

```tsx
import { displayName } from '@lpshanley/oidc-start-core/models'
import { getAuth, getSignInUrl, signOut } from '@lpshanley/oidc-start-react/functions'
import { createFileRoute } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'

export const Route = createFileRoute('/')({
  loader: () => getAuth(),
  component: Home,
})

function Home() {
  const { user } = Route.useLoaderData()
  const signOutAndRedirect = useServerFn(signOut)

  if (!user) {
    return <button onClick={async () => location.assign(await getSignInUrl())}>Sign in</button>
  }

  return (
    <main>
      <p>Signed in as {displayName(user)}.</p>
      <button onClick={() => signOutAndRedirect()}>Sign out</button>
    </main>
  )
}
```

**Try it.** Open `/` in a fresh browser session and choose **Sign in**. After the provider redirects you back, your name should appear and survive a reload. Choose **Sign out**, finish logout at the provider if prompted, and reload. You should see **Sign in** again.

To return someone to a specific page, pass a local path when starting sign-in, for example `getSignInUrl({ data: { returnPathname: '/account' } })`.

## HTTP routes and server access

The buttons above use server functions. If you prefer ordinary links and forms, mount these handlers from `@lpshanley/oidc-start-react` behind the same OIDC middleware. Choose the paths in your app.

| Method | Handler | When to use it |
| --- | --- | --- |
| GET | `handleSignInRoute()` | Link to sign-in. The optional `returnPathname` query parameter selects a local return path. |
| GET | `handleCallbackRoute()` | Mount at the exact callback path registered with your provider. |
| POST | `handleSignOutRoute()` | Submit a same-origin form. Add `server.middleware: [createCsrfMiddleware()]` to this route because the global filter above only covers server functions. |
| POST | `handleBackchannelLogoutRoute()` | Register this URL with your provider for back-channel logout. The provider sends a signed logout token without a browser Origin header. Keep the browser CSRF check scoped to the browser routes. |

In a server handler, import `getOidcContext` from `@lpshanley/oidc-start-react/server` to access the resolved session and core for the current request. Use `getAuth()` from `/functions` when a loader or component only needs the user.
