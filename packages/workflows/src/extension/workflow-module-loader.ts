/**
 * Shared workflow module loading helpers.
 *
 * Discovery loads user-authored workflow files through this jiti instance so
 * TypeScript/ESM/CJS semantics and the @bastani/atomic/workflows SDK module
 * stay consistent.
 */

import { createJiti } from "jiti/static";
import * as typeboxModule from "typebox";
import * as typeboxCompileModule from "typebox/compile";
import * as typeboxValueModule from "typebox/value";
import adversarialVerification from "../../builtin/adversarial-verification.js";
import classifyAndAct from "../../builtin/classify-and-act.js";
import fanOutAndSynthesize from "../../builtin/fan-out-and-synthesize.js";
import generateAndFilter from "../../builtin/generate-and-filter.js";
import goal from "../../builtin/goal.js";
import loopUntilDone from "../../builtin/loop-until-done.js";
import openClaudeDesign from "../../builtin/open-claude-design.js";
import ralph from "../../builtin/ralph.js";
import * as steeringContext from "../../builtin/steering-context.js";
import tournament from "../../builtin/tournament.js";
import { isBrandedWorkflowDefinition } from "../authoring/workflow.js";
import * as workflowsSdkSurface from "../sdk-surface.js";
import { validateWorkflowBudget } from "../shared/budget.js";

const WORKFLOWS_MODULE_SPECIFIER = "@bastani/atomic/workflows";
const TYPEBOX_MODULE_SPECIFIER = "typebox";
// Keep this in sync with index.ts through sdk-surface.ts.
const WORKFLOWS_SDK_MODULE: Record<string, unknown> = {
	...workflowsSdkSurface,
};
const WORKFLOWS_BUILTIN_MODULE: Record<string, unknown> = {
	adversarialVerification,
	classifyAndAct,
	fanOutAndSynthesize,
	generateAndFilter,
	goal,
	loopUntilDone,
	openClaudeDesign,
	ralph,
	tournament,
};
const TYPEBOX_MODULE: Record<string, unknown> = {
	...typeboxModule,
};
function createWorkflowVirtualModules(moduleSpecifier: string): Record<string, unknown> {
	const builtinModuleSpecifier = `${moduleSpecifier}/builtin`;
	return {
		[moduleSpecifier]: WORKFLOWS_SDK_MODULE,
		[builtinModuleSpecifier]: WORKFLOWS_BUILTIN_MODULE,
		[`${builtinModuleSpecifier}/adversarial-verification`]: { default: adversarialVerification },
		[`${builtinModuleSpecifier}/classify-and-act`]: { default: classifyAndAct },
		[`${builtinModuleSpecifier}/fan-out-and-synthesize`]: { default: fanOutAndSynthesize },
		[`${builtinModuleSpecifier}/generate-and-filter`]: { default: generateAndFilter },
		[`${builtinModuleSpecifier}/goal`]: { default: goal },
		[`${builtinModuleSpecifier}/loop-until-done`]: { default: loopUntilDone },
		[`${builtinModuleSpecifier}/open-claude-design`]: { default: openClaudeDesign },
		[`${builtinModuleSpecifier}/ralph`]: { default: ralph },
		[`${builtinModuleSpecifier}/tournament`]: { default: tournament },
		[`${builtinModuleSpecifier}/steering-context`]: steeringContext,
	};
}
const TYPEBOX_COMPILE_MODULE: Record<string, unknown> = {
	...typeboxCompileModule,
};
const TYPEBOX_VALUE_MODULE: Record<string, unknown> = {
	...typeboxValueModule,
};

const WORKFLOWS_VIRTUAL_MODULES: Record<string, unknown> = {
	...createWorkflowVirtualModules(WORKFLOWS_MODULE_SPECIFIER),
	[TYPEBOX_MODULE_SPECIFIER]: TYPEBOX_MODULE,
	"typebox/compile": TYPEBOX_COMPILE_MODULE,
	"typebox/value": TYPEBOX_VALUE_MODULE,
};

export type WorkflowHostModules = Record<"@bastani/atomic" | "@bastani/pi-ai" | "@bastani/pi-ai/providers/all", object>;

