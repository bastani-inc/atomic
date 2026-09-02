import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, test } from "vitest";
import {
	type PossibleStagesScanResult,
	scanPossibleStagesFromSource,
} from "../../packages/workflows/src/shared/possible-stages.js";
import { makeTempDirectory, moduleDir, removeTempDirectory, writeTextSync } from "../helpers/runtime.js";

const TEST_DIR = makeTempDirectory("possible-stages-scan");
afterAll(() => {
	removeTempDirectory(TEST_DIR);
});

const BUILTIN_DIR = join(moduleDir(import.meta.url), "..", "..", "packages", "workflows", "builtin");

function writeFixture(name: string, source: string): string {
	const filePath = join(TEST_DIR, name);
	writeTextSync(filePath, source);
	return filePath;
}

function scanFile(name: string, source: string, options?: { readonly maxDepth?: number }): PossibleStagesScanResult {
	return scanPossibleStagesFromSource(writeFixture(name, source), options);
}

// ---------------------------------------------------------------------------
// D2 — stage-name pattern extraction
// ---------------------------------------------------------------------------

describe("possible-stage scan — D2 name patterns", () => {
	test("string literals stay literal; template holes become glob stars", () => {
		const result = scanFile(
			"d2.ts",
			`
				export default workflow({
					name: "d2",
					run: async (ctx) => {
						await ctx.stage("setup");
						await ctx.task(\`orchestrator-\${iteration}\`, {});
						await ctx.stage(\`review-\${slice}-\${n}\`);
						await ctx.stage(\`prefix-\${x}-suffix\`);
						let current: string | undefined;
						await ctx.task(name, {});
						await ctx.stage(derive(iteration));
					},
				});
			`,
		);
		assert.deepEqual(result.stages, ["*", "orchestrator-*", "prefix-*-suffix", "review-*-*", "setup"]);
		assert.deepEqual(result.warnings, []);
	});

	test("ctx.task contributes its name; chain/parallel steps contribute name fields", () => {
		const result = scanFile(
			"steps.ts",
			`
				export default workflow({
					name: "steps",
					run: async (ctx) => {
						const previous = await ctx.task("first", { prompt: "p" });
						await ctx.chain([
							{ name: "chain-a", task: "a" },
							{ name: "chain-b", task: previous.text },
						]);
						await ctx.parallel([
							{ name: "reviewer-a", task: "r" },
							{ name: "reviewer-b", task: "r" },
						]);
					},
				});
			`,
		);
		assert.deepEqual(result.stages, ["chain-a", "chain-b", "first", "reviewer-a", "reviewer-b"]);
	});

	test("step arrays built by .map() contribute their object name fields", () => {
		const result = scanFile(
			"mapped-steps.ts",
			`
				export default workflow({
					name: "mapped-steps",
					run: async (ctx) => {
						await ctx.parallel(partitions.map((partition, index) => ({
							name: \`branch-\${index}\`,
							prompt: prompt(partition),
						})));
					},
				});
			`,
		);
		assert.deepEqual(result.stages, ["branch-*"]);
	});

	test("typed step declarations built by .map() contribute their object name fields", () => {
		const result = scanFile(
			"typed-mapped-steps.ts",
			`
				export default workflow({
					name: "typed-mapped-steps",
					run: async (ctx) => {
						const steps: WorkflowTaskStep[] = partitions.map((partition, index) => ({
							name: \`branch-\${safeName(partition, index)}\`,
							prompt: branchPrompt(partition),
						}));
						await ctx.parallel(steps, { concurrency: 3 });
					},
				});
			`,
		);
		assert.deepEqual(result.stages, ["branch-*"]);
	});

	test("step factories: name shorthand binds to the call-site argument", () => {
		const result = scanFile(
			"factory-steps.ts",
			`
				export default workflow({
					name: "factory-steps",
					run: async (ctx) => {
						const reviewerStep = (name: string, role: string) => ({
							name,
							task: renderPrompt({ role }),
						});
						const reviewerSteps = [
							reviewerStep(\`completion-reviewer-\${turn}\`, "a"),
							reviewerStep(\`risk-reviewer-\${turn}\`, "b"),
						];
						await ctx.parallel(reviewerSteps, { failFast: true });
					},
				});
			`,
		);
		assert.deepEqual(result.stages, ["completion-reviewer-*", "risk-reviewer-*"]);
	});

	test("objects carrying both name and stageName string fields are stage targets", () => {
		const result = scanFile(
			"stage-records.ts",
			`
				export default workflow({
					name: "stage-records",
					run: async (ctx) => {
						reviewResults = [
							{
								name: "reviewer-error",
								stageName: "reviewer-error",
								text: failure,
							},
						];
						await ctx.stage("after");
					},
				});
			`,
		);
		assert.deepEqual(result.stages, ["after", "reviewer-error"]);
	});

	test("run-context aliases (workflowCtx, designContext chains) resolve their stage calls", () => {
		const result = scanFile(
			"aliased-ctx.ts",
			`
				export default workflow({
					name: "aliased-ctx",
					run: async (ctx) => {
						const workflowCtx = withSteeringPropagationContext(ctx);
						const designContext = workflowCtx;
						await workflowCtx.stage("rebound");
						await handle({ designContext });
					},
				});
				async function handle(args: { designContext: unknown }): Promise<void> {
					await args.designContext.task("discovery", {});
				}
			`,
		);
		assert.deepEqual(result.stages, ["discovery", "rebound"]);
	});

	test("ctx.tool marks tracked work without advertising a chat-stage target", () => {
		const result = scanFile(
			"tool-only.ts",
			`
				export default workflow({
					name: "tool-only",
					run: async (ctx) => {
						await ctx.tool("durable-check", {}, async () => "ok");
					},
				});
			`,
		);
		assert.deepEqual(result.stages, []);
		assert.equal(result.hasTrackedNodes, true);
	});

	test("calls inside strings and comments are ignored", () => {
		const result = scanFile(
			"noise.ts",
			`
				// ctx.stage("in-comment")
				/* await ctx.task("in-block") */
				const guidance = 'send via ctx.stage("in-string")';
				const text = \`review notes mentioning ctx.parallel([{ name: "ghost" }])\`;
				export default workflow({
					name: "noise",
					run: async (ctx) => {
						await ctx.stage("real");
					},
				});
			`,
		);
		assert.deepEqual(result.stages, ["real"]);
	});
});

