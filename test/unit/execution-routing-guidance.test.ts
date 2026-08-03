import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import { DEFAULT_PROMPT_GUIDANCE as subagentGuidance } from "../../packages/subagents/src/extension/prompt-guidance.js";
import { SUBAGENT_TOOL_DESCRIPTION } from "../../packages/subagents/src/extension/tool-description.js";
import {
	WORKFLOW_TOOL_DESCRIPTION,
	DEFAULT_PROMPT_GUIDANCE as workflowGuidance,
} from "../../packages/workflows/src/extension/workflow-prompts.js";
import { WorkflowParametersSchema } from "../../packages/workflows/src/extension/workflow-schema.js";
import { moduleDir, readText } from "../helpers/runtime.js";

const repositoryRoot = resolve(moduleDir(import.meta.url), "../..");

async function readRepositoryFile(path: string): Promise<string> {
	return (await readText(resolve(repositoryRoot, path))).replaceAll("\r\n", "\n");
}

const combinedGuidance = [...workflowGuidance, ...subagentGuidance].join("\n");
const modelVisibleRouting = `${combinedGuidance}\n${WORKFLOW_TOOL_DESCRIPTION}\n${SUBAGENT_TOOL_DESCRIPTION}`;

const workflowDocumentationPaths = [
	"packages/coding-agent/docs/workflows.md",
	"packages/coding-agent/docs/quickstart.md",
	"packages/coding-agent/src/core/atomic-guide-command.ts",
	"packages/workflows/README.md",
	"docs/workflow-playbook.md",
	"README.md",
];

