import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const [mode, tag, directory, selected] = process.argv.slice(2);
assert.ok(["check", "stage"].includes(mode) && tag && directory,
	"Usage: node scripts/npm-release.mjs <check|stage> <[scim-core-]vX.Y.Z[-next.N]> <tarball-directory> [core|react|scim-core]");
// A vX.Y.Z tag releases the OIDC pair, which share a version. scim-core has its own version and tag.
const release = /^(scim-core-)?v((0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-next\.(0|[1-9]\d*))?)$/.exec(tag);
assert.ok(release, `Unrecognized release tag ${tag}`);
const version = release[2];
const parts = release[1]
	? [{ part: "scim-core", name: "@lpshanley/scim-core" }]
	: ["core", "react"].map((part) => ({ part, name: `@lpshanley/oidc-start-${part}` }));
if (mode === "stage") assert.ok(parts.some(({ part }) => part === selected), "Select one package of this tag to stage");
const distTag = version.includes("-next.") ? "next" : "latest";
const registry = "https://registry.npmjs.org";
const license = readFileSync(new URL("../LICENSE", import.meta.url), "utf8");

// Inspect the archives that will be handed to npm, including pnpm's workspace substitution.
const packages = parts.map(({ part, name }) => {
	const file = resolve(directory, `${name.slice(1).replace("/", "-")}-${version}.tgz`);
	const manifest = JSON.parse(execFileSync("tar", ["-xOzf", file, "package/package.json"], { encoding: "utf8" }));
	assert.equal(manifest.name, name);
	assert.equal(manifest.version, version, `Release tag must match ${name}`);
	assert.equal(manifest.publishConfig?.access, "public");
	assert.equal(manifest.license, "MIT");
	assert.equal(execFileSync("tar", ["-xOzf", file, "package/LICENSE"], { encoding: "utf8" }), license);
	assert.equal(manifest.repository?.url, "git+https://github.com/lpshanley/oidc-start.git");
	assert.equal(manifest.repository.directory, `packages/${part}`);
	if (part === "react") assert.equal(manifest.dependencies["@lpshanley/oidc-start-core"], version);
	const integrity = "sha512-" + createHash("sha512").update(readFileSync(file)).digest("base64");
	console.log(`${name}@${version} (${distTag}) ${integrity}`);
	return { part, name, file, integrity };
});

if (mode === "stage") {
	// Every archive of the tag must match it. Each CI job stages one so failed jobs
	// can retry without submitting a sibling that is already awaiting approval.
	let archive;
	for (const pkg of packages) {
		const response = await fetch(`${registry}/${encodeURIComponent(pkg.name)}/${version}`);
		if (response.status === 404) {
			if (pkg.part === selected) archive = pkg.file;
			continue;
		}
		if (!response.ok) throw new Error(`Registry lookup for ${pkg.name} returned HTTP ${response.status}`);
		const published = await response.json();
		assert.equal(published.dist?.integrity, pkg.integrity, `${pkg.name}@${version} already exists with different bytes`);
		console.log(`Already published: ${pkg.name}@${version}`);
	}
	if (archive) {
		execFileSync("npm", [
			"stage", "publish", archive, "--registry", registry,
			"--access", "public", "--tag", distTag, "--ignore-scripts",
		], { stdio: "inherit" });
	}
}
