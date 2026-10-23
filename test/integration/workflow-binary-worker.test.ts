import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "vitest";
import {
	bunExecutable,
	copyFileSync,
	makeDirectorySync,
	makeTempDirectory,
	moduleDir,
	removeTempDirectory,
	spawnSyncCollect,
} from "../helpers/runtime.js";

const repoRoot = resolve(moduleDir(import.meta.url), "../..");
const packageDir = join(repoRoot, "packages", "coding-agent");
const workerEntry = join(packageDir, "dist", "builtin", "workflows", "src", "local-worker-entry.mjs");
const natives = join(repoRoot, "packages", "natives");
const NATIVE_LAUNCHER_TIMEOUT_MS = 120_000;

const requireBuild = process.env.ATOMIC_REQUIRE_INSTALLED_NODE_SMOKE === "1";
const ready = existsSync(workerEntry) && existsSync(join(natives, "native", "index.js"));
if (requireBuild) assert.ok(ready, "built workflows package and natives are required for the binary worker test");
const binaryTest = ready ? test.skipIf(process.platform === "win32") : test.skip;

function compile(args: string[]): void {
	const result = spawnSyncCollect([bunExecutable(), "build", ...args], { cwd: packageDir });
	assert.equal(result.exitCode, 0, result.stderr.toString());
}

function stageLauncher(root: string): { launcher: string; journal: string } {
	const launcher = join(root, "atomic");
	compile([
		"--compile",
		"--bytecode",
		"--format=cjs",
		"--external",
		"mupdf",
		"--no-compile-autoload-dotenv",
		"--no-compile-autoload-bunfig",
		"src/bun/split-loader.ts",
		"--outfile",
		launcher,
	]);
	compile([
		"--target=bun",
		"--format=cjs",
		"--external",
		"mupdf",
		"--external=*native-modifiers.js",
		"src/bun/cli.ts",
		"--outfile",
		join(root, "app.js"),
	]);
	for (const file of ["native-modifiers", "native-module-path", "native-platform"])
		copyFileSync(
			join(repoRoot, "node_modules", "@earendil-works", "pi-tui", "dist", `${file}.js`),
			join(root, `${file}.js`),
		);
	const entryDir = join(root, "builtin", "workflows", "src");
	makeDirectorySync(entryDir, { recursive: true });
	copyFileSync(workerEntry, join(entryDir, "local-worker-entry.mjs"));
	const nativeDir = join(root, "node_modules", "@bastani", "atomic-natives", "native");
	makeDirectorySync(nativeDir, { recursive: true });
	copyFileSync(join(natives, "package.json"), join(nativeDir, "..", "package.json"));
	for (const file of ["index.js", "index.d.ts", ...nativeBindings()])
		copyFileSync(join(natives, "native", file), join(nativeDir, file));
	return { launcher, journal: join(root, "journal.sqlite") };
}

function nativeBindings(): string[] {
	return existsSync(join(natives, "native"))
		? spawnSyncCollect(["ls", join(natives, "native")])
				.stdout.toString()
				.split("\n")
				.filter((name) => name.endsWith(".node"))
		: [];
}

binaryTest(
	"a compiled launcher serves the packaged worker entry over IPC and refuses misuse (#3869)",
	() => {
		const root = makeTempDirectory("binary-worker-");
		try {
			const { launcher, journal } = stageLauncher(root);
			const parent = join(root, "parent");
			compile(["--compile", join(repoRoot, "test", "fixtures", "binary-worker-parent.ts"), "--outfile", parent]);
			const forked = spawnSyncCollect([parent, launcher, journal], { timeout: NATIVE_LAUNCHER_TIMEOUT_MS });
			assert.equal(forked.exitCode, 0, forked.stderr.toString());
			assert.match(forked.stdout.toString(), /worker ready/u);
			const withoutIpc = spawnSyncCollect([launcher, "--internal-workflow-worker", "{}"], {
				timeout: NATIVE_LAUNCHER_TIMEOUT_MS,
			});
			assert.notEqual(withoutIpc.exitCode, 0);
			assert.match(withoutIpc.stderr.toString(), /requires an IPC channel/u);
			const extraArgument = spawnSyncCollect([launcher, "--internal-workflow-worker", "{}", "/tmp/other.mjs"], {
				timeout: NATIVE_LAUNCHER_TIMEOUT_MS,
			});
			assert.notEqual(extraArgument.exitCode, 0);
			assert.match(extraArgument.stderr.toString(), /exactly one JSON argument/u);
		} finally {
			removeTempDirectory(root);
		}
	},
	NATIVE_LAUNCHER_TIMEOUT_MS * 3,
);
