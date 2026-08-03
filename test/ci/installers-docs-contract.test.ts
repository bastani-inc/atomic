import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { readText } from "./workflow-text.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const shellOneLiner = "curl -fsSL https://raw.githubusercontent.com/bastani-inc/atomic/main/install.sh | sh";
const powershellOneLiner = "irm https://raw.githubusercontent.com/bastani-inc/atomic/main/install.ps1 | iex";
const pinnedPowerShell =
	"& ([scriptblock]::Create((irm https://raw.githubusercontent.com/bastani-inc/atomic/main/install.ps1))) -Ref 0.9.11";

test("installer documentation keeps the literal entry points, knobs, defaults, and platform limits", async () => {
	const paths = {
		readme: `${root}/README.md`,
		quickstart: `${root}/packages/coding-agent/docs/quickstart.md`,
		windows: `${root}/packages/coding-agent/docs/windows.md`,
		index: `${root}/packages/coding-agent/docs/index.md`,
		containerization: `${root}/packages/coding-agent/docs/containerization.md`,
		termux: `${root}/packages/coding-agent/docs/termux.md`,
	};
	const entries = await Promise.all(
		Object.entries(paths).map(async ([name, path]) => [name, await readText(path)] as const),
	);
	const docs = Object.fromEntries(entries) as Record<keyof typeof paths, string>;

	for (const name of ["readme", "quickstart", "index", "containerization"] as const) {
		assert.ok(docs[name].includes(shellOneLiner), `${name} is missing the literal shell one-liner`);
	}
	for (const name of ["readme", "quickstart", "windows", "index"] as const) {
		assert.ok(docs[name].includes(powershellOneLiner), `${name} is missing the literal PowerShell one-liner`);
	}
	for (const name of ["quickstart", "windows"] as const) {
		assert.ok(docs[name].includes(pinnedPowerShell), `${name} is missing the literal pinned PowerShell form`);
	}

	for (const knob of ["ATOMIC_INSTALL_DIR", "ATOMIC_BIN_DIR", "ATOMIC_VERSION", "GITHUB_TOKEN", "GH_TOKEN"]) {
		assert.ok(docs.quickstart.includes(knob), `quickstart is missing ${knob}`);
		assert.ok(docs.windows.includes(knob), `windows docs are missing ${knob}`);
	}
	assert.match(docs.quickstart, /~\/\.local\/share\/atomic/u);
	assert.match(docs.quickstart, /~\/\.local\/bin\/atomic/u);
	assert.match(docs.windows, /%LOCALAPPDATA%\\atomic\\bin/u);
	assert.match(docs.windows, /ASCII-only `atomic\.cmd` plus an `atomic-current` junction/u);
	assert.match(docs.quickstart, /remove `atomic\.cmd` and the `atomic-current` junction/u);
	assert.match(docs.quickstart, /does not require Node\.js|Node\.js and a package manager are not required/u);
	assert.match(docs.quickstart, /Package installs still require Node\.js/u);
	assert.match(docs.quickstart, /bundle payload-local `libgcc` and `libstdc\+\+`/u);
	assert.match(docs.quickstart, /stock Alpine needs no runtime package install/u);
	assert.doesNotMatch(docs.quickstart, /apk add/u);
	assert.match(docs.index, /stock Alpine without installing runtime packages/u);
	assert.match(docs.readme, /run on stock Alpine without an `apk add` step/u);
	assert.match(docs.containerization, /without Node\.js or npm/u);
	assert.match(docs.termux, /Do not run the root `install\.sh`/u);
	assert.match(docs.termux, /bionic libc/u);
});

test("CI runs the POSIX installer smoke in Alpine and Debian slim", async () => {
	const [workflow, smoke] = await Promise.all([
		readText(`${root}/.github/workflows/test.yml`),
		readText(`${root}/scripts/test-installers-containers.sh`),
	]);
	assert.match(workflow, /run: \.\/scripts\/test-installers-containers\.sh/u);
	assert.match(smoke, /alpine:3\.22/u);
	assert.match(smoke, /debian:bookworm-slim/u);
	assert.match(smoke, /\/bin\/sh \/repo\/install\.sh --ref 1\.0\.0/u);
	assert.match(smoke, /! command -v ldd/u);
});