// ---------------------------------------------------------------------------
// D1 — child following, boundaries, depth, cycles
// ---------------------------------------------------------------------------

describe("possible-stage scan — child definitions and boundaries", () => {
	test("ctx.workflow follows relative imports and nests under the default boundary", () => {
		writeFixture(
			"wf-child.ts",
			`
				import { workflow } from "@bastani/workflows";
				export default workflow({
					name: "child",
					run: async (ctx) => {
						await ctx.task(\`impl-\${index}\`, {});
						await ctx.stage("child-final");
					},
				});
			`,
		);
		const result = scanFile(
			"wf-parent.ts",
			`
				import child from "./wf-child.js";
				import { workflow } from "@bastani/workflows";
				export default workflow({
					name: "parent",
					run: async (ctx) => {
						await ctx.stage("root-setup");
						await ctx.workflow(child);
						await ctx.workflow(child, { stageName: "implement" });
					},
				});
			`,
		);
		assert.deepEqual(result.stages, [
			"implement",
			"implement/child-final",
			"implement/impl-*",
			"root-setup",
			"workflow:child",
			"workflow:child/child-final",
			"workflow:child/impl-*",
		]);
		assert.deepEqual(result.warnings, []);
	});

	test("ctx.workflow follows builtin barrel imports and nests builtin stages", () => {
		const result = scanFile(
			"barrel-parent.ts",
			`
				import { ralph } from "@bastani/workflows/builtin";
				import { workflow } from "@bastani/workflows";
				export default workflow({
					name: "barrel-parent",
					run: async (ctx) => {
						await ctx.workflow(ralph, { stageName: "ralph-child" });
					},
				});
			`,
		);
		assert.ok(result.stages.includes("ralph-child/research-*"), JSON.stringify(result.stages));
		assert.ok(result.stages.includes("ralph-child/pull-request"), JSON.stringify(result.stages));
		assert.ok(result.stages.includes("ralph-child/reviewer-a"), JSON.stringify(result.stages));
	});

	test("grandchildren nest transitively and maxDepth bounds the descent", () => {
		writeFixture(
			"depth-grandchild.ts",
			`
				import { workflow } from "@bastani/workflows";
				export default workflow({
					name: "grandchild",
					run: async (ctx) => {
						await ctx.stage("grandchild-stage");
					},
				});
			`,
		);
		writeFixture(
			"depth-child.ts",
			`
				import grandchild from "./depth-grandchild.js";
				import { workflow } from "@bastani/workflows";
				export default workflow({
					name: "depth-child",
					run: async (ctx) => {
						await ctx.stage("child-stage");
						await ctx.workflow(grandchild);
					},
				});
			`,
		);
		const parent = writeFixture(
			"depth-parent.ts",
			`
				import child from "./depth-child.js";
				import { workflow } from "@bastani/workflows";
				export default workflow({
					name: "depth-parent",
					run: async (ctx) => {
						await ctx.workflow(child);
					},
				});
			`,
		);
		const full = scanPossibleStagesFromSource(parent);
		assert.deepEqual(full.stages, [
			"workflow:depth-child",
			"workflow:depth-child/child-stage",
			"workflow:depth-child/workflow:grandchild",
			"workflow:depth-child/workflow:grandchild/grandchild-stage",
		]);
		const bounded = scanPossibleStagesFromSource(parent, { maxDepth: 2 });
		// The depth-2 boundary still materializes (the runtime spawns it before
		// the child's maxDepth refusal), but the refused child's stages do not.
		assert.deepEqual(bounded.stages, [
			"workflow:depth-child",
			"workflow:depth-child/child-stage",
			"workflow:depth-child/workflow:grandchild",
		]);
	});

	test("import cycles terminate and keep both files' stages", () => {
		writeFixture(
			"cycle-b.ts",
			`
				import a from "./cycle-a.js";
				import { workflow } from "@bastani/workflows";
				export default workflow({
					name: "cycle-b",
					run: async (ctx) => {
						await ctx.stage("b-stage");
						await ctx.workflow(a);
					},
				});
			`,
		);
		const result = scanFile(
			"cycle-a.ts",
			`
				import b from "./cycle-b.js";
				import { workflow } from "@bastani/workflows";
				export default workflow({
					name: "cycle-a",
					run: async (ctx) => {
						await ctx.stage("a-stage");
						await ctx.workflow(b);
					},
				});
			`,
		);
		// Boundary names still materialize where descent is cycle-blocked, but
		// the blocked subtree's stages are the documented partial result (D1).
		assert.deepEqual(result.stages, [
			"a-stage",
			"workflow:cycle-b",
			"workflow:cycle-b/b-stage",
			"workflow:cycle-b/workflow:cycle-a",
		]);
	});

	test("named-export and aliased-default child definitions nest instead of leaking flat", () => {
		writeFixture(
			"named-grand.ts",
			`
				import { workflow } from "@bastani/workflows";
				export const grand = workflow({
					name: "named-grand",
					run: async (ctx) => {
						await ctx.stage("grand-step");
					},
				});
			`,
		);
		writeFixture(
			"alias-child.ts",
			`
				import { workflow } from "@bastani/workflows";
				const child = workflow({
					name: "alias-child",
					run: async (ctx) => {
						await ctx.stage("alias-step");
					},
				});
				export default child;
			`,
		);
		const result = scanFile(
			"named-children-parent.ts",
			`
				import { grand } from "./named-grand.js";
				import aliasChild from "./alias-child.js";
				import { workflow } from "@bastani/workflows";
				export default workflow({
					name: "named-children-parent",
					run: async (ctx) => {
						await ctx.workflow(grand);
						await ctx.workflow(aliasChild);
					},
				});
			`,
		);
		assert.deepEqual(result.stages, [
			"workflow:alias-child",
			"workflow:alias-child/alias-step",
			"workflow:named-grand",
			"workflow:named-grand/grand-step",
		]);
	});

	test("wrapper modules with no visible definition fall back to the kebab boundary", () => {
		writeFixture(
			"kebab-impl.ts",
			`
				import { workflow } from "@bastani/workflows";
				export const def = workflow({
					name: "camel-child",
					run: async (ctx) => {
						await ctx.stage("impl-step");
					},
				});
			`,
		);
		// Shipped-layout shape: a re-export wrapper whose default binding has no
		// authored name in this file.
		writeFixture(
			"kebab-wrapper.ts",
			`
				import { def } from "./kebab-impl.js";
				export { def as default };
			`,
		);
		const result = scanFile(
			"kebab-parent.ts",
			`
				import camelChild from "./kebab-wrapper.js";
				import { workflow } from "@bastani/workflows";
				export default workflow({
					name: "kebab-parent",
					run: async (ctx) => {
						await ctx.workflow(camelChild);
					},
				});
			`,
		);
		assert.ok(result.stages.includes("workflow:camel-child"), JSON.stringify(result.stages));
		assert.ok(result.stages.includes("workflow:camel-child/impl-step"), JSON.stringify(result.stages));
	});

	test("computed child references map to a glob boundary with a warning", () => {
		const result = scanFile(
			"computed-child.ts",
			`
				import { workflow } from "@bastani/workflows";
				export default workflow({
					name: "computed-child",
					run: async (ctx) => {
						await ctx.stage("kept");
						await ctx.workflow(defs[0], {});
						await ctx.workflow(ns.default, {});
					},
				});
			`,
		);
		assert.deepEqual(result.stages, ["kept", "workflow:*"]);
		assert.equal(
			result.warnings.filter((warning) => warning.includes("could not be resolved")).length,
			2,
			JSON.stringify(result.warnings),
		);
	});

	test("unrecognized .map step builders warn instead of dropping silently", () => {
		const result = scanFile(
			"opaque-map.ts",
			`
				export default workflow({
					name: "opaque-map",
					run: async (ctx) => {
						await ctx.parallel(warmIndices.map((index) => steps[index]));
					},
				});
			`,
		);
		assert.deepEqual(result.stages, []);
		assert.equal(
			result.warnings.some((warning) => warning.includes("not statically visible")),
			true,
			JSON.stringify(result.warnings),
		);
	});

	test("shipped-layout wrapper entries scan the definition module behind them", () => {
		// Regression (review round 2): the closure exclusion skipped definition
		// modules, so a wrapper entry (bundled `export { x_default as default }`
		// shape) scanned to an empty set with no warning.
		writeFixture(
			"wrapped-impl.ts",
			`
				import { workflow } from "@bastani/workflows";
				var wrapped_default = workflow({
					name: "wrapped",
					run: async (ctx) => {
						await ctx.stage("wrapped-step");
					},
				});
				export { wrapped_default as default };
			`,
		);
		writeFixture(
			"wrapped-entry.ts",
			`
				import { wrapped_default } from "./wrapped-impl.js";
				export { wrapped_default as default };
			`,
		);
		const entry = join(TEST_DIR, "wrapped-entry.ts");
		const result = scanPossibleStagesFromSource(entry);
		assert.deepEqual(result.stages, ["wrapped-step"]);
		assert.deepEqual(result.warnings, []);
	});

	test("authored camelCase names normalize verbatim like the engine", () => {
		writeFixture(
			"camel-authored.ts",
			`
				import { workflow } from "@bastani/workflows";
				export default workflow({
					name: "myCamelChild",
					run: async (ctx) => {
						await ctx.stage("s");
					},
				});
			`,
		);
		const result = scanFile(
			"camel-parent.ts",
			`
				import camelChild from "./camel-authored.js";
				import { workflow } from "@bastani/workflows";
				export default workflow({
					name: "camel-parent",
					run: async (ctx) => {
						await ctx.workflow(camelChild);
					},
				});
			`,
		);
		// The engine normalizes the authored name without inserting hyphens.
		assert.ok(result.stages.includes("workflow:mycamelchild"), JSON.stringify(result.stages));
		assert.equal(result.stages.includes("workflow:my-camel-child"), false, JSON.stringify(result.stages));
		assert.ok(result.stages.includes("workflow:mycamelchild/s"), JSON.stringify(result.stages));
	});

	test("a member ctx.workflow call above the definition hides nothing", () => {
		writeFixture(
			"mixed-def.ts",
			`
				import { workflow } from "@bastani/workflows";
				async function runGrand(ctx) {
					await ctx.workflow(grand);
				}
				export default workflow({
					name: "mixed",
					run: async (ctx) => {
						await ctx.stage("mixed-step");
					},
				});
			`,
		);
		const result = scanFile(
			"mixed-parent.ts",
			`
				import mixed from "./mixed-def.js";
				import { workflow } from "@bastani/workflows";
				export default workflow({
					name: "mixed-parent",
					run: async (ctx) => {
						await ctx.stage("p");
						await ctx.workflow(mixed);
					},
				});
			`,
		);
		// The child's own stage nests under its boundary; the helper's
		// ctx.workflow(grand) contributes an unresolved-boundary warning but
		// nothing leaks flat.
		assert.ok(result.stages.includes("p"), JSON.stringify(result.stages));
		assert.ok(result.stages.includes("workflow:mixed"), JSON.stringify(result.stages));
		assert.ok(result.stages.includes("workflow:mixed/mixed-step"), JSON.stringify(result.stages));
		assert.equal(
			result.stages.includes("mixed-step"),
			false,
			`child stage leaked flat: ${JSON.stringify(result.stages)}`,
		);
	});

	test("entries with non-literal names keep their own stages; children still nest", () => {
		// Regression (review round 3): a wrapper-entry heuristic keyed on
		// `definitionName === undefined` re-rooted scans at imported children
		// whenever the entry's authored name was a const or the call carried
		// type arguments, dropping the parent's stages and leaking the child's.
		writeFixture(
			"entry-child.ts",
			`
				import { workflow } from "@bastani/workflows";
				export default workflow({
					name: "entry-child",
					run: async (ctx) => {
						await ctx.stage("entry-child-step");
					},
				});
			`,
		);
		const constNamed = scanFile(
			"entry-const-name.ts",
			`
				import entryChild from "./entry-child.js";
				import { workflow } from "@bastani/workflows";
				const ENTRY_NAME = "entry-const";
				export default workflow({
					name: ENTRY_NAME,
					run: async (ctx) => {
						await ctx.stage("entry-own-stage");
						await ctx.workflow(entryChild);
					},
				});
			`,
		);
		assert.deepEqual(constNamed.stages, [
			"entry-own-stage",
			"workflow:entry-child",
			"workflow:entry-child/entry-child-step",
		]);
		const generic = scanFile(
			"entry-generic.ts",
			`
				import entryChild from "./entry-child.js";
				import { workflow } from "@bastani/workflows";
				export default workflow<{ task: string }, { done: boolean }>({
					name: "entry-generic",
					run: async (ctx) => {
						await ctx.stage("generic-own-stage");
						await ctx.workflow(entryChild);
					},
				});
			`,
		);
		assert.deepEqual(generic.stages, [
			"generic-own-stage",
			"workflow:entry-child",
			"workflow:entry-child/entry-child-step",
		]);
	});

	test("non-literal child names resolve through local constants and never leak flat", () => {
		writeFixture(
			"const-child.ts",
			`
				import { workflow } from "@bastani/workflows";
				const NAME = "child-const";
				export default workflow({
					name: NAME,
					run: async (ctx) => {
						await ctx.task("cc-task", {});
					},
				});
			`,
		);
		const result = scanFile(
			"const-child-parent.ts",
			`
				import constChild from "./const-child.js";
				import { workflow } from "@bastani/workflows";
				export default workflow({
					name: "const-child-parent",
					run: async (ctx) => {
						await ctx.stage("plan");
						await ctx.workflow(constChild);
					},
				});
			`,
		);
		assert.deepEqual(result.stages, ["plan", "workflow:child-const", "workflow:child-const/cc-task"]);
		assert.deepEqual(result.warnings, []);
	});

	test("wrapper children take the boundary from the authored definition behind the wrapper", () => {
		writeFixture(
			"barrel-wrapper.ts",
			`
				import { flow } from "./barrel-impl.js";
				export { flow as default };
			`,
		);
		writeFixture(
			"barrel-impl.ts",
			`
				import { workflow } from "@bastani/workflows";
				export const flow = workflow({
					name: "bar-flow",
					run: async (ctx) => {
						await ctx.stage("bar-task");
					},
				});
			`,
		);
		const result = scanFile(
			"barrel-wrapper-parent.ts",
			`
				import fooChild from "./barrel-wrapper.js";
				import { workflow } from "@bastani/workflows";
				export default workflow({
					name: "barrel-wrapper-parent",
					run: async (ctx) => {
						await ctx.workflow(fooChild);
					},
				});
			`,
		);
		assert.deepEqual(result.stages, ["workflow:bar-flow", "workflow:bar-flow/bar-task"]);
		// The authored name is visible behind the wrapper: no fallback warning.
		assert.deepEqual(
			result.warnings.filter((warning) => warning.includes("not statically visible")),
			[],
			JSON.stringify(result.warnings),
		);
	});

	test("re-export barrels (export { default as x } from ...) are followed", () => {
		writeFixture(
			"re-child.ts",
			`
				import { workflow } from "@bastani/workflows";
				export default workflow({
					name: "review",
					run: async (ctx) => {
						await ctx.stage("critique");
					},
				});
			`,
		);
		writeFixture(
			"re-barrel.ts",
			`
				export { default as reviewFlow } from "./re-child.js";
			`,
		);
		const result = scanFile(
			"re-barrel-parent.ts",
			`
				import { reviewFlow } from "./re-barrel.js";
				import { workflow } from "@bastani/workflows";
				export default workflow({
					name: "re-barrel-parent",
					run: async (ctx) => {
						await ctx.stage("plan");
						await ctx.workflow(reviewFlow);
					},
				});
			`,
		);
		assert.deepEqual(result.stages, ["plan", "workflow:review", "workflow:review/critique"]);
		assert.deepEqual(result.warnings, []);
	});

	test("adjacent template holes collapse to one glob star", () => {
		const result = scanFile(
			"adjacent-holes.ts",
			`
				export default workflow({
					name: "adjacent-holes",
					run: async (ctx) => {
						await ctx.stage(\`\${a}\${b}\`);
						await ctx.stage(\`review-\${a}-\${b}\`);
					},
				});
			`,
		);
		assert.deepEqual(result.stages, ["*", "review-*-*"]);
	});

	test("unicode and hex escapes decode in stage-name literals", () => {
		const result = scanFile(
			"escapes.ts",
			`
				export default workflow({
					name: "escapes",
					run: async (ctx) => {
						await ctx.stage("caf\u00e9-1");
						await ctx.stage("caf\\u00e9-literal");
						await ctx.stage("hex\x41");
					},
				});
			`,
		);
		assert.deepEqual(result.stages, ["café-1", "café-literal", "hexA"]);
	});

	test("function declarations of the factory do not hide real definitions", () => {
		// Regression (review round 4): `function workflow(spec)` declarations
		// counted as definition calls, so a bundled SDK chunk was excluded from
		// closures and the entry re-root landed on the wrong module.
		writeFixture(
			"sdk-helper.ts",
			`
				function workflow(spec) {
					return spec;
				}
				export function launch(spec) {
					return workflow(spec);
				}
			`,
		);
		writeFixture(
			"decl-impl.ts",
			`
				import { workflow } from "@bastani/workflows";
				var decl_default = workflow({
					name: "decl",
					run: async (ctx) => {
						await ctx.stage("decl-step");
					},
				});
				export { decl_default as default };
			`,
		);
		// The wrapper imports the declaration-only helper BEFORE the impl.
		writeFixture(
			"decl-wrapper.ts",
			`
				import "./sdk-helper.js";
				import { decl_default } from "./decl-impl.js";
				export { decl_default as default };
			`,
		);
		const result = scanPossibleStagesFromSource(join(TEST_DIR, "decl-wrapper.ts"));
		assert.deepEqual(result.stages, ["decl-step"]);
	});

	test("workflow factories reached through import aliases are recognized", () => {
		writeFixture(
			"alias-child.ts",
			`
				import { workflow } from "@bastani/workflows";
				export default workflow({
					name: "alias-child",
					run: async (ctx) => {
						await ctx.stage("alias-child-step");
					},
				});
			`,
		);
		const result = scanFile(
			"alias-entry.ts",
			`
				import { workflow as wf } from "@bastani/workflows";
				import aliasChild from "./alias-child.js";
				export default wf({
					name: "alias-entry",
					run: async (ctx) => {
						await ctx.stage("alias-entry-stage");
						await ctx.workflow(aliasChild);
					},
				});
			`,
		);
		// The aliased factory call makes this file a definition: its own stages
		// stay and the child nests (no wrapper re-root at the child).
		assert.deepEqual(result.stages, [
			"alias-entry-stage",
			"workflow:alias-child",
			"workflow:alias-child/alias-child-step",
		]);
	});

	test("resolution failures warn and never throw; the partial set survives", () => {
		const missingChild = scanFile(
			"missing-child-parent.ts",
			`
				import nothing from "./does-not-exist.js";
				import { workflow } from "@bastani/workflows";
				export default workflow({
					name: "missing-child-parent",
					run: async (ctx) => {
						await ctx.stage("kept");
						await ctx.workflow(nothing);
					},
				});
			`,
		);
		assert.deepEqual(missingChild.stages, ["kept", "workflow:nothing"]);
		assert.equal(
			missingChild.warnings.some(
				(warning) => warning.includes("did not resolve") || warning.includes("could not be resolved"),
			),
			true,
			JSON.stringify(missingChild.warnings),
		);

		const unreadable = scanPossibleStagesFromSource(join(TEST_DIR, "missing-entry-file.ts"));
		assert.deepEqual(unreadable.stages, []);
		assert.equal(unreadable.warnings.length > 0, true);
	});
});

