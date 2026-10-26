import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";

// jiti places its transpile cache under `<tmpdir>/jiti`. Point every temp-dir variable Node's `tmpdir()` reads (TMPDIR on
// POSIX, TEMP and TMP on Windows) at a private directory so deleting the cache cannot disturb other processes, and
// re-import the loader so any jiti instance it builds sees that directory.
const TEMP_DIR_VARIABLES = ["TMPDIR", "TEMP", "TMP"] as const;
let previousTempDirs: Partial<Record<(typeof TEMP_DIR_VARIABLES)[number], string>>;
let sandbox: string;
let privateTmp: string;

beforeEach(() => {
	sandbox = mkdtempSync(join(tmpdir(), "atomic-jiti-cache-"));
	privateTmp = join(sandbox, "tmp");
	mkdirSync(privateTmp);
	previousTempDirs = {};
	for (const name of TEMP_DIR_VARIABLES) {
		if (process.env[name] !== undefined) previousTempDirs[name] = process.env[name];
		process.env[name] = privateTmp;
	}
	vi.resetModules();
});

afterEach(() => {
	for (const name of TEMP_DIR_VARIABLES) {
		const previous = previousTempDirs[name];
		if (previous === undefined) delete process.env[name];
		else process.env[name] = previous;
	}
	rmSync(sandbox, { recursive: true, force: true });
});

function writeWorkflow(dir: string, name: string): string {
	const path = join(dir, `${name}.ts`);
	writeFileSync(
		path,
		[
			'import { workflow } from "@bastani/atomic/workflows";',
			`export default workflow({ name: ${JSON.stringify(name)}, description: "test", inputs: {}, outputs: {}, run: async () => ({}) });`,
		].join("\n"),
		"utf-8",
	);
	return path;
}

test("loads workflows after the jiti cache directory is deleted (#3985)", async () => {
	const { loadWorkflowModule, validateWorkflowDefinitionShape } = await import(
		"../../packages/workflows/src/extension/workflow-module-loader.js"
	);
	const workflowsDir = join(sandbox, "workflows");
	mkdirSync(workflowsDir);
	const first = writeWorkflow(workflowsDir, "first");

	assert.equal(validateWorkflowDefinitionShape(loadWorkflowModule(first).default), null);
	assert.equal(tmpdir(), privateTmp, "the loader must see the private temp directory");
	const cacheDir = join(privateTmp, "jiti");
	assert.ok(existsSync(cacheDir), "the first load should populate the jiti cache directory");

	// Simulate an external /tmp cleanup between loads.
	rmSync(cacheDir, { recursive: true, force: true });

	assert.equal(validateWorkflowDefinitionShape(loadWorkflowModule(first).default), null);
	const second = writeWorkflow(workflowsDir, "second");
	assert.equal(validateWorkflowDefinitionShape(loadWorkflowModule(second).default), null);
});