export type WorkflowHostModuleProvider = () => Promise<WorkflowHostModules>;

function createWorkflowModuleLoader(virtualModules: Record<string, unknown>) {
	// Build a fresh jiti per load: jiti creates its filesystem cache directory only when an instance is constructed,
	// so a long-lived instance fails with ENOENT on every load after something (such as a /tmp cleanup) deletes it.
	return createJiti(import.meta.url, {
		moduleCache: false,
		// Keep workflow-file import semantics deterministic: jiti owns .ts/.js/.mjs/.cjs
		// resolution instead of handing some imports back to native import().
		tryNative: false,
		// Resolve the current SDK once while workflow files are evaluated fresh.
		virtualModules,
	});
}

function materializeModuleObject(mod: object): Record<string, unknown> {
	const materialized: Record<string, unknown> = {};

	// jiti's callable API can return an interop namespace proxy. Its own property
	// descriptors contain the authored export values, but property access may apply
	// default-export conveniences (and even expose a throwing inherited `then`
	// getter for `export default null`). Copy own descriptors into a plain object
	// so candidate collection sees the exact authored exports.
	for (const key of Object.getOwnPropertyNames(mod)) {
		const descriptor = Object.getOwnPropertyDescriptor(mod, key);
		if (descriptor === undefined) continue;

		const value = "value" in descriptor ? descriptor.value : descriptor.get?.call(mod);
		Object.defineProperty(materialized, key, {
			value,
			enumerable: descriptor.enumerable,
			configurable: true,
			writable: true,
		});
	}

	return materialized;
}

function normalizeWorkflowModule(mod: unknown): Record<string, unknown> {
	if (mod !== null && typeof mod === "object") {
		return materializeModuleObject(mod);
	}
	// CJS/default interop can return the exported value directly; wrap it so the
	// candidate collector can handle it the same way as an ESM default export.
	return { default: mod };
}

export interface WorkflowModuleCandidate {
	readonly value: unknown;
	readonly exportKey: string;
}

export function validateWorkflowDefinitionShape(value: unknown): string | null {
	if (value === null || typeof value !== "object") {
		return "export is not an object";
	}
	const d = value as Record<string, unknown>;

	if (d.__piWorkflow !== true) {
		return "missing or incorrect __piWorkflow sentinel (expected true); export a workflow from workflow({...})";
	}
	if (!isBrandedWorkflowDefinition(value)) {
		return "workflow definition is not produced by workflow({...}); hand-rolled __piWorkflow objects are not supported";
	}
	if (typeof d.name !== "string" || (d.name as string).trim().length === 0) {
		return "name must be a non-empty string";
	}
	if (typeof d.normalizedName !== "string" || (d.normalizedName as string).trim().length === 0) {
		return "normalizedName must be a non-empty string";
	}
	if (typeof d.run !== "function") {
		return "run must be a function";
	}
	if (d.budget !== undefined) {
		const reason = validateWorkflowBudget(d.budget, "budget");
		if (reason !== null) return reason;
	}
	return null;
}

export function loadWorkflowModule(filePath: string, hostModules?: WorkflowHostModules): Record<string, unknown> {
	const loader = createWorkflowModuleLoader(
		hostModules ? { ...WORKFLOWS_VIRTUAL_MODULES, ...hostModules } : WORKFLOWS_VIRTUAL_MODULES,
	);
	return normalizeWorkflowModule(loader(filePath));
}

export function collectWorkflowModuleCandidates(mod: Record<string, unknown>): WorkflowModuleCandidate[] {
	const candidates: WorkflowModuleCandidate[] = [];

	// Default export first (RFC §5.12: check mod.default before named exports)
	if ("default" in mod && mod.default !== undefined) {
		candidates.push({ value: mod.default, exportKey: "default" });
	}

	// Then all named exports (a file may export multiple workflow definitions)
	for (const [key, val] of Object.entries(mod)) {
		if (key === "default") continue;
		if (val !== undefined) {
			candidates.push({ value: val, exportKey: key });
		}
	}

	return candidates;
}
