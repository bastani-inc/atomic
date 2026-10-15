import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, test } from "vitest";
import { discoverWorkflows } from "../../packages/workflows/src/extension/discovery.js";
import {
	createProjectWorkflowFile,
	tmpRoot,
	validDefaultAndNamedExportSrc,
	validDefaultExportSrc,
	validNamedExportSrc,
} from "./discovery-module-imports-helpers.js";

export function registerDiscoveryModuleImportsSuite2(): void {
	// ---------------------------------------------------------------------------

	describe("importWorkflowFile — default AND named exports", () => {
		test("collects both default export and named export from same file", async () => {
			await createProjectWorkflowFile(
				"multi.js",
				validDefaultAndNamedExportSrc("First", "first", "Second", "second"),
			);
			const result = await discoverWorkflows({
				cwd: join(tmpRoot, "cwd"),
				homeDir: join(tmpRoot, "home"),
				includeBundled: false,
			});
			assert.equal(result.registry.has("first"), true);
			assert.equal(result.registry.has("second"), true);
		});

		test("default export is registered first (wins on duplicate normalizedName with named export)", async () => {
			// Both default and named export have the same normalizedName → default wins, named is DUPLICATE_NAME
			await createProjectWorkflowFile(
				"conflict.js",
				`
  import { workflow } from "@bastani/atomic/workflows";
  export default workflow({
    name: "conflict-alpha",
    description: "conflict-alpha",
    inputs: {},
    outputs: {},
    run: async (ctx) => { await ctx.task("validation-smoke", { prompt: "validation smoke" }); return {}; },
  });
  export const named = workflow({
    name: "conflict-alpha",
    description: "Alpha Named",
    inputs: {},
    outputs: {},
    run: async (ctx) => { await ctx.task("validation-smoke", { prompt: "validation smoke" }); return {}; },
  });
  `,
			);
			const result = await discoverWorkflows({
				cwd: join(tmpRoot, "cwd"),
				homeDir: join(tmpRoot, "home"),
				includeBundled: false,
			});
			// Default wins
			assert.equal(result.registry.has("conflict-alpha"), true);
			assert.equal(result.registry.get("conflict-alpha")?.name, "conflict-alpha");
			// Named emits DUPLICATE_NAME
			const dupes = result.errors.filter((e) => e.code === "DUPLICATE_NAME");
			assert.ok(dupes.length >= 1);
		});

		test("named exports collected even when no default export exists", async () => {
			await createProjectWorkflowFile("named-only.js", validNamedExportSrc("Named Only", "named-only"));
			const result = await discoverWorkflows({
				cwd: join(tmpRoot, "cwd"),
				homeDir: join(tmpRoot, "home"),
				includeBundled: false,
			});
			assert.equal(result.registry.has("named-only"), true);
		});

		test("named exports that fail validation emit INVALID_DEFINITION, others still register", async () => {
			await createProjectWorkflowFile(
				"mixed-validity.js",
				`
  import { workflow } from "@bastani/atomic/workflows";
  export default workflow({
    name: "Valid Default",
    description: "",
    inputs: {},
    outputs: {},
    run: async (ctx) => { await ctx.task("validation-smoke", { prompt: "validation smoke" }); return {}; },
  });
  export const bad = { notAWorkflow: true };
  `,
			);
			const result = await discoverWorkflows({
				cwd: join(tmpRoot, "cwd"),
				homeDir: join(tmpRoot, "home"),
				includeBundled: false,
			});
			assert.equal(result.registry.has("valid-default"), true);
			const invalids = result.errors.filter((e) => e.code === "INVALID_DEFINITION");
			assert.ok(invalids.length >= 1);
			assert.ok(invalids[0]!.source!.includes("mixed-validity.js"));
		});
	});

	// ---------------------------------------------------------------------------
	// IMPORT_FAILED diagnostic
	// ---------------------------------------------------------------------------

	describe("IMPORT_FAILED diagnostic", () => {
		test("emits IMPORT_FAILED when file has syntax error", async () => {
			await createProjectWorkflowFile("broken.js", "this is not valid javascript }{{{");
			const result = await discoverWorkflows({
				cwd: join(tmpRoot, "cwd"),
				homeDir: join(tmpRoot, "home"),
				includeBundled: false,
			});
			const importFailed = result.errors.filter((e) => e.code === "IMPORT_FAILED");
			assert.ok(importFailed.length >= 1);
			assert.equal(importFailed[0]!.level, "error");
			assert.ok(importFailed[0]!.source!.includes("broken.js"));
			assert.equal(typeof importFailed[0]!.message, "string");
		});

		test("IMPORT_FAILED does not block other files from being discovered", async () => {
			await createProjectWorkflowFile("broken.js", "}{{{ syntax error");
			await createProjectWorkflowFile("good.js", validDefaultExportSrc("Good Workflow", "good-workflow"));
			const result = await discoverWorkflows({
				cwd: join(tmpRoot, "cwd"),
				homeDir: join(tmpRoot, "home"),
				includeBundled: false,
			});
			assert.equal(result.registry.has("good-workflow"), true);
			const importFailed = result.errors.filter((e) => e.code === "IMPORT_FAILED");
			assert.ok(importFailed.length >= 1);
		});
	});
}
