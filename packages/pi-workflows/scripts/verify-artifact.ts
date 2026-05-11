/**
 * Artifact verifier for pi-workflows dist output.
 * Checks that every path declared in package.json (main, types, exports, pi.extensions)
 * exists on disk. Exits non-zero and prints missing paths if any are absent.
 */

import { existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, "..");

interface PackageJson {
  main?: string;
  types?: string;
  exports?: Record<string, { import?: string; types?: string }>;
  pi?: {
    extensions?: string[];
    [key: string]: unknown;
  };
}

const pkg: PackageJson = (await import(resolve(pkgRoot, "package.json"), {
  with: { type: "json" },
})).default;

const required: string[] = [];

if (pkg.main) required.push(pkg.main);
if (pkg.types) required.push(pkg.types);

if (pkg.exports) {
  for (const [, condition] of Object.entries(pkg.exports)) {
    if (condition.import) required.push(condition.import);
    if (condition.types) required.push(condition.types);
  }
}

if (pkg.pi?.extensions) {
  for (const ext of pkg.pi.extensions) {
    required.push(ext);
  }
}

const missing: string[] = [];
for (const rel of required) {
  const abs = resolve(pkgRoot, rel);
  if (!existsSync(abs)) {
    missing.push(rel);
  }
}

if (missing.length > 0) {
  console.error("artifact verification FAILED — missing declared paths:");
  for (const p of missing) {
    console.error(`  ${p}`);
  }
  process.exit(1);
}

console.log(`artifact verification OK — all ${required.length} declared paths present`);
