import { copyFileSync, mkdirSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
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

// npm does not hoist the `napi` bin to the repo root; it lands in this workspace's
// own node_modules/.bin. `npm run build` works because npm prepends every relevant
// .bin dir to PATH, but a direct `bun scripts/build-native.ts` does not get that,
// and `bunx --no-install` from the repo root then fails to find `napi`. Prepend the
// same .bin dirs here so both invocations work.
const binPaths = [join(packageRoot, "node_modules", ".bin"), join(repoRoot, "node_modules", ".bin")];
const buildEnv = { ...process.env, PATH: [...binPaths, process.env.PATH ?? ""].join(delimiter) };

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
	// Ambient const enums cannot be consumed by TypeScript isolatedModules users.
	// N-API string enums become literal unions under this flag.
	"--no-const-enum",
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

	const result = spawnSync("bunx", args, { cwd: repoRoot, stdio: "inherit", env: buildEnv });
	if (result.status !== 0) {
		throw new Error(`Failed to build Atomic native bindings (napi exited ${result.status ?? "null"})`);
	}
}
