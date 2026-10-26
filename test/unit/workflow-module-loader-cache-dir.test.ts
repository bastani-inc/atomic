import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";

// jiti places its transpile cache under `<tmpdir>/jiti`. Point TMPDIR at a private directory so deleting the cache
// cannot disturb other processes, and re-import the loader so any jiti instance it builds sees that directory.
let previousTmpdir: string | undefined;
let sandbox: string;

beforeEach(() => {
	sandbox = mkdtempSync(join(tmpdir(), "atomic-jiti-cache-"));
	previousTmpdir = process.env.TMPDIR;
	process.env.TMPDIR = join(sandbox, "tmp");
	mkdirSync(process.env.TMPDIR);
	vi.resetModules();
});

afterEach(() => {
	if (previousTmpdir === undefined) delete process.env.TMPDIR;
	else process.env.TMPDIR = previousTmpdir;
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
	const cacheDir = join(process.env.TMPDIR ?? "", "jiti");
	assert.ok(existsSync(cacheDir), "the first load should populate the jiti cache directory");

	// Simulate an external /tmp cleanup between loads.
	rmSync(cacheDir, { recursive: true, force: true });

	assert.equal(validateWorkflowDefinitionShape(loadWorkflowModule(first).default), null);
	const second = writeWorkflow(workflowsDir, "second");
	assert.equal(validateWorkflowDefinitionShape(loadWorkflowModule(second).default), null);
});
