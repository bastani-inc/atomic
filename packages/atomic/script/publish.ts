import { $ } from "bun";
import { existsSync } from "node:fs";
import { mkdir, writeFile, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { findRepoRoot } from "../src/lib/workspace-paths.ts";
import { TARGETS } from "./targets.ts";

const WORKSPACE_ROOT = findRepoRoot(import.meta.dir);
const CLI_PKG_ROOT = join(WORKSPACE_ROOT, "packages", "atomic");

export async function synthesizeWrapper(outDir: string, opts: { version: string }): Promise<void> {
  const { version } = opts;
  await mkdir(join(outDir, "bin"), { recursive: true });
  await copyFile(join(CLI_PKG_ROOT, "bin", "atomic"),             join(outDir, "bin", "atomic"));
  await copyFile(join(CLI_PKG_ROOT, "script", "postinstall.mjs"), join(outDir, "postinstall.mjs"));
  await copyFile(join(WORKSPACE_ROOT, "LICENSE"),                  join(outDir, "LICENSE"));
  await writeFile(join(outDir, "package.json"), JSON.stringify({
    name: "@bastani/atomic",
    version,
    description: "Configuration management CLI for coding agents",
    bin: { atomic: "./bin/atomic" },
    files: ["bin", "postinstall.mjs", "LICENSE"],
    scripts: { postinstall: "node ./postinstall.mjs" },
    optionalDependencies: Object.fromEntries(
      TARGETS.map((t) => [`@bastani/atomic-${t.name}`, version]),
    ),
    engines: { node: ">=20" },
    license: "MIT",
  }, null, 2) + "\n");
}

if (import.meta.main) {
  const version = (await Bun.file(join(WORKSPACE_ROOT, "package.json")).json()).version;
  const tag = process.env.NPM_TAG ?? (version.includes("-") ? "next" : "latest");

  // `NPM_REGISTRY` is set by the validate workflow to point at a throwaway
  // verdaccio. In that mode we skip --provenance (OIDC-only), pass the
  // override registry, and tolerate missing per-platform dist dirs (the
  // PR-time validate job only builds the host target).
  const registry = process.env.NPM_REGISTRY;
  const extraArgs: string[] = [];
  if (registry) extraArgs.push(`--registry=${registry}`);
  if (process.env.GITHUB_ACTIONS === "true" && !registry) extraArgs.push("--provenance");

  // 1. Synthesize wrapper.
  const wrapperOut = join(CLI_PKG_ROOT, "dist", "wrapper");
  await synthesizeWrapper(wrapperOut, { version });

  // 2. Publish per-platform packages.
  for (const t of TARGETS) {
    const distDir = join(CLI_PKG_ROOT, "dist", t.name);
    if (!existsSync(distDir)) {
      if (registry) {
        console.log(`[publish] skipping ${t.name} — dist dir missing (validate mode)`);
        continue;
      }
      throw new Error(`[publish] missing dist dir for ${t.name}: ${distDir}`);
    }
    await $`cd ${distDir} && npm publish --access public --tag ${tag} ${extraArgs}`;
  }

  // 3. Publish wrapper.
  await $`cd ${wrapperOut} && npm publish --access public --tag ${tag} ${extraArgs}`;
}
