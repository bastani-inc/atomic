import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { describe, it } from "vitest";
import {
	createWorkflowLifecycleNotificationState,
	installWorkflowLifecycleNotifications,
	registerLifecycleNoticeRenderer,
	type WorkflowLifecycleNoticeDetails,
} from "../../packages/workflows/src/extension/lifecycle-notifications.js";
import type { PiMessageRenderer } from "../../packages/workflows/src/extension/public-types.js";
import { formatInvalidDefinitionDetails } from "../../packages/workflows/src/extension/workflow-open-run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot, StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { inertDisplayLine, inertDisplayText } from "../../packages/workflows/src/tui/display-text.js";
import { GraphView } from "../../packages/workflows/src/tui/graph-view.js";
import { renderHeader } from "../../packages/workflows/src/tui/header.js";
import { buildRunOutcome } from "../../packages/workflows/src/tui/run-outcome.js";
import { runStateIndicator } from "../../packages/workflows/src/tui/run-state-indicator.js";
import {
	renderStageFailureDetailLines,
	stageFailureLogLines,
} from "../../packages/workflows/src/tui/stage-failure-detail.js";
import { makeFakeKeybindings } from "../support/fake-keybindings.js";
import { defaultTheme, makeStage, makeStore, makeTestTui } from "./overlay-graph-helpers.js";

const NOW = 1_800_000_000_000;
const BIDI_PATTERN = /[\u202a-\u202e\u2066-\u2069]/;
const UNSAFE_LINE_PATTERN = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;

function makeRun(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
	return {
		id: "run-5224",
		name: "verify-gate",
		inputs: {},
		status: "completed",
		startedAt: NOW - 9_000,
		endedAt: NOW - 1_000,
		toolNodes: [],
		stages: [
			{
				...makeStage("gate"),
				status: "completed",
				startedAt: NOW - 9_000,
				endedAt: NOW - 2_000,
			},
		],
		...overrides,
	};
}

function makeGraph(run: RunSnapshot): GraphView {
	return new GraphView({
		piKeybindings: makeFakeKeybindings(),
		mode: "overlay",
		runId: run.id,
		store: makeStore({ runs: [run], notices: [], version: 1 }),
		graphTheme: defaultTheme,
		piTui: makeTestTui(40),
	});
}

