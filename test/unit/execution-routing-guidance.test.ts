import assert from "node:assert/strict";
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
import { registerWorkflowTool } from "../../packages/workflows/src/extension/workflow-tool-registration.js";
import { moduleDir, readText } from "../helpers/runtime.js";

const repositoryRoot = resolve(moduleDir(import.meta.url), "../..");

async function readRepositoryFile(path: string): Promise<string> {
	return (await readText(resolve(repositoryRoot, path))).replaceAll("\r\n", "\n");
}

const combinedGuidance = [...workflowGuidance, ...subagentGuidance].join("\n");
const modelVisibleRouting = `${combinedGuidance}\n${WORKFLOW_TOOL_DESCRIPTION}\n${SUBAGENT_TOOL_DESCRIPTION}`;

const workflowDocumentationPaths = [
	"packages/coding-agent/docs/workflows.md",
	"packages/coding-agent/docs/workflows/builtins.md",
	"packages/coding-agent/docs/workflows/authoring.md",
	"packages/coding-agent/docs/workflows/reliable-design.md",
	"packages/coding-agent/docs/workflows/operations.md",
	"packages/coding-agent/docs/workflows/api-reference.md",
	"packages/coding-agent/docs/quickstart.md",
	"packages/coding-agent/docs/getting-started/first-session.md",
	"packages/workflows/README.md",
	"docs/workflow-playbook.md",
	"README.md",
];

