import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const root = fileURLToPath(new URL("../..", import.meta.url));
const buildScriptPath = join(root, "scripts/build-binaries.sh");

test("musl archive staging removes embedded-postgres binary leaves", () => {
	const buildScript = readFileSync(buildScriptPath, "utf8");
	const stagingBlock = buildScript.slice(
		buildScript.indexOf('cp -r "$runtime_deps_dir" "binaries/$platform/node_modules"'),
		buildScript.indexOf('atomic_native="$(atomic_native_filename "$platform")'),
	);

	assert.match(stagingBlock, /if \[\[ "\$platform" == linux-\*-musl \]\]; then/u);
	assert.match(stagingBlock, /rm -rf "binaries\/\$platform\/node_modules\/@embedded-postgres"/u);
	assert.doesNotMatch(stagingBlock, /rm -rf "binaries\/\$platform\/node_modules\/embedded-postgres"/u);

	const syntax = spawnSync("bash", ["-n", buildScriptPath], { encoding: "utf8" });
	assert.equal(syntax.status, 0, syntax.stderr);
});

test("x64 release binaries target Bun's baseline CPU runtime", () => {
	const buildScript = readFileSync(buildScriptPath, "utf8");
	const compilationLoopStart = 'for platform in "$' + '{PLATFORMS[@]}"; do';
	const compilationLoop = buildScript.slice(
		buildScript.indexOf(compilationLoopStart),
		buildScript.indexOf('echo "==> Copying runtime dependencies..."'),
	);

	assert.match(compilationLoop, /bun_target="bun-\$platform"/u);
	assert.match(compilationLoop, /\[\[ "\$platform" == \*-x64 \|\| "\$platform" == \*-x64-\* \]\]/u);
	assert.match(compilationLoop, /bun_target="\$\{bun_target\}-baseline"/u);
	assert.match(compilationLoop, /--target="\$bun_target"/u);
	assert.doesNotMatch(compilationLoop, /--target=bun-\$platform/u);

	const syntax = spawnSync("bash", ["-n", buildScriptPath], { encoding: "utf8" });
	assert.equal(syntax.status, 0, syntax.stderr);
});
