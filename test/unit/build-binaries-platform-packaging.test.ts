import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { spawnSyncCollect } from "../helpers/runtime.ts";

const root = fileURLToPath(new URL("../..", import.meta.url));
const buildScriptPath = join(root, "scripts/build-binaries.sh");

const BUN_TARGETS = {
	"darwin-arm64": { bytecode: true, target: "bun-darwin-arm64" },
	"darwin-x64": { bytecode: true, target: "bun-darwin-x64-baseline" },
	"linux-x64": { bytecode: true, target: "bun-linux-x64-baseline" },
	"linux-arm64": { bytecode: true, target: "bun-linux-arm64" },
	"linux-x64-musl": { bytecode: true, target: "bun-linux-x64-musl-baseline" },
	"linux-arm64-musl": { bytecode: true, target: "bun-linux-arm64-musl" },
	"windows-x64": { bytecode: false, target: "bun-windows-x64-baseline" },
	"windows-arm64": { bytecode: false, target: "bun-windows-arm64" },
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