// ---------------------------------------------------------------------------
// Determinism and the builtin acceptance sets
// ---------------------------------------------------------------------------

describe("possible-stage scan — determinism over builtin sources", () => {
	const BUILTINS = [
		"adversarial-verification",
		"classify-and-act",
		"fan-out-and-synthesize",
		"generate-and-filter",
		"goal",
		"loop-until-done",
		"open-claude-design",
		"ralph",
		"tournament",
	] as const;

	function scanBuiltin(name: string): PossibleStagesScanResult {
		const entry = join(BUILTIN_DIR, `${name}.ts`);
		assert.equal(existsSync(entry), true, `missing builtin source: ${entry}`);
		return scanPossibleStagesFromSource(entry);
	}

	test("scan output is deterministic for every builtin", () => {
		for (const name of BUILTINS) {
			const first = scanBuiltin(name);
			const second = scanBuiltin(name);
			assert.deepEqual(first, second, `nondeterministic scan for ${name}`);
		}
	});

	test("ralph yields the research, orchestration, pull-request, and reviewer stage sets", () => {
		const { stages } = scanBuiltin("ralph");
		for (const expected of [
			"research-*",
			"research-prompt-refinement-*",
			"orchestrator-*",
			"pull-request",
			"reviewer-a",
			"reviewer-b",
		]) {
			assert.ok(stages.includes(expected), `ralph missing "${expected}": ${JSON.stringify(stages)}`);
		}
	});

	test("goal yields the orchestration, reviewer-error, and pull-request stage sets", () => {
		const { stages } = scanBuiltin("goal");
		for (const expected of ["orchestrator-*", "reviewer-error", "pull-request"]) {
			assert.ok(stages.includes(expected), `goal missing "${expected}": ${JSON.stringify(stages)}`);
		}
	});

	test("the six pattern builtins yield their stage patterns", () => {
		const expected: Record<(typeof BUILTINS)[number], readonly string[]> = {
			"adversarial-verification": ["worker", "consolidate-findings-*", "repair-*"],
			"classify-and-act": ["classifier", "action-*"],
			"fan-out-and-synthesize": ["partition", "synthesize", "branch-*"],
			"generate-and-filter": ["generate-*", "dedupe-and-filter", "judge", "final-shortlist"],
			"loop-until-done": ["iteration-*", "evaluate-*", "completion-summary"],
			tournament: ["attempt-*", "comparisons-reducer", "*-reask"],
			goal: [],
			ralph: [],
			"open-claude-design": [],
		};
		for (const name of BUILTINS) {
			const required = expected[name];
			if (required.length === 0) continue;
			const { stages } = scanBuiltin(name);
			for (const stage of required) {
				assert.ok(stages.includes(stage), `${name} missing "${stage}": ${JSON.stringify(stages)}`);
			}
		}
	});
});

// ---------------------------------------------------------------------------
// Contract hygiene: the scanner stays dependency-free (D1 refinement)
// ---------------------------------------------------------------------------

describe("possible-stage scan — dependency-free lexer hygiene", () => {
	test("packages/workflows/src imports none of typescript, @babel/*, acorn, or oxc-*", () => {
		const srcRoot = join(moduleDir(import.meta.url), "..", "..", "packages", "workflows", "src");
		const banned = /(?:from\s*|import\s*\(\s*)["'](typescript|@babel\/[^"']*|acorn[^"']*|oxc-[^"']*)["']/g;
		const offenders: string[] = [];
		const visit = (dir: string): void => {
			for (const entry of readdirSync(dir, { withFileTypes: true }) as readonly {
				name: string;
				isDirectory(): boolean;
			}[]) {
				const fullPath = join(dir, entry.name);
				if (entry.isDirectory()) {
					visit(fullPath);
					continue;
				}
				if (!entry.name.endsWith(".ts")) continue;
				const source = readFileSync(fullPath, "utf-8");
				if (banned.test(source)) offenders.push(fullPath);
			}
		};
		visit(srcRoot);
		assert.deepEqual(offenders, []);
	});
});
