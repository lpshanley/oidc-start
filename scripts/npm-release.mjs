import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const [mode, tag, directory] = process.argv.slice(2);
assert.ok(["check", "publish"].includes(mode) && tag && directory,
	"Usage: node scripts/npm-release.mjs <check|publish> <vX.Y.Z[-next.N]> <tarball-directory>");
assert.match(tag, /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-next\.(0|[1-9]\d*))?$/);
const version = tag.slice(1);
const distTag = version.includes("-next.") ? "next" : "latest";
const registry = "https://registry.npmjs.org";

// Inspect the archives that will be handed to npm, including pnpm's workspace substitution.
const packages = ["core", "react"].map((part) => {
	const name = `@lpshanley/oidc-start-${part}`;
	const file = resolve(directory, `lpshanley-oidc-start-${part}-${version}.tgz`);
	const manifest = JSON.parse(execFileSync("tar", ["-xOzf", file, "package/package.json"], { encoding: "utf8" }));
	assert.equal(manifest.name, name);
	assert.equal(manifest.version, version, `Release tag must match ${name}`);
	assert.equal(manifest.publishConfig?.access, "public");
	assert.equal(manifest.repository?.url, "git+https://github.com/lpshanley/oidc-start.git");
	assert.equal(manifest.repository.directory, `packages/${part}`);
	if (part === "react") assert.equal(manifest.dependencies["@lpshanley/oidc-start-core"], version);
	const integrity = "sha512-" + createHash("sha512").update(readFileSync(file)).digest("base64");
	console.log(`${name}@${version} (${distTag}) ${integrity}`);
	return { name, file, integrity };
});

if (mode === "publish") {
	// Check both before publishing either. On retry, skip only byte-identical versions.
	const remaining = [];
	for (const pkg of packages) {
		const response = await fetch(`${registry}/${encodeURIComponent(pkg.name)}/${version}`);
		if (response.status === 404) {
			remaining.push(pkg);
			continue;
		}
		if (!response.ok) throw new Error(`Registry lookup for ${pkg.name} returned HTTP ${response.status}`);
		const published = await response.json();
		assert.equal(published.dist?.integrity, pkg.integrity, `${pkg.name}@${version} already exists with different bytes`);
		console.log(`Already published: ${pkg.name}@${version}`);
	}
	for (const { file } of remaining) {
		execFileSync("npm", ["publish", file, "--registry", registry, "--access", "public", "--tag", distTag, "--ignore-scripts"], { stdio: "inherit" });
	}
}
