#!/usr/bin/env bash
set -euo pipefail

archives=$(cd "${1:?Usage: bash scripts/check-packed-browser.sh TARBALL_DIRECTORY}" && pwd)
cd "$(dirname "$0")/.."
version=$(node -p "require('./packages/core/package.json').version")
consumer=$(mktemp -d)
trap 'rm -rf "$consumer"' EXIT
example=examples/tanstack-start
mkdir -p "$consumer/$example" "$consumer/vendor"
cp tsconfig.base.json pnpm-workspace.yaml pnpm-lock.yaml "$consumer/"
cp -R "$example"/{src,e2e,package.json,tsconfig.json,vite.config.ts,check-client-bundle.ts,csrf.test.mjs,playwright.config.mjs} "$consumer/$example/"
for part in core react; do
  cp "$archives/lpshanley-oidc-start-$part-$version.tgz" "$consumer/vendor/$part.tgz"
done

# This workspace contains only the consumer. Resolve its public packages, including
# the adapter's dependency on core, to the release archives instead of source links.
cat >> "$consumer/pnpm-workspace.yaml" <<'YAML'

overrides:
  '@lpshanley/oidc-start-core': 'file:./vendor/core.tgz'
  '@lpshanley/oidc-start-react': 'file:./vendor/react.tgz'
YAML
cd "$consumer/$example"
pnpm install --no-frozen-lockfile --prefer-offline
pnpm build
pnpm exec playwright test
