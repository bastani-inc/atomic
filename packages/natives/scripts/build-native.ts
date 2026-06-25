import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(import.meta.dir, "../../..");
const packageRoot = resolve(import.meta.dir, "..");
const nativeDir = join(packageRoot, "native");
const rustManifestPath = join(repoRoot, "crates", "atomic-natives", "Cargo.toml");
const packageJsonPath = join(packageRoot, "package.json");
const debug = process.argv.includes("--debug");
const crossTarget = Bun.env.CROSS_TARGET;

mkdirSync(nativeDir, { recursive: true });

const args = [
	"--bun",
	"--no-install",
	"napi",
	"build",
	"--manifest-path",
	rustManifestPath,
	"--package-json-path",
	packageJsonPath,
	"--output-dir",
	nativeDir,
	"--platform",
	"--js",
	"index.js",
	"--dts",
	"index.d.ts",
];

if (!debug) args.push("--release");
if (crossTarget) args.push("--target", crossTarget, "--cross-compile");

const result = spawnSync("bunx", args, { cwd: repoRoot, stdio: "inherit" });
if (result.status !== 0) {
	throw new Error(`Failed to build Atomic native bindings (napi exited ${result.status ?? "null"})`);
}
