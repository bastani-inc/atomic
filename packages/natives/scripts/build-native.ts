import { copyFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(import.meta.dir, "../../..");
const packageRoot = resolve(import.meta.dir, "..");
const nativeDir = join(packageRoot, "native");
const rustManifestPath = join(repoRoot, "crates", "atomic-natives", "Cargo.toml");
const packageJsonPath = join(packageRoot, "package.json");
const debug = process.argv.includes("--debug");
const crossTarget = Bun.env.CROSS_TARGET;
const nativeTarget = Bun.env.NATIVE_TARGET;
const glibcTarget = crossTarget?.match(/^((?:x86_64|aarch64)-unknown-linux-gnu)\.([0-9]+\.[0-9]+)$/u);

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

if (glibcTarget) {
	const bareTarget = glibcTarget[1] as "x86_64-unknown-linux-gnu" | "aarch64-unknown-linux-gnu";
	const cargoArgs = ["zigbuild", "--manifest-path", rustManifestPath, "--target", crossTarget as string];
	if (!debug) cargoArgs.push("--release");
	const result = spawnSync("cargo", cargoArgs, { cwd: repoRoot, stdio: "inherit" });
	if (result.status !== 0) {
		throw new Error(`Failed to build portable Atomic native bindings (cargo zigbuild exited ${result.status ?? "null"})`);
	}
	const targetRoot = resolve(repoRoot, Bun.env.CARGO_TARGET_DIR ?? "target");
	const profile = debug ? "debug" : "release";
	const architecture = bareTarget.startsWith("x86_64") ? "x64" : "arm64";
	copyFileSync(
		join(targetRoot, bareTarget, profile, "libatomic_natives.so"),
		join(nativeDir, `atomic_natives.linux-${architecture}-gnu.node`),
	);
} else {
	if (!debug) args.push("--release");
	if (nativeTarget) args.push("--target", nativeTarget);
	if (crossTarget) args.push("--target", crossTarget, "--cross-compile");

	const result = spawnSync("bunx", args, { cwd: repoRoot, stdio: "inherit" });
	if (result.status !== 0) {
		throw new Error(`Failed to build Atomic native bindings (napi exited ${result.status ?? "null"})`);
	}
}
