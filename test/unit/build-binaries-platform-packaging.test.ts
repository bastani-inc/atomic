import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import {
	readPortableExecutableMachine,
	WINDOWS_BYTECODE_PROBE_BUN_VERSION,
	WINDOWS_BYTECODE_PROBE_TARGETS,
	windowsBytecodeCompileArgs,
} from "../../scripts/probe-windows-bytecode.ts";
import { spawnSyncCollect } from "../helpers/runtime.ts";

const root = fileURLToPath(new URL("../..", import.meta.url));
const buildScriptPath = join(root, "scripts/build-binaries.sh");
const packageManifestPath = join(root, "packages/coding-agent/package.json");

function sharedAppBuildCommand(source: string): string {
	const command = source
		.split(/&&|\r?\n/u)
		.find((candidate) => candidate.includes("bun build") && candidate.includes("dist/bun/cli.js"));
	assert.ok(command, "missing shared app bundle command");
	return command;
}

const BUN_TARGETS = {
	"darwin-arm64": { bytecode: true, target: "bun-darwin-arm64" },
	"darwin-x64": { bytecode: true, target: "bun-darwin-x64-baseline" },
	"linux-x64": { bytecode: true, target: "bun-linux-x64-baseline" },
	"linux-arm64": { bytecode: true, target: "bun-linux-arm64" },
	"linux-x64-musl": { bytecode: true, target: "bun-linux-x64-musl-baseline" },
	"linux-arm64-musl": { bytecode: true, target: "bun-linux-arm64-musl" },
	"windows-x64": { bytecode: true, target: "bun-windows-x64-baseline" },
	"windows-arm64": { bytecode: true, target: "bun-windows-arm64" },
} as const;

function assertBuildScriptSyntax(): void {
	const syntax = spawnSyncCollect(["bash", "-n", buildScriptPath]);
	assert.equal(syntax.exitCode, 0, syntax.stderr.toString());
}

function getCompilationLoop(buildScript: string): string {
	const startMarker = 'for platform in "$' + '{PLATFORMS[@]}"; do';
	const endMarker = 'echo "==> Copying runtime dependencies..."';
	const start = buildScript.indexOf(startMarker);
	const end = buildScript.indexOf(endMarker);
	assert.notEqual(start, -1, "build script must compile each selected platform");
	assert.notEqual(end, -1, "build script must finish the compilation loop before staging dependencies");
	return buildScript.slice(start, end);
}

test("every compiled target shares the syntax-minified application sidecar", () => {
	const buildScript = readFileSync(buildScriptPath, "utf8");
	const manifest = JSON.parse(readFileSync(packageManifestPath, "utf8")) as { scripts: Record<string, string> };
	const packageBuild = sharedAppBuildCommand(manifest.scripts["build:binary"] ?? "");
	const releaseBuild = sharedAppBuildCommand(buildScript);

	for (const [site, command] of [
		["packages/coding-agent/package.json build:binary", packageBuild],
		["scripts/build-binaries.sh", releaseBuild],
	] as const) {
		assert.match(command, /(?:^|\s)--minify-syntax(?:\s|$)/u, `${site} must syntax-minify the shared app`);
		assert.doesNotMatch(command, /(?:^|\s)--minify-identifiers(?:\s|$)/u, `${site} must preserve identifiers`);
	}

	assertBuildScriptSyntax();
});

test("musl archive staging removes embedded-postgres binary leaves", () => {
	const buildScript = readFileSync(buildScriptPath, "utf8");
	const stagingBlock = buildScript.slice(
		buildScript.indexOf('cp -r "$runtime_deps_dir" "binaries/$platform/node_modules"'),
		buildScript.indexOf('atomic_native="$(atomic_native_filename "$platform")'),
	);

	assert.match(stagingBlock, /if \[\[ "\$platform" == linux-\*-musl \]\]; then/u);
	assert.match(stagingBlock, /rm -rf "binaries\/\$platform\/node_modules\/@embedded-postgres"/u);
	assert.doesNotMatch(stagingBlock, /rm -rf "binaries\/\$platform\/node_modules\/embedded-postgres"/u);
	assertBuildScriptSyntax();
});

