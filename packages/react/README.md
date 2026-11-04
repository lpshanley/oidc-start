# @lpshanley/oidc-start-react

TanStack Start for React bindings for `@lpshanley/oidc-start-core`. Install alongside the application's React Start and React Router packages.

In a custom `src/start.ts`, register `createCsrfMiddleware({ filter: (ctx) => ctx.handlerType === 'serverFn' })` from `@tanstack/react-start` before `oidcMiddleware({ core: () => auth })` in `requestMiddleware`. This restores Start's same-origin check for browser RPCs. Here `auth` is the server-side core configured by the host. You can also read a core from the context supplied by earlier server middleware. In a file shared with the browser, load server-only composition inside the server boundary.

```ts
import { createFileRoute } from '@tanstack/react-router'
import { handleCallbackRoute } from '@lpshanley/oidc-start-react'

export const Route = createFileRoute('/auth/callback')({
  server: { handlers: { GET: handleCallbackRoute() } },
})
```

Register `handleSignInRoute()` on GET and `handleSignOutRoute()` and `handleBackchannelLogoutRoute()` on POST. Add `server.middleware: [createCsrfMiddleware()]` to the browser sign-out route as well. The provider posts signed tokens to the separate back-channel route without a browser Origin header, so leave that route outside the browser CSRF check.

Import `getAuth`, `getSignInUrl` and `signOut` from `@lpshanley/oidc-start-react/functions`. Use `getOidcContext` from `@lpshanley/oidc-start-react/server` inside server handlers. The adapter ships ESM with its server-function declarations intact for the consuming app's Start compiler.