describe("workflow display safety regressions (#5224)", () => {
	it("sanitizes bidirectional controls in a blocked run's exit reason across the header and run details (#5224)", () => {
		const run = makeRun({
			exitReason: "needs \u202eevil\u2066\u2069 human",
			result: { status: "needs_human", summary: "please review" },
		});
		const state = runStateIndicator(run);
		assert.equal(state?.reason, "needs <U+202E>evil<U+2066><U+2069> human");
		const header = renderHeader(run, { width: 160, theme: defaultTheme }).join("\n");
		assert.doesNotMatch(header, BIDI_PATTERN);
		assert.match(header, /<U\+202E>evil<U\+2066><U\+2069>/);

		const graph = makeGraph(run);
		try {
			graph.handleInput("o");
			const details = graph.render(160).join("\n");
			assert.doesNotMatch(details, BIDI_PATTERN);
			assert.match(details, /<U\+202E>evil<U\+2066><U\+2069>/);
		} finally {
			graph.dispose();
		}
	});

	it("strips terminal sequences before displaying a blocked run's exit reason (#5224)", () => {
		const run = makeRun({
			exitReason: "\x1b[31mneeds\x1b[0m \x1b]52;c;Zm9v\x07review\r\nhuman",
			result: { status: "needs_human" },
		});
		assert.equal(runStateIndicator(run)?.reason, "needs review human");
		const header = stripVTControlCharacters(renderHeader(run, { width: 160, theme: defaultTheme }).join("\n"));
		assert.match(header, /needs review human/);
		assert.doesNotMatch(header, /\\x1b|Zm9v/);
	});

	it("normalizes CRLF line endings without emitting literal \\x0d while keeping standalone CR escaped (#5224)", () => {
		assert.equal(inertDisplayText("a\r\nb"), "a\nb");
		assert.equal(inertDisplayText("a\nb"), "a\nb");
		assert.equal(inertDisplayLine("a\r\nb"), "a b");
		assert.equal(inertDisplayLine("a\nb"), "a b");
		assert.equal(inertDisplayText("a\rb"), "a\\x0db");
		assert.equal(inertDisplayLine("a\rb"), "a\\x0db");
		assert.equal(inertDisplayText("\u0007\u202e"), "\\x07<U+202E>");

		const failed = makeRun({
			status: "failed",
			error: "deploy failed\r\nsecond line",
			toolNodes: [
				{
					kind: "tool",
					id: "tool:1",
					name: "deploy",
					argsHash: "h1",
					ordinal: 1,
					status: "failed",
					error: "refused\r\nby server",
					parentIds: [],
					executionOrder: 1,
					attachable: false,
					startedAt: NOW - 3_000,
					endedAt: NOW - 2_500,
				},
			],
		});
		const graph = makeGraph(failed);
		try {
			graph.handleInput("o");
			graph.handleInput("l");
			const log = stripVTControlCharacters(graph.render(160).join("\n"));
			assert.doesNotMatch(log, /\\x0d/);
			assert.match(log, /deploy failed/);
			assert.match(log, /second line/);
			assert.match(log, /refused/);
			assert.match(log, /by server/);
		} finally {
			graph.dispose();
		}

		const invalidDetails = formatInvalidDefinitionDetails({
			name: "greet",
			source: "C:\\repo\\.atomic\\workflows\\greet.ts",
			code: "IMPORT_FAILED",
			reason: "ParseError: Unexpected token",
			message:
				'Failed to import "C:\\repo\\.atomic\\workflows\\greet.ts": ParseError: Unexpected token\r\n  C:\\repo\\.atomic\\workflows\\greet.ts:8:36\r\n  8 | export const x = (',
		});
		assert.doesNotMatch(invalidDetails, /\\x0d/);
		assert.match(invalidDetails, /greet\.ts:8:36/);
	});

	it("keeps a CRLF workflow name on one headline without literal \\x0d on the lifecycle notice card (#5224)", async () => {
		const store = createStore();
		const sent: Array<{ details?: WorkflowLifecycleNoticeDetails }> = [];
		installWorkflowLifecycleNotifications({
			store,
			config: { enabled: true, notifyOn: ["completed", "failed", "blocked"] },
			state: createWorkflowLifecycleNotificationState(),
			sendMessage: (message) => {
				sent.push(message as { details?: WorkflowLifecycleNoticeDetails });
			},
		});
		let renderer: PiMessageRenderer | undefined;
		registerLifecycleNoticeRenderer({
			rendererHost: {},
			registerMessageRenderer: (_entryType, registered) => {
				renderer = registered;
			},
		});
		store.recordRunStart({
			id: "r-crlf",
			name: "release\r\nnotes",
			inputs: {},
			status: "running",
			startedAt: NOW - 5_000,
			toolNodes: [],
			stages: [],
		});
		store.recordRunEnd("r-crlf", "completed", { summary: "ok" });
		await Promise.resolve();
		assert.ok(renderer !== undefined);
		const card = stripVTControlCharacters(
			sent
				.map((message) => {
					const component = renderer!({ details: message.details });
					assert.ok(component && typeof component !== "string");
					return component.render(100).join("\n");
				})
				.join("\n"),
		);
		assert.doesNotMatch(card, /\\x0d/);
		assert.match(card, /Workflow "release notes" completed/);
	});

	it("removes ANSI and OSC escape sequences before sanitizing failed-stage details, logs and action notices (#5224)", async () => {
		const coloured = "\x1b[31mboom\x1b[39m";
		assert.deepEqual(stageFailureLogLines({ error: coloured }), ["boom"]);

		const failedStage: StageSnapshot = {
			...makeStage("deploy"),
			status: "failed",
			startedAt: NOW - 5_000,
			endedAt: NOW - 1_000,
			error: coloured,
		};
		const run = makeRun({
			status: "failed",
			error: "\x1b[1mship failed\x1b[22m",
			stages: [failedStage],
		});
		const outcome = buildRunOutcome(run, NOW);
		assert.equal(outcome.blockers[0]?.reason, "boom");
		assert.ok(outcome.log.includes("ship failed"));
		assert.ok(outcome.log.includes("  boom"));
		assert.equal(
			outcome.log.some((line) => line.includes("\\x1b")),
			false,
		);

		const summary = renderStageFailureDetailLines(failedStage, {
			theme: defaultTheme,
			width: 80,
			logs: false,
		}).map(stripVTControlCharacters);
		const log = renderStageFailureDetailLines(failedStage, {
			theme: defaultTheme,
			width: 80,
			logs: true,
		}).map(stripVTControlCharacters);
		assert.ok(summary.some((line) => line.includes("boom")));
		assert.equal(
			summary.some((line) => line.includes("\\x1b")),
			false,
		);
		assert.ok(log.some((line) => line.includes("boom")));
		assert.equal(
			log.some((line) => line.includes("\\x1b")),
			false,
		);

		for (const sample of [
			coloured,
			"a\tb\u202ec\u2066d\x07e\x9b31mf\r\ng",
			"\x1b]52;c;aGk=\x1b\\x",
			"plain text",
			"\u202e",
			"tab\there",
		]) {
			const once = stageFailureLogLines({ error: sample });
			for (const line of once) {
				assert.equal(UNSAFE_LINE_PATTERN.test(line), false);
				assert.deepEqual(stageFailureLogLines({ error: line }), [line]);
				assert.equal(inertDisplayLine(line), line);
			}
		}

		const runningRun = makeRun({
			status: "running",
			endedAt: undefined,
			stages: [{ ...makeStage("worker"), status: "running" }],
		});
		const graph = new GraphView({
			piKeybindings: makeFakeKeybindings(),
			mode: "overlay",
			runId: runningRun.id,
			store: makeStore({ runs: [runningRun], notices: [], version: 1 }),
			graphTheme: defaultTheme,
			piTui: makeTestTui(40),
			stageActions: {
				stop: async () => ({
					ok: true,
					message: "Stopped \x1b[32mworker\x1b[39m\nnow\u202e",
				}),
			},
		});
		try {
			graph.handleInput("x");
			graph.handleInput("x");
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
			const rendered = stripVTControlCharacters(graph.render(160).join("\n"));
			assert.match(rendered, /Stopped worker now<U\+202E>/);
			assert.doesNotMatch(rendered, /\\x1b/);
		} finally {
			graph.dispose();
		}
	});

	it("shows token usage in the failed-stage detail header when stage modelAttempts recorded tokens and omits it when absent (#5224)", () => {
		const withTokens: StageSnapshot = {
			...makeStage("deploy"),
			status: "failed",
			startedAt: NOW - 240_000,
			endedAt: NOW,
			error: "gate failed",
			modelAttempts: [
				{
					model: "anthropic/claude",
					success: false,
					usage: { input: 12_000, output: 6_400, cacheRead: 0, cacheWrite: 0, cost: 0.04, turns: 1 },
				},
			],
		};
		const summaryWithTokens = stripVTControlCharacters(
			renderStageFailureDetailLines(withTokens, { theme: defaultTheme, width: 80, logs: false })[0] ?? "",
		);
		const logsWithTokens = stripVTControlCharacters(
			renderStageFailureDetailLines(withTokens, { theme: defaultTheme, width: 80, logs: true })[0] ?? "",
		);
		assert.equal(summaryWithTokens, "  ✗ deploy · failed after 4m · 18.4k tokens");
		assert.equal(logsWithTokens, "  ✗ deploy · failed after 4m · 18.4k tokens");

		const withSmallTokens: StageSnapshot = {
			...withTokens,
			modelAttempts: [
				{
					model: "anthropic/claude",
					success: false,
					usage: { input: 512, output: 300, cacheRead: 0, cacheWrite: 0, cost: 0.01, turns: 1 },
				},
			],
		};
		assert.equal(
			stripVTControlCharacters(
				renderStageFailureDetailLines(withSmallTokens, { theme: defaultTheme, width: 80, logs: false })[0] ?? "",
			),
			"  ✗ deploy · failed after 4m · 812 tokens",
		);

		const withoutTokens: StageSnapshot = {
			...withTokens,
			modelAttempts: undefined,
		};
		assert.equal(
			stripVTControlCharacters(
				renderStageFailureDetailLines(withoutTokens, { theme: defaultTheme, width: 80, logs: false })[0] ?? "",
			),
			"  ✗ deploy · failed after 4m",
		);
	});
});
