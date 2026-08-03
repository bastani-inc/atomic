import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { bunExecutable, readJson, spawnSyncCollect } from "../helpers/runtime.js";
import { readText } from "./workflow-text.js";

type NativeManifest = {
	name: string;
	version: string;
	optionalDependencies?: Record<string, string>;
};

const root = fileURLToPath(new URL("../..", import.meta.url));
const packageVersion = "1.2.3-alpha.1";
const nativePackageNames = [
	"@bastani/atomic-natives-darwin-arm64",
	"@bastani/atomic-natives-darwin-x64",
	"@bastani/atomic-natives-linux-arm64-gnu",
	"@bastani/atomic-natives-linux-arm64-musl",
	"@bastani/atomic-natives-linux-x64-gnu",
	"@bastani/atomic-natives-linux-x64-musl",
	"@bastani/atomic-natives-win32-arm64-msvc",
	"@bastani/atomic-natives-win32-x64-msvc",
] as const;

const nativeBinaryNames = [
	"atomic_natives.darwin-arm64.node",
	"atomic_natives.darwin-x64.node",
	"atomic_natives.linux-arm64-gnu.node",
	"atomic_natives.linux-arm64-musl.node",
	"atomic_natives.linux-x64-gnu.node",
	"atomic_natives.linux-x64-musl.node",
	"atomic_natives.win32-arm64-msvc.node",
	"atomic_natives.win32-x64-msvc.node",
] as const;

test("prepared native root tarball contains all eight exact-version optional dependencies", async () => {
	const stage = mkdtempSync(join(tmpdir(), "atomic-native-release-contract-"));
	const nativeDir = join(stage, "native");
	const outputDir = join(stage, "packed");
	const version = packageVersion;
	try {
		mkdirSync(nativeDir);
		mkdirSync(outputDir);
		for (const file of ["README.md", "CHANGELOG.md"]) {
			copyFileSync(join(root, "packages/natives", file), join(stage, file));
		}
		for (const file of ["index.js", "index.d.ts"]) {
			copyFileSync(join(root, "packages/natives/native", file), join(nativeDir, file));
		}
		const sourceManifest = (await readJson(join(root, "packages/natives/package.json"))) as NativeManifest;
		writeFileSync(join(stage, "package.json"), `${JSON.stringify({ ...sourceManifest, version }, null, 2)}\n`);
		for (const file of nativeBinaryNames) writeFileSync(join(nativeDir, file), "fixture");

		// The publish pipeline runs `bun run --cwd packages/natives <script>`, which
		// resolves bins from packages/natives/node_modules/.bin first. Since the
		// @napi-rs/cli 3.8.1 bump npm nests the CLI there instead of hoisting it to
		// the root .bin, so this staged copy needs the same lookup order.
		const toolPath = [
			join(root, "packages/natives/node_modules/.bin"),
			join(root, "node_modules/.bin"),
			process.env.PATH,
		]
			.filter(Boolean)
			.join(delimiter);
		const env = { ...process.env, PATH: toolPath };
		// Bun's `$` shell was the only import of the `bun` module in the suites. The
		// commands themselves are unchanged, including `bun pm pack`, which is what
		// the publish pipeline actually runs.
		const run = (command: string, args: string[]): void => {
			const result = spawnSyncCollect([command, ...args], { cwd: stage, env });
			assert.equal(result.exitCode, 0, `${command} ${args.join(" ")}\n${result.stderr.toString()}`);
		};
		const bun = bunExecutable();
		run(bun, ["run", "create-npm-dirs"]);
		run(bun, ["run", "artifacts"]);
		run(bun, ["run", "prepublish:native", "--", "--skip-optional-publish"]);
		run(bun, ["pm", "pack", "--destination", outputDir, "--quiet"]);

		const tarballs = readdirSync(outputDir).filter((file) => file.endsWith(".tgz"));
		assert.equal(tarballs.length, 1);
		const extracted = spawnSyncCollect([
			"tar",
			"-xOf",
			join(outputDir, tarballs[0] as string),
			"package/package.json",
		]);
		assert.equal(extracted.exitCode, 0, extracted.stderr.toString());
		const packedJson = extracted.stdout.toString();
		const packed = JSON.parse(packedJson) as NativeManifest;
		assert.equal(packed.name, "@bastani/atomic-natives");
		assert.equal(packed.version, version);
		assert.deepEqual(Object.keys(packed.optionalDependencies ?? {}).sort(), [...nativePackageNames].sort());
		for (const dependency of nativePackageNames) {
			assert.equal(packed.optionalDependencies?.[dependency], version, dependency);
		}
	} finally {
		rmSync(stage, { recursive: true, force: true });
	}
});

test("publish pipeline prepares exact native package set and publishes in dependency order", async () => {
	const workflow = await readText(`${root}/.github/workflows/publish.yml`);
	const expectedOrder = [...nativePackageNames, "@bastani/atomic-natives", "@bastani/atomic"].join(" ");
	assert.match(workflow, /prepublish:native -- --skip-optional-publish/u);
	assert.match(workflow, /Expected exactly ten npm packages/u);
	assert.match(workflow, /atomic-linux-x64-musl\.tar\.gz.*atomic-linux-arm64-musl\.tar\.gz/u);
	assert.ok(
		workflow.includes(`packages=(${expectedOrder})`),
		"npm packages must publish native leaves, native root, then coding agent",
	);
	assert.match(
		workflow,
		/npm view "\$name@\$VERSION" version[\s\S]*already exists; skipping[\s\S]*npm publish "\$\{tarballs\[\$name\]\}" --provenance/u,
	);
});