describe("workflow-first execution routing", () => {
	test("restores workflows as the default for non-trivial verifiable work", () => {
		for (const phrase of [
			"default execution path for any non-trivial task",
			"inherent structure plus an objective you can make verifiable",
			"implementation, build, debug/diagnosis, bug-fix, migration, new-feature",
			"multiple steps, dependencies, handoffs, uncertainty",
			"Only skip workflows for tiny, deterministic, low-risk",
		]) {
			expect(modelVisibleRouting).toContain(phrase);
		}
	});

	test("keeps early routing guidance without forcing a mode announcement", () => {
		for (const phrase of [
			"Budget reconnaissance",
			"roughly ten exploratory tool calls",
			"Sunk inline research transfers through files",
		]) {
			expect(modelVisibleRouting).toContain(phrase);
		}

		for (const forcedAnnouncement of [
			"Decide the execution mode before your first tool call",
			"state it in one short line: inline",
		]) {
			expect(modelVisibleRouting).not.toContain(forcedAnnouncement);
		}
	});

	test("keeps all six core communication rules out of workflow promptGuidelines", () => {
		const modelVisibleWorkflowGuidance = workflowGuidance.join("\n");
		const coreCommunicationRules = [
			"Never use a familiar printed metaphor, simile, or figure of speech.",
			"Never use a long word where a short one will do.",
			"Cut every word that can be cut.",
			"Use active rather than passive voice where possible.",
			"Prefer everyday English to foreign phrases, scientific terms, and jargon.",
			"Break any rule rather than say anything outright barbarous.",
		];

		expect(modelVisibleWorkflowGuidance).not.toContain("**Communication**:");
		for (const rule of coreCommunicationRules) {
			expect(modelVisibleWorkflowGuidance).not.toContain(rule);
		}
	});

	test("treats loop and stop-condition phrasing as a strong workflow signal", () => {
		for (const phrase of [
			"loop or stop-condition wording as a strong workflow signal",
			"do X until Y",
			"repeat until",
			"iterate until",
			"review/fix until passing",
			"run checks and fix until green",
			"keep going until done",
			"approval gate or evidence requirement",
		]) {
			expect(modelVisibleRouting).toContain(phrase);
		}
	});

	test("supports named and rich inline TypeScript workflows", () => {
		for (const phrase of [
			"builtin, project, user, or package",
			"custom TypeScript `workflow({...})` inline",
			"reload workflow resources",
			"Do not force-fit",
			"deterministic branching",
			"dynamic fan-out",
			"child workflows",
			"structured outputs",
			"human-in-the-loop prompts",
			"explicit stop conditions",
		]) {
			expect(modelVisibleRouting).toContain(phrase);
		}
	});

	test("teaches compositional imports and nested builtin workflows", () => {
		for (const phrase of [
			"Workflow definitions are normal TypeScript modules",
			"@bastani/workflows/builtin",
			"ctx.workflow(childDefinition, { inputs, stageName })",
			"Imported children may nest more workflows",
			"maxDepth",
			"expanded parent graph",
			"Pass definitions, not registry-name strings or paths",
			"nest `fanOutAndSynthesize` for repository mapping",
			"wrap `openClaudeDesign`",
			"consuming only declared outputs",
		]) {
			expect(modelVisibleRouting).toContain(phrase);
		}
	});

	test("guides authored workflows to checkpoint workflow-owned side effects", () => {
		const authoringGuidance = workflowGuidance.join("\n");
		for (const phrase of [
			"Prefer `ctx.tool(name, args, fn)`",
			"filesystem writes",
			"network mutations",
			"external API actions",
			"durably checkpointed",
			"resume replays that result without rerunning `fn`",
			"pure computation and side-effect-free transformations as ordinary TypeScript",
			"Do not wrap agent-stage internals or every function call indiscriminately",
			"side effects orchestrated directly by the workflow definition",
		]) {
			expect(authoringGuidance).toContain(phrase);
		}
	});

	test("requires consulting the model-selection guide and configured catalog when pinning stage models", () => {
		const authoringGuidance = workflowGuidance.join("\n");
		for (const phrase of [
			"packages/coding-agent/docs/models/model-selection.md",
			'workflow({ action: "models" })',
			"returned `fullId` values as model strings",
			"availableThinkingLevels",
			"treat an absent or empty `availableThinkingLevels` as no suffix support",
			"try another guide-recommended model that is present in the catalog",
			"leave the stage unpinned rather than inventing a substitute",
			"state that no configured models were returned, and do not fabricate model IDs",
			"Do not inspect or infer credentials, environment variables, auth files, token validity, entitlements",
			"`isCurrent` marks the active selection, not a quality recommendation",
		]) {
			expect(authoringGuidance).toContain(phrase);
		}
	});

	test("teaches documented starter patterns and concrete dynamic examples", () => {
		for (const phrase of [
			"Classify-and-act",
			"Fan-out-and-synthesize",
			"Adversarial verification",
			"Generate-and-filter",
			"Tournament",
			"Loop until done",
			"classify a request and dispatch category-specific stages",
			"fan out per package",
			"fresh-context verifiers",
			"tournament-rank",
			"max-iteration escape hatch",
		]) {
			expect(modelVisibleRouting).toContain(phrase);
		}
	});

	test("requires a pre-launch coverage pass and selected execution shape", () => {
		for (const phrase of [
			"workflow-architecture pass",
			"implementation lifecycle needs",
			"whole-codebase research needs",
			"exact API/type/build contracts",
			"schema or generated-artifact contracts",
			"state transitions/lifecycle behavior",
			"requirement/risk | required evidence | workflow/stage that produces it | gap",
			"covers the lifecycle and produces evidence for every material requirement/risk",
			'Do not treat "has reviewers" as proof that a task-specific risk is covered',
			"first named workflow launch commits the selected execution shape for the turn",
			"chain unplanned unrelated launches",
			"design one custom parent before launch",
			"Choose the cheapest graph",
			"Avoid decorative composition and duplicated research or review loops",
			"state the selected graph",
			"why one broad builtin is sufficient or insufficient",
			"evidence each major stage produces",
			"stop/repair conditions",
			"simple direct match may use one sentence",
		]) {
			expect(modelVisibleRouting).toContain(phrase);
		}
	});

	test("requires dynamic workflow topologies to remain acyclic", async () => {
		const authoringGuidance = workflowGuidance.join("\n");
		const documentation = await readRepositoryFile("packages/coding-agent/docs/workflows.md");
		const rootReadme = await readRepositoryFile("README.md");

		for (const phrase of [
			"imperative, dynamic TypeScript",
			"Discovery validates module loading, imports, and definition shape",
			"does not compile `run` into a complete graph or prove acyclicity",
			"Cyclic workflow graphs are unsupported",
			"MUST NOT create self-edges or dependency edges from the current frontier to an existing ancestor",
			"Redesign or stop before launch",
			"distinct tracked work for every iteration",
			"stable per-iteration identity and call order",
			"nested workflows through `ctx.workflow(...)` boundaries",
			"incremental edge checks",
			"DBOS hydration validation",
			"acyclic topology | node/edge sketch for branches and loops | architecture pass | unresolved back-edge",
		]) {
			expect(authoringGuidance).toContain(phrase);
		}

		for (const phrase of [
			"Discovery can report module import and definition-shape diagnostics",
			"TypeScript and discovery cannot prove arbitrary dynamic acyclicity",
			"Implement → Review → Validate",
			"Repair 1",
			"Review 2",
			"activity: processing follow-up",
			"never reopen an ancestor below its downstream work",
			"Which stages may repeat?",
			"What is the current frontier before each repeated stage?",
			"Could any proposed parent edge target an ancestor or the node itself?",
			"Are nested child workflows composed through boundaries rather than recursive `run` invocation?",
			"Does resume/replay rely on stable per-iteration identity and call order?",
		]) {
			expect(documentation).toContain(phrase);
		}

		expect(rootReadme).toContain(
			"authored loop and repair iterations must create distinct tracked work per iteration",
		);
		expect(rootReadme).toContain("Retries within one `ctx.tool(...)` call remain attempts on that tool node");
		expect(rootReadme).not.toContain("bounded loops and retries must create distinct tracked work");
	});

	test("routes independent implementation queues to bounded top-level runs", async () => {
		for (const phrase of [
			"enumerate every item before launch",
			"independent, dependent, or clustered",
			"For a mixed queue with dependent A → B and unrelated C",
			"prerequisites are already merged into each selected base",
			"compose only the A → B dependency cluster",
			"shared files, API contracts, migrations, generated artifacts",
			"Launch C as its own concurrent top-level named workflow with its own root failure boundary",
			'Do not infer a cross-item sequence from list order or from "create a PR after"',
			"does not put the whole queue in one parent",
			"Prove the dependency before serializing independent workflow items",
			"separate concurrent top-level named workflow runs with bounded concurrency",
			"complete bounded wave of planned per-item top-level launches",
			"item → run ID → worktree → branch → result/PR map",
			"first item's review, repair, or check failure must not block unrelated items",
			"checkout isolation, not concurrent top-level execution",
		]) {
			expect(workflowGuidance.join("\n")).toContain(phrase);
		}
		const documentation = await readRepositoryFile("packages/coding-agent/docs/workflows.md");
		for (const phrase of [
			"Interpret ordering words locally unless a cross-item dependency is explicit",
			"already merged into the base each run will use",
			"A shared unmerged contract can create a dependency",
			"Independent clusters with internal dependencies",
			"Workflow run isolation and Git worktree isolation are separate guarantees",
			"missing target is created as a detached checkout from `baseBranch`",
			"two independent top-level issue runs with a bound of 2",
			"Item | Run ID | Worktree | Branch | Result / PR",
			"does not cancel, pause, or roll back the first run",
			"failed child call normally fails its parent",
			"Lifecycle notices carry terminal status/error, not declared workflow outputs",
			"task-queue triage and bounded per-item dispatch rule",
			"detail.result.pr_url",
		]) {
			expect(documentation).toContain(phrase);
		}
		const statusInspectionSource =
			documentation.match(/After each terminal lifecycle notice[^\n]*\n\n```ts\n([\s\S]*?)\n```/)?.[1] ?? "";
		expect(
			[
				...statusInspectionSource.matchAll(
					/workflow\(\{\s*action: "status",\s*runId: "([^"]+)",\s*format: "json"\s*\}\)/g,
				),
			].map((match) => match[1]),
		).toEqual(["<run-id-for-#2101>", "<run-id-for-#2102>"]);
		const definitionMatch = documentation.match(/```ts\n\/\/ \.atomic\/workflows\/issue-to-pr\.ts\n([\s\S]*?)\n```/);
		expect(definitionMatch).not.toBeNull();
		const definitionSource = definitionMatch?.[1];
		if (definitionSource === undefined) throw new Error("issue-to-pr example definition is missing");
		for (const contract of [
			'name: "issue-to-pr"',
			'worktreeFromInputs: { gitWorktreeDir: "git_worktree_dir", baseBranch: "base_ref" }',
			"const cwd = ctx.cwd ?? ctx.inputs.git_worktree_dir",
			'["git", "switch", "-c", branch, baseRef]',
			'ctx.task("implement"',
			"ctx.task(`review-$" + "{round}`",
			"ctx.task(`repair-$" + "{round}`",
			"ctx.tool(`check-$" + "{index + 1}`",
			'["gh", "pr", "create"',
			'ctx.tool("push-feature-branch"',
		])
			expect(definitionSource).toContain(contract);
		const tempDirectory = await mkdtemp(resolve(repositoryRoot, "test", ".issue-to-pr-example-"));
		const definitionPath = resolve(tempDirectory, "issue-to-pr.ts");
		try {
			await writeFile(definitionPath, definitionSource);
			const loaded = (await import(`${pathToFileURL(definitionPath).href}?test=${Date.now()}`)) as {
				default: {
					readonly name: string;
					readonly inputs: Readonly<Record<string, object>>;
					readonly inputBindings?: {
						readonly worktree?: { readonly gitWorktreeDir: string; readonly baseBranch?: string };
					};
				};
			};
			expect(loaded.default.name).toBe("issue-to-pr");
			expect(Object.keys(loaded.default.inputs)).toEqual([
				"issue",
				"git_worktree_dir",
				"base_ref",
				"pr_base",
				"branch",
				"checks",
			]);
			expect(loaded.default.inputBindings?.worktree).toEqual({
				gitWorktreeDir: "git_worktree_dir",
				baseBranch: "base_ref",
			});
		} finally {
			await rm(tempDirectory, { recursive: true, force: true });
		}
	});

	test("retains every risk-based routing signal in model-visible guidance", () => {
		for (const phrase of [
			"broad repository uncertainty → Fan-out-and-synthesize with repository-focused branches",
			"independent slices → Fan-out-and-synthesize",
			"plausible-but-wrong contract risk → Adversarial verification",
			"competing architectures or implementations → Generate-and-filter or Tournament",
			"explicit repeat-until condition → Loop until done",
			"implementation lifecycle → a task-specific worker/reviewer loop",
			"exact API/build/schema requirements → dedicated deterministic gates",
		]) {
			expect(modelVisibleRouting).toContain(phrase);
		}
	});

	test("requires skeptical reviewer plans and authoritative verifier loops", () => {
		for (const phrase of [
			"fresh-context grumpy/skeptical-but-fair reviewer",
			"without invented requirements",
			"structured verifier plan",
			"exact probe, inputs, command/assertion, expected success condition, and requirement/risk covered",
			"direct task-specific `ctx.tool(...)` gates",
			"model select high-value probes through structured output",
			"compile, test, schema generation/validation, runtime, or artifact-inspection checks",
			"Actual tool results—not model self-report",
			"consolidated evidence-backed repair findings",
			"implementation child repairs them",
			"bounded pass, repair, failure, and iteration-limit conditions",
			"keep pure transformations as ordinary TypeScript",
			"do not wrap every model-stage action in a tool call",
			"how model-selected plans become tool executions",
			"how failures reach bounded repair",
		]) {
			expect(modelVisibleRouting).toContain(phrase);
		}
	});

	test("mirrors risk/evidence routing and verifier-loop guidance in workflow docs", async () => {
		const documentation = await readRepositoryFile("packages/coding-agent/docs/workflows.md");

		for (const phrase of [
			"pre-launch workflow architecture",
			"requirement/risk | required evidence | workflow/stage that produces it | gap",
			'Do not treat "has reviewers" as proof that a task-specific risk is covered',
			"Does an installed graph supply complete coverage?",
			"Broad repository uncertainty points to repository-focused Fan-out-and-synthesize",
			"implementation work to a task-specific worker/reviewer loop",
			"first named workflow launch commits the selected execution shape for the turn",
			"one custom parent",
			"Choose the cheapest complete graph",
			"grumpy/skeptical-but-fair reviewer",
			"without inventing requirements",
			"structured verifier plan",
			"direct task-specific `ctx.tool(...)` gates",
			"model select high-value probes in structured output",
			"The model must not self-report outcomes",
			"actual tool results",
			"consolidated, evidence-backed, bounded repair payload",
			"rerun the deterministic verifier tools",
			"pure transformations as ordinary TypeScript",
			"do not wrap every model-stage action in a tool call",
			"custom-loop pre-launch declaration",
		]) {
			expect(documentation).toContain(phrase);
		}
	});

	test("routes worktree isolation through declared named-workflow inputs", () => {
		for (const phrase of [
			"Natural-language instructions to create or use a worktree do not enable runner isolation",
			"named workflow must declare and implement any worktree and feature-branch inputs",
			"pass a distinct path and branch for each concurrent item",
			"existing same-repository worktree as-is; neither case checks out a separate feature-branch input",
		]) {
			expect(combinedGuidance).toContain(phrase);
		}
	});

	test("removes direct execution options from the workflow tool boundary", () => {
		const properties = WorkflowParametersSchema.properties as Record<string, unknown>;
		for (const removed of [
			"task",
			"tasks",
			"chain",
			"cwd",
			"worktree",
			"gitWorktreeDir",
			"concurrency",
			"failFast",
		]) {
			expect(properties).not.toHaveProperty(removed);
		}
	});

	test("keeps workflow lifecycle, transcript, and artifact handoff guidance", () => {
		for (const phrase of [
			"lifecycle notice",
			"Do not use sleep/status polling loops",
			"sessionFile",
			"transcriptPath",
			"files/artifacts",
			"Read the file at <path>",
		]) {
			expect(combinedGuidance).toContain(phrase);
		}
	});

	test("documents that named workflow launches run in the background", () => {
		for (const phrase of [
			"In interactive chat, named workflow launches run in the background",
			"`/workflow connect <run>`",
			"see agents working",
			"chat with and steer each stage",
			"Inspection and control calls",
			"`status`, `stages`, `stage`, `transcript`, `send`, `pause`, `resume`, `interrupt`, `quit`",
		]) {
			expect(combinedGuidance).toContain(phrase);
		}
	});

	test("keeps subagents complementary without universal delegation", () => {
		for (const phrase of [
			"focused specialist work inside workflows",
			"workflows are the default for non-trivial structured work",
			"single subagent",
			"chain",
			"parallel tasks",
			"debugger subagent for actual failures",
		]) {
			expect(modelVisibleRouting).toContain(phrase);
		}

		for (const obsoletePolicy of [
			"all non-trivial operations should be delegated",
			"spawn a debugger subagent first",
			"Prefer async mode for every subagent launch",
		]) {
			expect(modelVisibleRouting).not.toContain(obsoletePolicy);
		}
	});

	test("applies model and Intercom policy to every subagent orchestrator", () => {
		const guidance = subagentGuidance.join("\n");

		for (const phrase of [
			"each named agent use its declared model and fallback policy",
			"omit the explicit model argument",
			"documented task requirement",
			"Do not choose an ad hoc model merely for diversity",
			"packages/coding-agent/docs/models/model-selection.md",
			'workflow({ action: "models" })',
			"Pin only a returned fullId",
			"thinking level listed for that entry",
			"leave the child unpinned",
			"Do not inspect credentials",
			"Workflow stages automatically receive their invocation-scoped Intercom group",
			"inherit the launching session's group",
			"single, parallel, chain, async, and follow-up work",
			"Do not create or propagate group identifiers",
			"explicit group only for an intentional topology override",
			"contact_supervisor available for cross-group escalation",
		]) {
			expect(guidance).toContain(phrase);
		}
	});

	test("synchronizes workflow-first docs with custom workflow authoring", async () => {
		const documentation = (await Promise.all(workflowDocumentationPaths.map(readRepositoryFile))).join("\n");

		for (const phrase of [
			"Default to a workflow",
			"non-trivial",
			"verifiable objective",
			"custom TypeScript",
			"workflow({...})",
			"dynamic fan-out",
			"adversarial verification",
			"bounded loop",
			"@bastani/workflows/builtin",
			"ctx.workflow(...)",
			"Nested children",
			"maxDepth",
		]) {
			expect(documentation).toContain(phrase);
		}

		for (const regressionPhrase of [
			"Multiple steps, files, tests, validation, or parallelism alone do not require a workflow",
			"there is no fixed tool-call escalation threshold",
			"workflow tool's create action",
			'`action: "create"` to create a workflow',
		]) {
			expect(documentation).not.toContain(regressionPhrase);
		}
	});

	test("synchronizes side-effect guidance across workflow authoring references", async () => {
		for (const path of ["packages/coding-agent/docs/workflows.md", "packages/workflows/README.md"]) {
			const documentation = await readRepositoryFile(path);
			for (const phrase of [
				"ctx.tool(name, args, fn)",
				"workflow-owned",
				"filesystem writes",
				"network mutations",
				"external API actions",
				"without rerunning",
				"pure computation",
				"agent-stage internals",
				"every function call",
			]) {
				expect(documentation, path).toContain(phrase);
			}
		}
	});
});
