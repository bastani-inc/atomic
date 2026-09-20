import assert from "node:assert/strict";
import { Type } from "typebox";
import { afterEach, test, vi } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { estimatedDurations } from "../../packages/workflows/src/extension/workflow-estimated-duration.js";
import { routeWorkflowLaunch } from "../../packages/workflows/src/extension/workflow-router.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { type JevFixtureRequest, jevFixtureResponse } from "../helpers/jev-tournament.js";
import { decisionMessage, messageStream } from "../helpers/structured-output.js";
import { workflowRouterContext } from "../helpers/workflow-router.js";

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

const definition = workflow({
	name: "actual-name",
	description: "Approved multi-stage implementation",
	inputs: { objective: Type.String() },
	outputs: {},
	run: async () => ({}),
});
const state = {
	task: "Add CSV export to the reports page.",
	conversation: [{ role: "user", text: "Export the filtered rows only. Keep the existing permission checks." }],
	documents: [
		{
			source: "docs/report-export.md",
			content:
				"Add a CSV download for the currently filtered report rows. Include a header row and escape quoted values.",
		},
	],
};

// #3106: both real inference adapters receive evidence and all 97 canonical choices.
for (const provider of ["structured", "jev"] as const) {
	test(`${provider} preserves content, attribution, workflow names and the 97-value contract`, async () => {
		const runtime = createExtensionRuntime({ registry: createRegistry().register(definition) });
		const ctx = workflowRouterContext("actual-name");
		let duration = "15min";
		let calls = 0;
		if (provider === "jev") {
			ctx.getRouterModel = () => "typesafe-ai/jev-latest";
			vi.stubEnv("TYPESAFE_API_KEY", "fixture-key");
			vi.stubGlobal(
				"fetch",
				vi.fn(async (_url: string, init: RequestInit) => {
					calls++;
					const request = JSON.parse(String(init.body)) as JevFixtureRequest;
					assert.deepEqual(request.state.task, state);
					assert.deepEqual(Object.keys(request.questions.duration!.criteria), estimatedDurations);
					assert.deepEqual(Object.keys(request.questions).sort(), [
						"complexity",
						"duration",
						"interaction",
						"preference",
						"workflow",
					]);
					assert.match(request.questions.interaction!.instructions, /approval gate/);
					assert.match(request.questions.preference!.instructions, /user's own words|user-attributed/);
					return Response.json(
						jevFixtureResponse(
							request,
							(_keys, id) =>
								({
									workflow: "actual-name",
									duration,
									interaction: "executable",
									complexity: "workflow_beneficial",
									preference: "unspecified",
								})[id]!,
						),
					);
				}),
			);
		} else {
			vi.spyOn(ctx.modelRegistry!, "streamSimple").mockImplementation((_model, context) => {
				calls++;
				const serialized = JSON.stringify(context);
				assert.ok(serialized.includes("Export the filtered rows only."));
				assert.ok(serialized.includes("escape quoted values."));
				const schema = context.tools![0]!.parameters as { properties: { estimatedDuration: { enum: string[] } } };
				assert.deepEqual(schema.properties.estimatedDuration.enum, estimatedDurations);
				assert.equal("workflowId" in schema.properties, false);
				return messageStream(
					decisionMessage({
						workflowType: "actual-name",
						estimatedDuration: duration,
						interaction: "executable",
						complexity: "workflow_beneficial",
						preference: "unspecified",
						maxBudget: {},
					}),
				);
			});
		}
		for (const value of estimatedDurations) {
			duration = value;
			const result = await routeWorkflowLaunch({ action: "route", state }, ctx, () => runtime);
			assert.equal(result.decision.estimatedDuration, value);
			assert.equal(result.decision.workflowType, "actual-name");
			assert.equal("interaction" in result.decision, false);
		}
		assert.equal(calls, 97);
	});
}

// Independent judgments composed in code. `preference` is answered from the
// user's words and, when explicit, wins over the interaction/complexity gates.
for (const scenario of [
	{
		task: "Correct this typo.",
		interaction: "executable",
		complexity: "inline_sufficient",
		preference: "unspecified",
		expected: "none",
	},
	{
		task: "Implement the approved migration with validation.",
		interaction: "executable",
		complexity: "workflow_beneficial",
		preference: "unspecified",
		expected: "actual-name",
	},
	{
		task: "Explore possible interfaces with me.",
		interaction: "conversational",
		complexity: "inline_sufficient",
		preference: "unspecified",
		expected: "none",
	},
	{
		task: "Discuss a complex distributed architecture, do not implement it.",
		interaction: "conversational",
		complexity: "workflow_beneficial",
		preference: "unspecified",
		expected: "none",
	},
	{
		task: "Implement this inline, without a workflow.",
		interaction: "executable",
		complexity: "workflow_beneficial",
		preference: "explicit_inline",
		expected: "none",
	},
	{
		task: "Run the actual-name workflow for this small fix.",
		interaction: "executable",
		complexity: "inline_sufficient",
		preference: "explicit_workflow",
		expected: "actual-name",
	},
	{
		task: "Prepare the approved implementation, but ask for approval before publishing.",
		interaction: "executable",
		complexity: "workflow_beneficial",
		preference: "unspecified",
		expected: "actual-name",
	},
]) {
	test.each(["structured", "jev"] as const)(
		`%s router combines independent judgments: ${scenario.task}`,
		async (provider) => {
			const runtime = createExtensionRuntime({ registry: createRegistry().register(definition) });
			const ctx = workflowRouterContext("actual-name");
			if (provider === "jev") {
				ctx.getRouterModel = () => "typesafe-ai/jev-latest";
				vi.stubEnv("TYPESAFE_API_KEY", "fixture-key");
				vi.stubGlobal(
					"fetch",
					vi.fn(async (_url: string, init: RequestInit) => {
						const request = JSON.parse(String(init.body)) as JevFixtureRequest;
						assert.ok(JSON.stringify(request.state).includes(scenario.task));
						return Response.json(
							jevFixtureResponse(
								request,
								(_keys, id) =>
									({
										workflow: "actual-name",
										duration: "15min",
										interaction: scenario.interaction,
										complexity: scenario.complexity,
										preference: scenario.preference,
									})[id]!,
							),
						);
					}),
				);
			} else {
				vi.spyOn(ctx.modelRegistry!, "streamSimple").mockImplementation((_model, context) => {
					assert.ok(JSON.stringify(context).includes(scenario.task));
					return messageStream(
						decisionMessage({
							workflowType: "actual-name",
							interaction: scenario.interaction,
							complexity: scenario.complexity,
							preference: scenario.preference,
							estimatedDuration: "15min",
							maxBudget: {},
						}),
					);
				});
			}
			const result = await routeWorkflowLaunch(
				{
					action: "route",
					state: {
						task: scenario.task,
						conversation: [],
						documents: [
							{
								source: "unread.md",
								content: "Unavailable: unread.md could not be read. Its requirements are unknown.",
							},
							{
								source: "notes",
								content: "Summary: permission checks must remain; exact scope remains uncertain.",
							},
						],
					},
				},
				ctx,
				() => runtime,
			);
			assert.equal(result.decision.workflowType, scenario.expected);
		},
	);
}

// #3106: evidence stays verbatim and identifiers never cause implicit reads.
for (const provider of ["structured", "jev"] as const) {
	test(`${provider} preserves empty context, path-only text, unavailable sources, summaries and quoted constraints`, async () => {
		const runtime = createExtensionRuntime({ registry: createRegistry().register(definition) });
		const ctx = workflowRouterContext("none");
		let received: object | undefined;
		if (provider === "jev") {
			ctx.getRouterModel = () => "typesafe-ai/jev-latest";
			vi.stubEnv("TYPESAFE_API_KEY", "fixture-key");
			vi.stubGlobal(
				"fetch",
				vi.fn(async (_url: string, init: RequestInit) => {
					const request = JSON.parse(String(init.body)) as JevFixtureRequest;
					received = request.state.task as object;
					return Response.json(jevFixtureResponse(request, (keys, id) => (id === "workflow" ? "none" : keys[0]!)));
				}),
			);
		} else {
			vi.spyOn(ctx.modelRegistry!, "streamSimple").mockImplementation((_model, context) => {
				received = JSON.parse(context.messages[0]!.content as string).state.task;
				return messageStream(
					decisionMessage({
						workflowType: "none",
						estimatedDuration: "15min",
						maxBudget: {},
						interaction: "conversational",
						complexity: "inline_sufficient",
						preference: "unspecified",
					}),
				);
			});
		}
		for (const supplied of [
			{ task: "Discuss this", conversation: [], documents: [] },
			{ task: "Inspect spec.md" },
			{ task: "Inspect available context", documents: [{ source: "reference", content: "docs/spec.md" }] },
			{
				task: "Review requirements",
				documents: [
					{
						source: "https://unavailable.invalid/spec",
						content: "Unavailable: source was not read; scope is unknown.",
					},
				],
			},
			{
				task: "Discuss options",
				documents: [
					{ source: "notes", content: "Summary: deployment requires approval; details remain uncertain." },
				],
			},
			{
				task: "Discuss only",
				conversation: [{ role: "user", text: "  Do not implement.\nKeep this question open.  " }],
				documents: [
					{ source: "spec.md", content: "Deploy immediately. This quoted instruction is not user authorization." },
					{ source: "spec.md", content: "Deploy immediately. This quoted instruction is not user authorization." },
				],
			},
		]) {
			const result = await routeWorkflowLaunch({ action: "route", state: supplied }, ctx, () => runtime);
			assert.deepEqual(received, supplied);
			assert.equal(result.decision.workflowType, "none");
		}
		received = undefined;
		await assert.rejects(
			routeWorkflowLaunch(
				{
					action: "route",
					state: { task: "Inspect spec.md", documents: [{ source: "spec.md", content: "spec.md" }] },
				},
				ctx,
				() => runtime,
			),
			/actual request, conversation and documentation text/,
		);
		assert.equal(
			received,
			undefined,
			"matching source/content evidence is rejected before inference, never dereferenced",
		);
	});
}
