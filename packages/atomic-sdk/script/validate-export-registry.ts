#!/usr/bin/env bun
/**
 * validate-export-registry.ts
 *
 * Validates export-registry.json against two invariants:
 *   1. Schema validity (using export-registry.schema.json).
 *   2. Coverage parity — every subpath in package.json#exports appears
 *      in the registry exactly once, and no registry entry references a
 *      subpath absent from package.json#exports.
 *
 * Usage:
 *   bun run packages/atomic-sdk/script/validate-export-registry.ts
 *
 * Exit code 0 = all checks pass.
 * Exit code 1 = one or more violations printed to stderr.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const registry = JSON.parse(
  readFileSync(resolve(pkgDir, "export-registry.json"), "utf8"),
);
const schema = JSON.parse(
  readFileSync(resolve(pkgDir, "export-registry.schema.json"), "utf8"),
);
const pkg = JSON.parse(
  readFileSync(resolve(pkgDir, "package.json"), "utf8"),
);

let ok = true;

// ── 1. Schema validation ────────────────────────────────────────────────────
const ajv = new Ajv({ strict: false });
const valid = ajv.validate(schema, registry);
if (!valid) {
  console.error("❌ Schema validation failed:");
  for (const err of ajv.errors ?? []) {
    console.error(`   ${err.instancePath || "/"} ${err.message}`);
  }
  ok = false;
} else {
  console.log("✅ Schema valid.");
}

// ── 2. Coverage parity ──────────────────────────────────────────────────────
const pkgSubpaths = new Set<string>(Object.keys(pkg.exports ?? {}));
const registrySubpaths = new Map<string, number>();

for (const entry of registry.exports ?? []) {
  registrySubpaths.set(entry.subpath, (registrySubpaths.get(entry.subpath) ?? 0) + 1);
}

// Duplicates in registry
for (const [subpath, count] of registrySubpaths) {
  if (count > 1) {
    console.error(`❌ Subpath appears ${count} times in registry: "${subpath}"`);
    ok = false;
  }
}

// In package.json but missing from registry
for (const subpath of pkgSubpaths) {
  if (!registrySubpaths.has(subpath)) {
    console.error(`❌ Missing from registry: "${subpath}" (present in package.json#exports)`);
    ok = false;
  }
}

// In registry but not in package.json
for (const subpath of registrySubpaths.keys()) {
  if (!pkgSubpaths.has(subpath)) {
    console.error(`❌ Stale registry entry: "${subpath}" (not in package.json#exports)`);
    ok = false;
  }
}

if (ok) {
  const counts: Record<string, number> = {};
  for (const entry of registry.exports ?? []) {
    counts[entry.classification] = (counts[entry.classification] ?? 0) + 1;
  }
  console.log("✅ Coverage parity OK — all", pkgSubpaths.size, "subpaths covered.");
  console.log("   Classification counts:", JSON.stringify(counts));
  const uncertain = (registry.exports ?? []).filter((e: { uncertain?: boolean }) => e.uncertain);
  if (uncertain.length > 0) {
    console.log(
      `⚠️  ${uncertain.length} uncertain classification(s) flagged for review:`,
      uncertain.map((e: { subpath: string }) => e.subpath).join(", "),
    );
  }
}

process.exit(ok ? 0 : 1);
