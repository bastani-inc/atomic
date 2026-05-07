/**
 * Atomic CLI binary build.
 *
 * Mirrors OpenCode's build pipeline (`packages/opencode/script/build.ts`):
 *
 *  1. **Pre-install all platform variants of OpenTUI's native bindings.**
 *     `@opentui/core` resolves its FFI library via
 *     `await import(`@opentui/core-${platform}-${arch}/index.ts`)` —
 *     a dynamic platform import that Bun's compiler can only inline if
 *     the matching `@opentui/core-<plat>-<arch>` package is already
 *     present in `node_modules` at build time. `bun install --os="*" --cpu="*"`
 *     forces every variant in so cross-compile builds for non-host
 *     platforms succeed.
 *
 *  2. **`bun build --compile --target=bun-<os>-<arch>` per target.**
 *     Shells out via `Bun.spawnSync` rather than calling `Bun.build({ compile })`
 *     directly because the programmatic compile API on Windows produces
 *     binaries where `import.meta.main` is `false` at the entrypoint —
 *     which silently no-ops the `if (import.meta.main) { await main() }`
 *     gate in `cli.ts`, leaving `atomic.exe` running but never parsing
 *     argv. The CLI form sets it correctly on every platform. The
 *     `--target` flag still tells Bun which platform binaries to embed,
 *     so cross-compile semantics are unchanged.
 *
 * Embedded asset tarballs (`.claude.tar`, `.opencode.tar`,
 * `.github.tar`, `.agents/skills.tar`) are emitted before the build loop
 * by `bundleEmbeddedAssets`. There are no longer any pre-bundled
 * runtime-script `.script.js` files — both `_orchestrator-entry` and
 * `_cc-debounce` live as hidden CLI sub-commands routed through
 * `cli.ts`, so a single `Bun.build` call per target compiles
 * everything.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { $ } from "bun";
import { findRepoRoot } from "../src/lib/workspace-paths.ts";
import { TARGETS, hostTarget, type BuildTarget } from "./targets.ts";
import { bundleEmbeddedAssets } from "./build-assets.ts";

const WORKSPACE_ROOT = findRepoRoot(import.meta.dir);
const CLI_PKG_ROOT = join(WORKSPACE_ROOT, "packages", "atomic");

function selectTargets(arg: string | undefined): readonly BuildTarget[] {
  if (arg === "--all") return TARGETS;
  const name = arg ?? hostTarget();
  return TARGETS.filter((t) => t.name === name);
}

await bundleEmbeddedAssets(WORKSPACE_ROOT);

const arg = process.argv[2];
const requested = selectTargets(arg);

if (requested.length === 0) {
  console.error(
    `build: unknown target "${arg}". Use --all or one of: ${TARGETS.map((t) => t.name).join(", ")}`,
  );
  process.exit(1);
}

const rootPkg = await Bun.file(join(WORKSPACE_ROOT, "package.json")).json();
const version = rootPkg.version;
const repository = rootPkg.repository;
const opentuiCoreSpec: string = rootPkg.devDependencies?.["@opentui/core"]
  ?? rootPkg.dependencies?.["@opentui/core"]
  ?? "*";

// Force every `@opentui/core-<os>-<arch>` variant into node_modules so
// cross-compile builds for non-host platforms can find their native
// binding. Mirrors OpenCode's pre-install step. Skipped when only one
// host-platform target is requested (the host's variant is already
// installed by `bun install`).
const buildingForOtherPlatform = requested.some(
  (t) => t.bunTarget !== `bun-${hostTarget()}`,
);
if (buildingForOtherPlatform) {
  await $`bun install --os="*" --cpu="*" @opentui/core@${opentuiCoreSpec}`.cwd(WORKSPACE_ROOT);
}

// Allow tests to redirect output to an isolated dir so concurrent test
// files don't fight over `dist/` file locks (Windows holds the binary
// open while another test spawns it; rm-then-rebuild then races EACCES).
const DIST_BASE =
  process.env.ATOMIC_BUILD_DIST_DIR ?? join(CLI_PKG_ROOT, "dist");

for (const t of requested) {
  const outdir = join(DIST_BASE, t.name);
  await mkdir(join(outdir, "bin"), { recursive: true });

  const outfile = join(outdir, "bin", `atomic${t.ext ?? ""}`);
  const result = Bun.spawnSync({
    cmd: [
      process.execPath, "build", "--compile", "--minify",
      "--target", t.bunTarget,
      "--outfile", outfile,
      join(CLI_PKG_ROOT, "src", "cli.ts"),
    ],
    stdio: ["inherit", "inherit", "inherit"],
    cwd: WORKSPACE_ROOT,
  });
  if (!result.success) {
    process.exit(result.exitCode ?? 1);
  }

  await writeFile(join(outdir, "package.json"), JSON.stringify({
    name: `@bastani/atomic-${t.name}`,
    version,
    // npm provenance verification compares package.json `repository.url`
    // against the workflow's source repo and rejects mismatches (or empty
    // values) with E422. Must be present on every published package.
    repository,
    os: [t.os],
    cpu: [t.cpu],
    // `libc` discriminates Linux glibc/musl variants. Omitted on darwin/windows
    // where it has no meaning. Without this, npm picks any matching os/cpu
    // package on Alpine and crashes at runtime on `libc.so.6` lookup.
    ...(t.libc ? { libc: [t.libc] } : {}),
    files: ["bin"],
    license: "MIT",
  }, null, 2) + "\n");
}