test("x64 release binaries target Bun's baseline CPU runtime", () => {
	const buildScript = readFileSync(buildScriptPath, "utf8");
	const platformsMatch = buildScript.match(/PLATFORMS=\(darwin-arm64[^)]*\)/u);
	if (!platformsMatch) throw new Error("build script must declare its complete default platform list");
	const defaultPlatforms = platformsMatch[0].slice("PLATFORMS=(".length, -1).trim().split(/\s+/u);
	assert.deepEqual(defaultPlatforms, Object.keys(BUN_TARGETS));

	const tempDir = mkdtempSync(join(tmpdir(), "atomic-build-targets-"));
	try {
		const callsPath = join(tempDir, "bun-calls.txt");
		const harness = [
			'bun() { printf "%s\\n" "$*" >> "$BUN_CALLS"; }',
			`PLATFORMS=(${defaultPlatforms.join(" ")})`,
			getCompilationLoop(buildScript),
		].join("\n");
		const run = spawnSyncCollect(["bash", "-c", harness], {
			cwd: tempDir,
			env: { ...process.env, BUN_CALLS: callsPath },
		});
		assert.equal(run.exitCode, 0, run.stderr.toString());

		const calls = readFileSync(callsPath, "utf8").trim().split("\n");
		assert.equal(calls.length, Object.keys(BUN_TARGETS).length);
		for (const [platform, { bytecode, target }] of Object.entries(BUN_TARGETS)) {
			const binaryName = platform.startsWith("windows-") ? "atomic.exe" : "atomic";
			const compile = calls.find((call) => call.includes(`--outfile binaries/${platform}/${binaryName}`));
			assert.ok(compile, `missing Bun compile command for ${platform}`);
			assert.match(compile, new RegExp(`(?:^|\\s)--target=${target}(?:\\s|$)`, "u"));
			assert.equal(compile.includes("--bytecode"), bytecode, `${platform} bytecode selection`);
		}
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}

	assertBuildScriptSyntax();
});

test("the pinned Windows bytecode probe covers the enabled x64 and ARM64 release policy", () => {
	assert.equal(WINDOWS_BYTECODE_PROBE_BUN_VERSION, "1.4.0");
	assert.deepEqual(
		WINDOWS_BYTECODE_PROBE_TARGETS.map(({ platform, target, machine }) => ({ platform, target, machine })),
		[
			{ platform: "windows-x64", target: "bun-windows-x64-baseline", machine: 0x8664 },
			{ platform: "windows-arm64", target: "bun-windows-arm64", machine: 0xaa64 },
		],
	);
	for (const spec of WINDOWS_BYTECODE_PROBE_TARGETS) {
		const args = windowsBytecodeCompileArgs(spec.target, "split-loader.js", `atomic-${spec.platform}.exe`);
		assert.deepEqual(args.slice(0, 3), ["build", "--compile", "--bytecode"]);
		assert.ok(args.includes(`--target=${spec.target}`));
		assert.ok(args.includes("--no-compile-autoload-dotenv"));
		assert.ok(args.includes("--no-compile-autoload-bunfig"));
	}

	const tempDir = mkdtempSync(join(tmpdir(), "atomic-bytecode-pe-"));
	try {
		const path = join(tempDir, "probe.exe");
		const pe = Buffer.alloc(0x88);
		pe.write("MZ", 0, "ascii");
		pe.writeUInt32LE(0x80, 0x3c);
		pe.write("PE\0\0", 0x80, "ascii");
		pe.writeUInt16LE(0xaa64, 0x84);
		writeFileSync(path, pe);
		assert.equal(readPortableExecutableMachine(path), 0xaa64);
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}

	assert.equal(BUN_TARGETS["windows-x64"].bytecode, true);
	assert.equal(BUN_TARGETS["windows-arm64"].bytecode, true);
});

test("tagged payload builds do not fetch unpublished natives and re-alias pi-ai after restore", () => {
	const buildScript = readFileSync(buildScriptPath, "utf8");

	assert.match(
		buildScript,
		/Skipping registry install of @bastani\/atomic-natives-\*: local native artifacts are already staged/u,
	);
	assert.match(buildScript, /packages\/natives\/native\/\*\.node/u);
	assert.match(
		buildScript,
		/^alias_pi_ai\(\) \{\n\s+echo "==> Aliasing @earendil-works\/pi-ai onto packages\/ai\.\.\."\n\s+node scripts\/alias-pi-ai\.mjs\n\}$/mu,
	);

	const restoreStart = buildScript.indexOf("Cross-platform bindings unavailable; restoring the dependency tree");
	assert.notEqual(restoreStart, -1, "failed registry install must restore node_modules");
	const restoreBlock = buildScript.slice(restoreStart, restoreStart + 400);
	assert.match(restoreBlock, /npm ci --ignore-scripts/u);
	assert.match(restoreBlock, /alias_pi_ai/u);
	assert.match(restoreBlock, /build_pi_ai/u);

	assertBuildScriptSyntax();
});
