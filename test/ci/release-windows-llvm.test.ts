import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { jobBlock, jobSteps, namedStep, readText, stepIndex } from "./workflow-text.js";

const root = fileURLToPath(new URL("../..", import.meta.url));

test("Windows release builds verify installed LLVM before cargo-xwin without apt", async () => {
	const workflow = await readText(`${root}/.github/workflows/publish.yml`);
	const native = jobBlock(workflow, "native-artifacts", "linux-binary-smoke");
	const steps = jobSteps(native);
	const setup = namedStep(steps, "Select installed Windows cross-compile tooling");
	assert.match(setup, /if: matrix\.platform == 'win32'/u);
	assert.match(setup, /timeout-minutes: 1/u);
	assert.match(setup, /shell: bash/u);
	assert.match(setup, /set -euo pipefail/u);
	assert.match(setup, /llvm_bin=\/usr\/lib\/llvm-18\/bin/u);
	assert.match(setup, /for tool in clang clang-cl lld-link llvm-ar llvm-lib llvm-dlltool llvm-ml; do/u);
	assert.match(setup, /test -x "\$llvm_bin\/\$tool" \|\| \{[^\n]*exit 1; \}/u);
	assert.match(setup, /"\$llvm_bin\/clang" --version/u);
	assert.match(setup, /"\$llvm_bin\/lld-link" --version/u);
	assert.match(setup, /echo "\$llvm_bin" >> "\$GITHUB_PATH"/u);
	assert.doesNotMatch(native, /apt-get|install-llvm-action/u);
	assert.ok(
		stepIndex(steps, "Select installed Windows cross-compile tooling") < stepIndex(steps, "Install cargo-xwin"),
	);
	// alpha.4 failed twice downloading apt metapackages before either native compile.
	// Both target architectures must use the same x64 Ubuntu host toolchain.
	for (const arch of ["x64", "arm64"]) {
		assert.ok(native.includes(`runner: nscloud-ubuntu-24.04-amd64-4x16, platform: win32, arch: ${arch},`));
	}
});

test("musl smoke and payload jobs verify preinstalled patchelf without apt", async () => {
	const workflow = await readText(`${root}/.github/workflows/publish.yml`);
	for (const [job, next] of [
		["alpine-binary-smoke", "build"],
		["build", "stage-github-release"],
	]) {
		const steps = jobSteps(jobBlock(workflow, job, next));
		const setup = namedStep(steps, "Verify installed musl archive tooling");
		assert.match(setup, /timeout-minutes: 1/u);
		assert.match(setup, /shell: bash/u);
		assert.match(setup, /set -euo pipefail/u);
		assert.match(setup, /command -v patchelf/u);
		assert.match(setup, /patchelf --version/u);
		const build = job === "build" ? "Build release archives" : "Build Linux musl archive";
		assert.ok(stepIndex(steps, "Verify installed musl archive tooling") < stepIndex(steps, build));
	}
	assert.doesNotMatch(workflow, /apt-get/u);
});
