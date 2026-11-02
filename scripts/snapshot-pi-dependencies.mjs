#!/usr/bin/env node
// Records the dependency names that upstream pi declares in the manifests of
// the packages Atomic carries, for test/ci/dependabot-pi-sync-contract.test.ts.
// Run it on each pi sync, then align the ignore list in .github/dependabot.yml
// (see "Dependabot and the pi sync" in docs/ci.md):
//
//   git fetch pi main && node scripts/snapshot-pi-dependencies.mjs [ref]
//
// `ref` defaults to `pi/main`.

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** pi manifests whose packages Atomic carries: the root, ai, coding-agent and mcp. */
const CARRIED_MANIFESTS = [
	"package.json",
	"packages/ai/package.json",
	"packages/coding-agent/package.json",
	"packages/mcp/package.json",
];
const FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const ref = process.argv[2] ?? "pi/main";
const git = (...args) => execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();

const manifests = {};
for (const path of CARRIED_MANIFESTS) {
	const manifest = JSON.parse(git("show", `${ref}:${path}`));
	manifests[path] = [...new Set(FIELDS.flatMap((field) => Object.keys(manifest[field] ?? {})))].sort();
}
const snapshot = { source: "earendil-works/pi", commit: git("rev-parse", "--short=9", `${ref}^{commit}`), manifests };
const output = join(repoRoot, "test/fixtures/pi-carried-dependencies.json");
writeFileSync(output, `${JSON.stringify(snapshot, null, "\t")}\n`);
console.log(`wrote ${output} from ${ref} (${snapshot.commit})`);
