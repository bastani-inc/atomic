import assert from "node:assert/strict";
import { getKeybindings, setKeybindings } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.ts";
import { initTheme, theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../packages/coding-agent/src/utils/ansi.ts";
import { renderSubagentNotification } from "../../packages/subagents/src/extension/index.ts";
import registerSubagentNotify, {
	type SubagentNotifyDetails,
} from "../../packages/subagents/src/runs/background/notify.js";
import { notifyDetachedForegroundChildExit } from "../../packages/subagents/src/runs/foreground/subagent-executor-status.js";
import type { SingleResult } from "../../packages/subagents/src/shared/types.js";

type SentNotification = {
	customType: string;
	content: string;
	details?: SubagentNotifyDetails;
};

const originalKeybindings = getKeybindings();

function createHarness() {
	const listeners = new Map<string, Set<(data: unknown) => void>>();
	const sent: SentNotification[] = [];
	const pi = {
		events: {
			on(event: string, handler: (data: unknown) => void) {
				const set = listeners.get(event) ?? new Set();
				set.add(handler);
				listeners.set(event, set);
				return () => set.delete(handler);
			},
			emit(event: string, payload: unknown) {
				for (const handler of listeners.get(event) ?? []) handler(payload);
			},
		},
		sendMessage(message: SentNotification) {
			sent.push(message);
		},
	};
	return { pi, sent };
}

function makeResult(overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		agent: "codebase-analyzer",
		task: "audit",
		status: "ok",
		usage: {} as SingleResult["usage"],
		finalOutput: "Findings report content\nAdditional detail",
		sessionFile: "/tmp/sessions/child-0.jsonl",
		progressSummary: { toolCount: 2, tokens: 10, durationMs: 1250 },
		...overrides,
	};
}

function renderNotification(message: SentNotification): string {
	return stripAnsi(renderSubagentNotification(message, { expanded: false }, theme).render(120).join("\n"));
}

test("detached foreground child exit delivers a completion notice to the parent session", () => {
	const harness = createHarness();
	const unregister = registerSubagentNotify(harness.pi as never);

	notifyDetachedForegroundChildExit({
		pi: harness.pi as never,
		runId: "run-detach-1",
		mode: "parallel",
		index: 1,
		totalTasks: 4,
		result: makeResult(),
	});

	assert.equal(harness.sent.length, 1, "one notification is delivered");
	const message = harness.sent[0]!;
	assert.equal(message.customType, "subagent-notify");
	assert.match(message.content, /^Detached subagent task completed: \*\*codebase-analyzer\*\* \(2\/4\)/);
	assert.match(message.content, /Findings report content/);
	assert.match(message.content, /Session file: \/tmp\/sessions\/child-0\.jsonl/);
	assert.deepEqual(message.details, {
		agent: "codebase-analyzer",
		status: "completed",
		taskInfo: "(2/4)",
		resultPreview: "Findings report content\nAdditional detail",
		durationMs: 1250,
		sessionLabel: "session file",
		sessionValue: "/tmp/sessions/child-0.jsonl",
	});
	unregister();
});

test("detached foreground completion notices render like background notifications for every status", () => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
	try {
		for (const status of ["completed", "failed", "paused"] as const) {
			const harness = createHarness();
			const unregister = registerSubagentNotify(harness.pi as never);
			const result =
				status === "failed"
					? makeResult({ status: "error", error: "boom" })
					: status === "paused"
						? makeResult({ status: "interrupted", interrupted: true })
						: makeResult();
			const summary = status === "failed" ? `boom\n\nOutput:\n${result.finalOutput}` : result.finalOutput!;

			notifyDetachedForegroundChildExit({
				pi: harness.pi as never,
				runId: `run-render-${status}`,
				mode: "parallel",
				index: 1,
				totalTasks: 4,
				result,
			});
			const detached = harness.sent[0]!;
			harness.pi.events.emit("subagent:async-complete", {
				id: `background-render-${status}`,
				agent: result.agent,
				status: result.status,
				summary,
				...(status === "paused" ? { state: "paused" } : {}),
				timestamp: Date.now(),
				durationMs: result.progressSummary?.durationMs,
				sessionFile: result.sessionFile,
				taskIndex: 1,
				totalTasks: 4,
			});
			const background = harness.sent[1]!;
			const detachedRendered = renderNotification(detached);
			const backgroundRendered = renderNotification(background);

			assert.equal(detachedRendered, backgroundRendered, `${status} detached output uses the standard renderer`);
			assert.notEqual(
				detachedRendered,
				detached.content,
				`${status} detached output is not the raw notification body`,
			);
			assert.match(detachedRendered, /[✓✗■] codebase-analyzer (completed|failed|paused)/);
			assert.match(detachedRendered, /⎿ {2}(Findings report content|boom)/);
			assert.match(detachedRendered, /ctrl\+o full notification/);
			assert.doesNotMatch(detachedRendered, /Additional detail/);
			unregister();
		}
	} finally {
		setKeybindings(originalKeybindings);
	}
});

test("detached foreground completion notices dedupe per run and child index", () => {
	const harness = createHarness();
	const unregister = registerSubagentNotify(harness.pi as never);
	const input = {
		pi: harness.pi as never,
		runId: "run-detach-2",
		mode: "single" as const,
		index: 0,
		result: makeResult(),
	};

	notifyDetachedForegroundChildExit(input);
	notifyDetachedForegroundChildExit(input);
	assert.equal(harness.sent.length, 1, "duplicate child exits deliver a single notice");

	notifyDetachedForegroundChildExit({ ...input, runId: "run-detach-3" });
	assert.equal(harness.sent.length, 2, "a different run still notifies");
	unregister();
});

test("failed and interrupted detached children report failed/paused status", () => {
	const harness = createHarness();
	const unregister = registerSubagentNotify(harness.pi as never);

	notifyDetachedForegroundChildExit({
		pi: harness.pi as never,
		runId: "run-detach-4",
		mode: "chain",
		index: 0,
		result: makeResult({ status: "error", error: "boom" }),
	});
	assert.match(harness.sent[0]!.content, /^Detached subagent task failed: \*\*codebase-analyzer\*\*/);
	assert.match(harness.sent[0]!.content, /boom/);

	notifyDetachedForegroundChildExit({
		pi: harness.pi as never,
		runId: "run-detach-5",
		mode: "single",
		index: 0,
		result: makeResult({ status: "interrupted", interrupted: true }),
	});
	assert.match(harness.sent[1]!.content, /^Detached subagent task paused: \*\*codebase-analyzer\*\*/);
	unregister();
});

test("async background notifications keep their original heading", () => {
	const harness = createHarness();
	const unregister = registerSubagentNotify(harness.pi as never);
	harness.pi.events.emit("subagent:async-complete", {
		id: "async-run",
		agent: "worker",
		status: "ok",
		summary: "done",
		timestamp: Date.now(),
	});
	assert.equal(harness.sent.length, 1);
	assert.match(harness.sent[0]!.content, /^Background task completed: \*\*worker\*\*/);
	unregister();
});
