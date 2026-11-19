import assert from "node:assert/strict";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, test } from "vitest";
import { bunExecutable, moduleDir, spawnSyncCollect } from "../helpers/runtime.js";
import { removeTestDirectory } from "../helpers/test-directory-removal.js";

const here = moduleDir(import.meta.url);
const root = join(here, "../..");
const sdk = join(root, "packages", "coding-agent");
const fixture = join(here, "fixtures", "panel-released-owner.mjs");
const layoutTimeout = 120_000;
let install: string;

beforeAll(() => {
	install = mkdtempSync(join(tmpdir(), "atomic-panel-owners-"));
	// The two consumers install separate SDKs; their ordinary dependencies can be shared.
	symlinkSync(join(root, "node_modules"), join(install, "node_modules"), "junction");
	for (const name of ["a", "b"]) {
		const dest = join(install, name, "node_modules", "@bastani", "atomic");
		mkdirSync(dest, { recursive: true });
		copyFileSync(join(sdk, "package.json"), join(dest, "package.json"));
		cpSync(join(sdk, "dist"), join(dest, "dist"), { recursive: true, dereference: true });
	}
}, layoutTimeout);
afterAll(() => {
	if (install) removeTestDirectory(install, { retries: 20, retryDelayMs: 50 });
}, layoutTimeout);

for (const [runtime, executable] of [
	["Node", process.execPath],
	["Bun", bunExecutable()],
] as const) {
	for (const [scenario, behavior] of [
		["shared", "closing another owner keeps a released child stopped"],
		["separate", "repainting a waiting child never consults another owner"],
	]) {
		test(
			`${behavior} under ${runtime} (#5688)`,
			() => {
				const result = spawnSyncCollect([executable, fixture, install, scenario], { timeout: layoutTimeout });
				assert.equal(result.exitCode, 0, result.stderr.toString());
			},
			layoutTimeout,
		);
	}
}
