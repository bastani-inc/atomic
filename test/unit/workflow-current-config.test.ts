import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { loadWorkflowConfig } from "../../packages/workflows/src/extension/config-loader.js";
import { discoverWorkflows } from "../../packages/workflows/src/extension/discovery.js";
import { writeFileEnsuringDir } from "../helpers/runtime.js";

test("loads only current project and global workflow configuration roots", async () => {
	const root = await mkdtemp(join(tmpdir(), "workflow-current-config-"));
	const homeDir = join(root, "home");
	const projectRoot = join(root, "project");
	try {
		await writeFileEnsuringDir(join(homeDir, ".pi/agent/extensions/workflow/config.json"), '{"maxDepth":7}');
		await writeFileEnsuringDir(join(projectRoot, ".pi/extensions/workflow/config.json"), '{"defaultConcurrency":9}');
		const absent = await loadWorkflowConfig({ homeDir, projectRoot });
		assert.equal(absent.config, null);
		await writeFileEnsuringDir(join(homeDir, ".atomic/agent/extensions/workflow/config.json"), '{"maxDepth":3}');
		await writeFileEnsuringDir(join(projectRoot, ".atomic/extensions/workflow/config.json"), '{"maxDepth":4}');
		const current = await loadWorkflowConfig({ homeDir, projectRoot });
		assert.equal(current.config?.maxDepth, 4);
		assert.equal(current.config?.defaultConcurrency, undefined);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("discovers only current default workflow roots", async () => {
	const root = await mkdtemp(join(tmpdir(), "workflow-current-discovery-"));
	const homeDir = join(root, "home");
	const cwd = join(root, "project");
	const definition = (name: string) =>
		`import { workflow } from "@bastani/atomic/workflows"; export default workflow({ name: ${JSON.stringify(name)}, description: "current discovery fixture", inputs: {}, outputs: {}, run: async () => ({}) });`;
	try {
		await writeFileEnsuringDir(join(cwd, ".pi/workflows/old-project.ts"), definition("old-project"));
		await writeFileEnsuringDir(join(homeDir, ".pi/agent/workflows/old-global.ts"), definition("old-global"));
		await writeFileEnsuringDir(join(cwd, ".atomic/workflows/current-project.ts"), definition("current-project"));
		await writeFileEnsuringDir(
			join(homeDir, ".atomic/agent/workflows/current-global.ts"),
			definition("current-global"),
		);
		const result = await discoverWorkflows({ cwd, homeDir, includeBundled: false });
		assert.deepEqual(
			result.errors.filter((entry) => entry.level === "error"),
			[],
		);
		assert.deepEqual(
			result.registry
				.all()
				.map((entry) => entry.name)
				.sort(),
			["current-global", "current-project"],
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("loads current workflow/schema modules without registering removed aliases", async () => {
	const root = await mkdtemp(join(tmpdir(), "workflow-current-modules-"));
	try {
		const dir = join(root, ".atomic/workflows");
		await writeFileEnsuringDir(
			join(dir, "current.ts"),
			'import { workflow } from "@bastani/atomic/workflows"; import { Type } from "typebox"; export default workflow({name:"current-module",description:"",inputs:{},outputs:{value:Type.Number()},run:async()=>({value:1})});',
		);
		await writeFileEnsuringDir(
			join(dir, "old-sdk.ts"),
			'import { workflow } from "@bastani/workflows"; export default workflow({name:"old-sdk",description:"",inputs:{},outputs:{},run:async()=>({})});',
		);
		await writeFileEnsuringDir(
			join(dir, "old-schema.ts"),
			'import { workflow } from "@bastani/atomic/workflows"; import { Type } from "@sinclair/typebox"; export default workflow({name:"old-schema",description:"",inputs:{},outputs:{value:Type.Number()},run:async()=>({value:1})});',
		);
		const result = await discoverWorkflows({ cwd: root, homeDir: join(root, "home"), includeBundled: false });
		assert.deepEqual(
			result.registry.all().map((entry) => entry.name),
			["current-module"],
		);
		assert.deepEqual(
			result.errors.filter((entry) => entry.level === "error").map((entry) => entry.code),
			["IMPORT_FAILED", "IMPORT_FAILED"],
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