describe("agent-decided workflow execution guidance", () => {
	// Inspect each caller location, not concatenated docs where a new contract
	// elsewhere can mask an obsolete opening. Keep authoring/lifecycle checks below.
	const callerSections = [
		["packages/workflows/README.md", "", "### Custom workflow directories"],
		["packages/coding-agent/docs/getting-started/first-session.md", "## First session", "## Verify the session"],
		["docs/workflow-playbook.md", "## The core loop", "## Prompt anatomy"],
		["packages/coding-agent/docs/workflows/reliable-design.md", "", "## Choosing an Execution Shape"],
		["packages/coding-agent/docs/workflows.md", "## When to Use Workflows", "| User need | Use |"],
	] as const;
	for (const [path, start, end] of callerSections) {
		test(`${path} caller entry lets the agent decide and run by workflow name`, async () => {
			const text = await readRepositoryFile(path);
			const from = text.indexOf(start);
			const to = text.indexOf(end, from);
			assert.ok(from >= 0 && to > from, `${path}: caller section exists`);
			const section = text.slice(from, to).replaceAll("`", "");
			for (const contract of [
				/The agent decides whether a workflow fits/,
				/explicit request to work inline, quickly or without a workflow stays inline/,
				/input contract.*workflow run with the registered workflow name and inputs/,
				/Ask only for genuinely missing information/,
			])
				assert.match(section, contract, path);
			assert.doesNotMatch(section, /workflow route|workflowId|routerDecision/, path);
		});
	}
	for (const path of workflowDocumentationPaths) {
		test(`${path} has no caller selection defaults or run-as-router instructions`, async () => {
			const text = (await readRepositoryFile(path)).replaceAll("`", "");
			for (const obsolete of [
				/default to (?:a )?workflows? for/i,
				/workflow[- ]first/i,
				/reserve direct chat for/i,
				/requests? (?:are|is) workflow candidates/i,
				/(?:multiple subtasks|handoffs|parallel slices).*rule out inline/i,
				/(?:loop|gate|cycle).*requires a workflow/i,
				/task earns a workflow|ten[- ]call rule|\d+[–-]\d+ total|hard signal overrides/i,
				/model-tool run[^\n]*supply[^\n]*state/i,
				/workflow plus inputs/i,
				/workflow route|action: "route"|routerDecision|estimatedDuration|state\.userBudget/,
			])
				assert.doesNotMatch(text, obsolete, path);
		});
	}
	test("README lifecycle guidance preserves one resume identity", async () => {
		const text = await readRepositoryFile("packages/workflows/README.md");
		const section = text.slice(
			text.indexOf("### Workflow lifecycle notifications"),
			text.indexOf("## Authoring API"),
		);
		assert.doesNotMatch(section, /(?:fresh|new) run id|notice names both/i);
		assert.match(section, /resume.*same (?:workflow|execution|run) id/i);
	});
	test("lets the agent decide inline versus workflow and launch by registered name", () => {
		for (const phrase of [
			"Decide yourself whether a workflow fits",
			"Work inline for brainstorming",
			"Honor an explicit user request for a named workflow",
			"call workflow run with the registered workflow name",
			"input contract",
			"Ask only for genuinely missing information",
			"missing, sparse, or mostly inline workflow history is not by itself a reason to work inline",
		])
			expect(modelVisibleRouting).toContain(phrase);
		for (const removed of ["workflow route", "workflowId", "routerDecision", "estimatedDuration", "state.userBudget"])
			expect(modelVisibleRouting).not.toContain(removed);
		for (const obsolete of [
			"Budget reconnaissance",
			"roughly ten exploratory tool calls",
			"workflow-architecture pass",
			"Run every slice through a child workflow",
			"broad repository uncertainty →",
			"Every model-tool run",
		])
			expect(workflowGuidance.join("\n")).not.toContain(obsolete);
	});
	test("retains workflow authoring and internal composition without caller preselection", () => {
		for (const phrase of [
			"custom TypeScript workflow({...})",
			"reload",
			"ctx.workflow",
			"consuming only declared outputs",
			"approval",
		])
			expect(modelVisibleRouting).toContain(phrase);
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

	test("requires consulting factual evals and configured catalog when pinning stage models", () => {
		const authoringGuidance = workflowGuidance.join("\n");
		for (const phrase of [
			"packages/coding-agent/docs/models/model-selection.md",
			"packages/coding-agent/docs/models/evals.md",
			"factual per-evaluation benchmark records",
			'workflow({ action: "models" })',
			"returned `fullId` values as model strings",
			"availableThinkingLevels",
			"treat an absent or empty `availableThinkingLevels` as no suffix support",
			"no catalog model matches the documented evidence and role constraints",
			"leave the stage unpinned rather than inventing a substitute",
			"state that no configured models were returned, and do not fabricate model IDs",
			"Do not inspect or infer credentials, environment variables, auth files, token validity, entitlements",
			"`isCurrent` marks the active selection, not a quality recommendation",
		]) {
			expect(authoringGuidance).toContain(phrase);
		}
	});

	test("allocates mixed-role thinking effort by failure cost instead of blanket max", async () => {
		const authoringGuidance = workflowGuidance.join("\n");
		const modelSelection = await readRepositoryFile("packages/coding-agent/docs/models/model-selection.md");

		expect(authoringGuidance).toContain(
			"apply the stage role and failure-cost policy independently to the primary and every fallback",
		);

		for (const phrase of [
			"Benchmark results are measurements under named harnesses",
			"measurement configuration for that row",
			"`max` is an exception, not a default.",
			"| Coding, implementation, routine fixes | `low` or `medium` |",
			"| Code review, test design, failure analysis, security, identity, adversarial challenge, final approval | `high` or `xhigh` |",
			"| Codebase mapping, lifecycle analysis, compatibility, planning, synthesis, triage | `high` |",
			"| User-impact review and final reporting | `medium`",
			"| Deterministic checks | No model call",
		]) {
			expect(modelSelection).toContain(phrase);
		}

		for (const blanketDefault of [
			"gpt-5.6-luna [max]` as the workhorse",
			"gpt-5.6-terra [max]` as a balanced default",
		]) {
			expect(modelSelection).not.toContain(blanketDefault);
		}
	});

	test("lets explicit thinking requests override role defaults and applies the policy to fallbacks", async () => {
		const authoringGuidance = workflowGuidance.join("\n");
		const modelSelection = await readRepositoryFile("packages/coding-agent/docs/models/model-selection.md");

		for (const phrase of [
			"apply the stage role and failure-cost policy independently to the primary and every fallback",
			"An explicit user request for a level overrides the role default",
		]) {
			expect(authoringGuidance).toContain(phrase);
		}

		for (const phrase of [
			"`max` is an exception, not a default.",
			"An explicit user request wins over these defaults, but the requested level must exist for the selected catalog entry.",
			"Do not invent unsupported suffixes.",
			"If `xhigh` is unavailable, use `high` rather than automatically promoting to `max`; choose another catalog model or leave the stage unpinned if neither fits.",
		]) {
			expect(modelSelection).toContain(phrase);
		}
	});

	test("rejects invented thinking levels and requires the compact assignment before launch", () => {
		const authoringGuidance = workflowGuidance.join("\n");
		for (const phrase of [
			"append a thinking suffix only when that exact level appears in the entry's `availableThinkingLevels`",
			"treat an absent or empty `availableThinkingLevels` as no suffix support",
			"never fabricate an unsupported catalog level",
		]) {
			expect(authoringGuidance).toContain(phrase);
		}
	});

	test("mirrors the stage assignment policy in workflow authoring docs", async () => {
		for (const path of ["packages/coding-agent/docs/workflows/reliable-design.md", "packages/workflows/README.md"]) {
			const documentation = await readRepositoryFile(path);
			for (const phrase of [
				"failure cost",
				"primary model",
				"thinking level",
				"fallback policy",
				"Stage | Model | Thinking | Role",
				path.endsWith("reliable-design.md")
					? "`max` is an exception justified by task-specific evidence or an explicit user request, not a role default"
					: "high-cost-of-error roles",
				"deterministic checks as tool nodes with no model call",
				"fallback",
				"availableThinkingLevels",
				"leave the stage unpinned rather than inventing",
			]) {
				expect(documentation, path).toContain(phrase);
			}
			if (path.endsWith("reliable-design.md")) {
				// #2847 reconciliation: current upstream model selection supersedes the older role default.
				for (const phrase of [
					"Use `low` or `medium` for implementation and routine fixes",
					"`high` or `xhigh` for code review, test design, failure analysis, and approval decisions when supported",
					"approve | <catalog fullId> | high | final approval",
				])
					expect(documentation, path).toContain(phrase);
				expect(documentation, path).not.toContain("approve | <catalog fullId> | max | final approval");
			}
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
		]) {
			expect(modelVisibleRouting).toContain(phrase);
		}
	});

	test("does not require a caller architecture pass before routing", () => {
		expect(workflowGuidance.join("\n")).not.toContain("workflow-architecture pass");
		expect(workflowGuidance.join("\n")).toContain("Read the workflow docs/examples");
	});
	test("sizes the unit of verified implementation work", () => {
		const authoringGuidance = workflowGuidance.join("\n");
		for (const phrase of [
			"roughly 100–500 changed lines",
			"between verification points",
			"by default",
			"genuinely atomic change",
			"stays one slice",
			"small objective is not split merely to reach a count",
		]) {
			expect(authoringGuidance).toContain(phrase);
		}
	});

	test("routes each implementation slice to a child workflow", () => {
		const authoringGuidance = workflowGuidance.join("\n");
		for (const phrase of [
			"For an authored multi-slice implementation graph",
			"own objective, evidence and bounded implement/review/repair lifecycle",
			"ctx.workflow(...)",
		]) {
			expect(authoringGuidance).toContain(phrase);
		}
	});

	test("stacks slices on the previous verified branch", () => {
		const authoringGuidance = workflowGuidance.join("\n");
		for (const phrase of [
			"Slice N+1 must be created from slice N's verified branch",
			"explicit branch input",
			"create or check out that named branch in its worktree with a durable `ctx.tool(...)` step",
			"`base_branch` and `git_worktree_dir` alone do not create/check out a feature branch",
			"pass that branch as `base_branch`",
			"distinct worktree",
		]) {
			expect(authoringGuidance).toContain(phrase);
		}
	});

	test("stops the stack at the first unverified slice", () => {
		const authoringGuidance = workflowGuidance.join("\n");
		for (const phrase of [
			"Verify each slice before proceeding",
			"stop at the first unverified slice",
			"earlier verified slices remain verified",
			"reported as such",
			"do not roll them back or continue past the failure",
		]) {
			expect(authoringGuidance).toContain(phrase);
		}
	});

	test("documents the complete stacked-slices starter section", async () => {
		const documentation = await readRepositoryFile("packages/coding-agent/docs/workflows/reliable-design.md");
		const heading = "##### Stacked implementation slices starter pattern";
		const sectionStart = documentation.indexOf(heading);
		expect(sectionStart).toBeGreaterThanOrEqual(0);
		const sectionEnd = documentation.indexOf("\n#### Choosing a common workflow pattern", sectionStart);
		expect(sectionEnd).toBeGreaterThan(sectionStart);
		const section = documentation.slice(sectionStart, sectionEnd);

		for (const phrase of [
			"Stacked implementation slices",
			"prepare branch/worktree",
			"Give every slice its own objective",
			"prepareSliceWorktree",
			"slice1_branch",
			"git worktree add -b",
			"base_branch: slice1Branch",
			"stop at the first failed gate",
		]) {
			expect(section).toContain(phrase);
		}

		expect(documentation).toContain("splitting a queue across runs");
		expect(documentation).toContain("splitting one objective across slices");
	});

	test("requires dynamic workflow topologies to remain acyclic", async () => {
		const authoringGuidance = workflowGuidance.join("\n");
		const documentation = (
			await Promise.all(
				[
					"packages/coding-agent/docs/workflows/authoring.md",
					"packages/coding-agent/docs/workflows/reliable-design.md",
				].map(readRepositoryFile),
			)
		).join("\n");
		const rootReadme = await readRepositoryFile("README.md");

		for (const phrase of [
			"imperative, dynamic TypeScript",
			"Discovery validates module loading, imports, and definition shape",
			"does not compile `run` into a complete graph or prove acyclicity",
			"Cyclic workflow graphs are unsupported",
			"MUST NOT create self-edges or dependency edges from the current frontier to an existing ancestor",
			"Redesign or stop before launch",
			"distinct tracked work for every iteration",
			"incremental edge checks",
			"DBOS hydration validation",
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
		const documentation = await readRepositoryFile("packages/coding-agent/docs/workflows/reliable-design.md");
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

	test("keeps selection guidance free of caller trigger lists", () => {
		expect(modelVisibleRouting).not.toContain("independent slices → Fan-out-and-synthesize");
	});

	test("mirrors risk/evidence routing and verifier-loop guidance in workflow docs", async () => {
		const documentation = await readRepositoryFile("packages/coding-agent/docs/workflows/reliable-design.md");

		for (const phrase of [
			"pre-launch workflow architecture",
			"requirement/risk | required evidence | workflow/stage that produces it | gap",
			'Do not treat "has reviewers" as proof that a task-specific risk is covered',
			"Does an installed graph supply complete coverage?",
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
			"workflowId",
			"state",
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

	test("continues through blocked status unless human input must settle ambiguity", () => {
		for (const phrase of [
			"Treat a blocked run as continuable by default",
			"unless the user requests inline/no-workflow execution",
			"safely holding/stopping the affected run",
			"reconciling completed work and in-flight effects",
			"continuing inline without duplication",
			"When human input is unavailable",
			"do not stall on a question",
			"mine git history, commits, PRs, issues",
			"record the assumption and rationale",
			"continue fully autonomously on best judgment",
		]) {
			expect(modelVisibleRouting).toContain(phrase);
		}
	});

	test("asks the user before proceeding past an exhausted budget", () => {
		for (const phrase of [
			"A budget-exceeded stop (the resumable `budget_exceeded` blocked rail) is the exception",
			"do not raise it silently",
			"Summarize progress and the estimated next steps",
			"ask the user whether to proceed",
			"ask the user whether to proceed using the `ask_user_question` tool",
			"resume with a raised `budget` only after approval",
		]) {
			expect(modelVisibleRouting).toContain(phrase);
		}
	});

	test("mirrors blocked-continuation guidance in workflow docs", async () => {
		for (const path of ["packages/coding-agent/docs/workflows/operations.md", "packages/workflows/README.md"]) {
			const documentation = await readRepositoryFile(path);
			for (const phrase of [
				"continuable by default",
				"inline/no-workflow",
				"completed work",
				"in-flight",
				"authorization",
				"budget_exceeded",
				"approval",
			]) {
				expect(documentation, path).toContain(phrase);
			}
		}
	});

	test("documents positive workflow communication and control guidance", () => {
		for (const phrase of [
			"In interactive chat, named workflow launches run in the background",
			"`/workflow connect <run>`",
			"see agents working",
			"chat with and steer each stage",
			"Inspection and control calls",
			"`status`, `stages`, `stage`, `transcript`, `answer`, `pause`, `resume`, `quit`",
			"A heartbeat is a periodic alignment check",
			"continue a progressing run when no intervention is needed",
			"Send free-form updates through Intercom",
			"`workflow:<rootRunId>/<segment>[/<segment>...]`",
			"delivers immediately to live stages",
			"before their first model turn",
			"Use `ask` once the target has a live session that can reply",
		]) {
			expect(combinedGuidance).toContain(phrase);
		}
	});

	test("keeps subagents complementary without universal delegation", () => {
		for (const phrase of [
			"focused specialist work inside workflows",
			"Launch with workflow run using the registered workflow name",
			"single subagent",
			"parallel tasks",
			"debugger subagent for actual failures",
		]) {
			expect(modelVisibleRouting).toContain(phrase);
		}

		for (const obsoletePolicy of [
			"workflows are the default for non-trivial structured work",
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
			"packages/coding-agent/docs/models/evals.md",
			"factual per-evaluation benchmark records",
			'workflow({ action: "models" })',
			"Pin only a returned fullId",
			"thinking level listed for that entry",
			"no catalog model matches the documented evidence and role constraints",
			"leave the child unpinned",
			"Do not inspect credentials",
			"Workflow stages automatically receive their invocation-scoped Intercom group",
			"inherit the launching session's group",
			"single, parallel, and follow-up work",
			"Do not create or propagate group identifiers",
			"explicit group only for an intentional topology override",
			"contact_supervisor available for cross-group escalation",
		]) {
			expect(guidance).toContain(phrase);
		}
	});

	test("retains custom workflow authoring references without workflow-first mandates", async () => {
		const documentation = (await Promise.all(workflowDocumentationPaths.map(readRepositoryFile))).join("\n");

		for (const phrase of [
			"custom TypeScript",
			"workflow({...})",
			"dynamic fan-out",
			"adversarial verification",
			"bounded loop",
			"@bastani/atomic/workflows/builtin",
			"ctx.workflow(...)",
			"Nested children",
			"maxDepth",
		]) {
			expect(documentation).toContain(phrase);
		}

		for (const regressionPhrase of ["workflow tool's create action", '`action: "create"` to create a workflow']) {
			expect(documentation).not.toContain(regressionPhrase);
		}
	});

	test("synchronizes side-effect guidance across workflow authoring references", async () => {
		for (const path of ["packages/coding-agent/docs/workflows/authoring.md", "packages/workflows/README.md"]) {
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

	test("keeps compact workflows in one file and rejects arbitrary splitting", () => {
		const authoringGuidance = workflowGuidance.join("\n");
		for (const phrase of [
			"Keep a small, readable workflow in one entry file",
			"Do not split short one-use prompts",
			"create one file per stage",
			"wrapper-only modules",
			"hide the graph across files",
			"line counts alone as a module boundary",
		]) {
			expect(authoringGuidance).toContain(phrase);
		}
	});

	test("extracts cohesive workflow concerns only at meaningful source boundaries", () => {
		const authoringGuidance = workflowGuidance.join("\n");
		for (const phrase of [
			"meaningful source boundary",
			"improves clarity, reuse, ownership, or testability",
			"keep the graph and control flow in the top-level workflow entry file",
			"cohesive concerns",
			"long or reused prompt builders",
			"shared TypeBox schemas and workflow-specific types",
			"model-policy constants shared by several stages",
			"deterministic helpers with their own testable behavior",
			"reusable child workflow definitions",
			"subdirectory below the top-level discovery directory",
			"shared support directory",
			"top-level `.ts`/`.js`/`.mjs`/`.cjs` files in the workflow directory",
			"not scanned as extra top-level workflow candidates",
			"`.js` import extensions from TypeScript source",
		]) {
			expect(authoringGuidance).toContain(phrase);
		}
	});

	test("registers exact live and queued Intercom steering guidance on the workflow tool", async () => {
		let registered: { description: string } | undefined;
		const returned = registerWorkflowTool(
			{
				registerTool(tool: { description: string }) {
					registered = tool;
				},
			} as never,
			async () => ({ action: "list", items: [] }),
			async (_policy, operation) => operation(),
		);
		expect(returned).toBeDefined();
		expect(registered?.description).toBe(WORKFLOW_TOOL_DESCRIPTION);
		assert.ok(
			registered?.description.includes("When steering or communication is useful, use Intercom."),
			"workflow tool description should direct communication through Intercom",
		);
		assert.ok(
			registered?.description.includes("Before steering a stage, join its invocation group"),
			"workflow tool description should require joining the invocation group before steering",
		);
		expect(registered?.description).toContain(
			"Live delivery is immediate; a known stage that has not started is queued and receives the message before its first model turn.",
		);
		expect(registered?.description).toContain("Use `ask` only for a reply-capable live session.");
		assert.ok(
			registered?.description.includes("Intercom `groups` action to discover it"),
			"workflow tool description should explain invocation-group discovery",
		);
		assert.ok(
			registered?.description.includes("Workflow invocation groups are named `workflow:<rootRunId>`"),
			"workflow tool description should document invocation-group names",
		);
		expect(registered?.description).toContain("`workflow:<rootRunId>/<segment>[/<segment>...]`");
		expect(registered?.description).toContain("`*` matches one segment and `**` any depth");
		expect(registered?.description).toContain("`intercom list` inside the invocation group");
		expect(registered?.description).toContain("Name and pattern sends remain sticky for every future matching stage");
		expect(registered?.description).toContain("broadcast one authoritative update to `workflow:<rootRunId>/**`");
		expect(registered?.description).toContain("`notInKnownSet` warning");
		expect(registered?.description).toContain("settles undeliverable at terminal only if never delivered");
		expect(registered?.description).toContain("answer pending prompts");
		expect(registered?.description).toContain("pause/resume/quit runs");
		expect(registered?.description).not.toMatch(/workflow send|action ['"]send['"]/i);

		const readme = await readRepositoryFile("packages/workflows/README.md");
		for (const sharedGuidance of [
			"`workflow:<rootRunId>/<segment>[/<segment>...]`",
			"broadcast one authoritative update to `workflow:<rootRunId>/**`",
			"`notInKnownSet` warning",
			"use `ask` only on live targets",
		]) {
			expect(readme).toContain(sharedGuidance);
		}
	});

	test("documents directional invocation control before workflow-stage steering", async () => {
		// Regression: #2784
		// Pin exact sentences rather than bare substrings. A substring like "owned" also matches
		// "non-owned", so it would pass against guidance stating the opposite of this contract.
		const routingGuidance = workflowGuidance.join("\n");
		assert.ok(
			routingGuidance.includes("workflow:<rootRunId>"),
			"workflow routing guidance should name the invocation group",
		);
		assert.ok(
			routingGuidance.includes(
				"The invocation context may list and exactly send/ask live stages in its owned subgroups and queue send to known pending stages; this authority is directional and does not let subgroup siblings see or reach each other.",
			),
			"workflow routing guidance should state the directional invocation-control invariant verbatim",
		);

		const exactGuidance: Record<string, string> = {
			"packages/intercom/skills/intercom/SKILL.md":
				"The invocation context can control owned isolated subgroups by exact target, while sibling subgroups and other runs remain isolated.",
			"packages/coding-agent/docs/intercom/reference.md":
				"The invocation group has asymmetric exact-target control over its owned subgroups; ownership does not grant reverse or lateral access.",
		};
		for (const [path, sentence] of Object.entries(exactGuidance)) {
			const guidance = await readRepositoryFile(path);
			assert.ok(guidance.includes("workflow:<rootRunId>"), `${path} should name the invocation group`);
			assert.ok(
				guidance.includes(sentence),
				`${path} should state the invocation-control invariant verbatim: ${sentence}`,
			);
		}
	});

	test("keeps live workflow communication status, help, docs, and examples on supported actions", async () => {
		const liveGuidancePaths = [
			"packages/workflows/src/extension/workflow-tool-content.ts",
			"packages/workflows/src/extension/workflow-status-summary.ts",
			"packages/workflows/src/extension/workflow-prompts.ts",
			"packages/workflows/src/extension/workflow-schema.ts",
			"packages/workflows/README.md",
			"packages/coding-agent/docs/workflows/operations.md",
			"scripts/readme-feature-wall/tapes/6.2.tape",
		];
		const staleWorkflowSendGuidance = [
			"workflow send",
			'workflow({ action: "send"',
			"workflow({ action: 'send'",
			"pause/resume/interrupt/quit/send",
			"`pause`/`resume`/`interrupt`/`quit`/`send`",
			"send also takes stageId/promptId",
			"messaging on nonterminal root runs and run control: `send`",
			"For mutating actions (`reload`, `run`, `send`",
			"Inspection and control calls (`status`, `stages`, `stage`, `transcript`, `send`",
			"stage/prompt ids that `send` accepts",
		];

		for (const path of liveGuidancePaths) {
			const currentGuidance = await readRepositoryFile(path);
			for (const stale of staleWorkflowSendGuidance)
				expect(currentGuidance, `${path}: ${stale}`).not.toContain(stale);
		}

		const documentation = await readRepositoryFile("packages/coding-agent/docs/workflows/operations.md");
		for (const current of [
			"`answer` responds only to a pending primitive or structured human-input prompt",
			"Use `workflow resume` only for paused workflow control",
			"ordinary Intercom to",
			"delivers immediately to live stages",
			"delivering them before their first model turn",
			"Use `ask` once the target has a reply-capable live session",
		]) {
			expect(documentation).toContain(current);
		}

		const readme = await readRepositoryFile("packages/workflows/README.md");
		expect(readme).toContain(
			"Workflow `answer` handles pending human-input prompts, and workflow `resume` handles paused run control.",
		);
		expect(readme).not.toContain("the workflow tool's existing run-control `send` action");
	});

	test("keeps source-layout policy aligned across workflow authoring docs", async () => {
		const sharedPolicyPhrases = [
			/Keep a small(?:, readable)? workflow in one (?:readable )?entry file/,
			"meaningful source boundary",
			"improves clarity, reuse, ownership, or testability",
			"keep the graph and control flow in the top-level workflow entry file",
			"cohesive concerns",
			"long or reused prompt builders",
			"shared TypeBox schemas and workflow-specific types",
			"model-policy constants shared by several stages",
			"deterministic helpers with their own testable behavior",
			"reusable child workflow definitions",
			"subdirectory below the top-level discovery directory",
			"shared support directory",
			"top-level `.ts`/`.js`/`.mjs`/`.cjs` files in the workflow directory",
			"not scanned as extra top-level workflow candidates",
			"`.js` import extensions from TypeScript source",
			"short one-use prompts",
			"one file per stage",
			"wrapper-only modules",
			"hide the graph across files",
			/[Ll]ine counts alone (?:as|are not) a module boundary/,
		];
		for (const path of ["packages/coding-agent/docs/workflows/authoring.md", "packages/workflows/README.md"]) {
			const documentation = await readRepositoryFile(path);
			for (const phrase of sharedPolicyPhrases) {
				expect(documentation, path).toMatch(phrase);
			}
			for (const layoutLine of [
				".atomic/workflows/code-review.ts",
				".atomic/workflows/code-review/prompts.ts",
				".atomic/workflows/code-review/schemas.ts",
				".atomic/workflows/code-review/model-policy.ts",
			]) {
				expect(documentation, path).toContain(layoutLine);
			}
		}
	});

	/**
	 * A budget the user never asked for truncates a healthy run at a boundary they
	 * did not choose, and the stop reads as a workflow failure rather than as an
	 * override the agent added. Heartbeats have the mirrored failure: a periodic
	 * alignment check gets read as an alarm, and the agent intervenes in, re-caps,
	 * or polls a run that was progressing.
	 */
	test("keeps the inherited budget and heartbeat cadence until the user asks", () => {
		for (const phrase of [
			"Pass budget only for a user-specified limit",
			"omission inherits and zero disables only its field",
			"Never convert an estimate into a cap",
			"Heartbeat cadence is 15 minutes by default",
			"Keep that interval unless the user explicitly asks for a different cadence",
			"A heartbeat is a periodic alignment check",
		]) {
			expect(modelVisibleRouting).toContain(phrase);
		}
	});

	test("keeps the runtime heartbeat default aligned with the guidance", async () => {
		const contract = await readRepositoryFile("packages/workflows/src/shared/workflow-heartbeat-contract.ts");
		// The guidance tells the model to assume 15 minutes; if the runtime default
		// ever moves, the assumption becomes wrong rather than merely stale.
		expect(contract).toContain("DEFAULT_WORKFLOW_HEARTBEAT_INTERVAL_MINUTES = 15");
	});

	for (const path of [
		"packages/coding-agent/docs/workflows.md",
		"packages/coding-agent/docs/workflows/reliable-design.md",
	]) {
		test(`${path} keeps agent-owned selection without preannounced graphs`, async () => {
			const text = await readRepositoryFile(path);
			for (const contradiction of [
				/self-prompt an orchestrating agent should run before the first tool call/i,
				/Choose the execution shape before starting substantive work/i,
				/Before launch, state the selected graph/i,
				/Before launch, report a completion range/i,
				/override the routing rubric/i,
				/Treat "quickly" as an inline execution choice/i,
			])
				assert.doesNotMatch(text, contradiction, path);
			assert.match(text, /The agent decides whether a workflow fits/);
			assert.match(text, /An estimate is not (?:measured timing|a budget)/);
			if (path.endsWith("reliable-design.md")) {
				assert.match(
					text,
					/following architecture pass applies only to deliberate definition authoring and composition/,
				);
				assert.match(text, /For an authored graph, document/);
			}
		});
	}
});
