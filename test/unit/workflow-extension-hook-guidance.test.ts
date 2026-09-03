import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { DEFAULT_PROMPT_GUIDANCE } from "../../packages/workflows/src/extension/workflow-prompts.js";
import { moduleDir, readText } from "../helpers/runtime.js";

const repositoryRoot = resolve(moduleDir(import.meta.url), "../..");
const authoringGuidance = DEFAULT_PROMPT_GUIDANCE.join("\n");
const workflowDocumentationPaths = [
	"packages/coding-agent/docs/workflows/authoring.md",
	"packages/workflows/README.md",
];

async function readRepositoryFile(path: string): Promise<string> {
	return (await readText(resolve(repositoryRoot, path))).replaceAll("\r\n", "\n");
}

describe("workflow extension-hook authoring guidance", () => {
	test("keeps the workflow and extension responsibility boundary explicit and conditional", () => {
		for (const phrase of [
			"Evaluate Atomic extension hooks when a workflow needs fine-grained, cross-cutting tool or session event control",
			"Workflow TypeScript owns the inspectable DAG, stages, handoffs, durable",
			"extension hooks own cross-cutting session and model-tool policy",
			"`tool_call` interception, input mutation, or blocking",
			"`tool_result` transformation",
			"only when cross-stage or cross-workflow event control is materially clearer",
			"do not prescribe a companion extension for ordinary workflow logic",
		]) {
			expect(authoringGuidance).toContain(phrase);
		}
	});

	test("keeps companion extension dependencies explicit and inspectable", () => {
		for (const phrase of [
			"make the dependency explicit",
			"package and document it with the workflow",
			"extension-provided custom tools in stage `tools` allowlists",
			"document hook-driven behavior so the workflow remains inspectable",
			"packages/coding-agent/docs/extensions.md#events",
		]) {
			expect(authoringGuidance).toContain(phrase);
		}
	});

	test("keeps generated workflow source readable from the entry file", () => {
		for (const phrase of [
			"write it for human maintainers",
			"graph and control flow visible in the top-level workflow entry file",
			"stage names that state each stage's responsibility",
			"inputs, outputs, evidence, and success contract explicit",
			"graph, branches, gates, artifacts, and stop conditions",
			"monolithic prompt blobs",
			"one file per stage",
			"wrapper-only modules",
			"long or reused prompt builders",
			"shared TypeBox schemas and workflow-specific types",
			"reusable child workflow definitions",
		]) {
			expect(authoringGuidance).toContain(phrase);
		}
	});

	test("keeps both workflow documents synchronized with the material contract", async () => {
		for (const path of workflowDocumentationPaths) {
			const content = await readRepositoryFile(path);
			for (const phrase of [
				"Workflow and extension responsibilities",
				"Evaluate Atomic extension hooks when a workflow needs fine-grained, cross-cutting tool or session event control",
				"Workflow TypeScript owns the inspectable DAG, stages, handoffs, durable `ctx.tool` side effects, and gates",
				"`tool_call` interception, input mutation, or blocking",
				"`tool_result` transformation",
				"only when cross-stage or cross-workflow event control is materially clearer",
				"make that dependency explicit and package and document the extension with the workflow",
				"include any custom tools provided by the extension",
				"A developer reading the entry file from top to bottom",
				"monolithic prompt blobs",
			]) {
				expect(content, path).toContain(phrase);
			}
		}
	});
});
