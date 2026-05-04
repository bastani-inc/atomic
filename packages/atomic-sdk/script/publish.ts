import { $ } from "bun";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SDK_PKG_ROOT = fileURLToPath(new URL("..", import.meta.url));

await $`bun ${join(SDK_PKG_ROOT, "script/build.ts")}`;

const pkgPath = join(SDK_PKG_ROOT, "package.json");
const pkg = await Bun.file(pkgPath).json();

// Snapshot original exports for restore after publish (so dev still resolves to src/).
const originalExports = pkg.exports;
const rewritten: Record<string, { import: string; types: string }> = {};
for (const [key, src] of Object.entries(originalExports as Record<string, string>)) {
  const base = (src as string).replace(/^\.\/src\//, "./dist/").replace(/\.tsx?$/, "");
  rewritten[key] = { import: `${base}.js`, types: `${base}.d.ts` };
}
pkg.exports = rewritten;

await Bun.write(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

// Default prerelease versions to the `next` tag so `latest` is reserved for stable.
const defaultTag = (pkg.version as string).includes("-") ? "next" : "latest";
const tag = process.env.NPM_TAG ?? defaultTag;
// `NPM_REGISTRY` is set by the validate workflow to point at a throwaway
// verdaccio. In that mode we skip --provenance (OIDC-only) and pass the
// override registry explicitly.
const registry = process.env.NPM_REGISTRY;
const args = ["publish", "--access", "public", "--tag", tag];
if (registry) args.push("--registry", registry);
if (process.env.GITHUB_ACTIONS === "true" && !registry) args.push("--provenance");

try {
  const result = Bun.spawnSync(["npm", ...args], { cwd: SDK_PKG_ROOT, stdio: ["inherit", "inherit", "inherit"] });
  if (result.exitCode !== 0) process.exit(result.exitCode ?? 1);
} finally {
  // Always restore so dev checkouts keep resolving to src/.
  pkg.exports = originalExports;
  await Bun.write(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
}
