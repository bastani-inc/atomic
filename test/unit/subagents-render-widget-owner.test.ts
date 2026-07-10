import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionContext } from "@bastani/atomic";
import { renderWidget, stopWidgetAnimation } from "../../packages/subagents/src/tui/render.js";
import { WIDGET_KEY, type AsyncJobState } from "../../packages/subagents/src/shared/types.js";

type SetWidgetArgs = Parameters<ExtensionContext["ui"]["setWidget"]>;
interface WidgetCall {
	key: string;
	content: SetWidgetArgs[1];
	options: SetWidgetArgs[2];
}

interface MakeCtxOptions {
	statuses?: Map<string, string>;
	setStatus?: (key: string, value: string | undefined) => void;
	setWidget?: ExtensionContext["ui"]["setWidget"];
}

const tempRoots: string[] = [];

function makeTempRoot(prefix: string): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tempRoots.push(root);
	return root;
}

function makeCtx(cwd: string, sessionFile: string, options: MakeCtxOptions = {}): { ctx: ExtensionContext; widgetCalls: WidgetCall[]; renderCount: () => number } {
	const widgetCalls: WidgetCall[] = [];
	let renders = 0;
	const setStatus = options.setStatus ?? (options.statuses
		? (key: string, value: string | undefined) => {
			if (value === undefined) options.statuses?.delete(key);
			else options.statuses?.set(key, value);
		}
		: undefined);
	const setWidget = options.setWidget ?? ((key: string, content: SetWidgetArgs[1], widgetOptions?: SetWidgetArgs[2]) => {
		widgetCalls.push({ key, content, options: widgetOptions });
	});
	const ctx = {
		hasUI: true,
		cwd,
		ui: {
			setWidget,
			setStatus,
			getToolsExpanded: () => false,
			setToolsExpanded: () => {},
			requestRender: () => {
				renders++;
			},
		},
		sessionManager: {
			getSessionFile: () => sessionFile,
			getSessionId: () => path.basename(sessionFile),
			getEntries: () => [],
		},
		modelRegistry: { getAvailable: () => [] },
		model: undefined,
		isIdle: () => true,
		signal: undefined,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => undefined,
		compact: () => {},
		getSystemPrompt: () => "",
	} as unknown as ExtensionContext;
	return { ctx, widgetCalls, renderCount: () => renders };
}

function makeJob(status: AsyncJobState["status"] = "running"): AsyncJobState {
	const stepStatus = status === "queued" ? "pending" : status;
	return {
		asyncId: "run-visible",
		asyncDir: "/tmp/run-visible",
		status,
		agents: ["worker"],
		steps: [{ agent: "worker", status: stepStatus, startedAt: 1_000 }],
		startedAt: 1_000,
		updatedAt: 2_000,
	};
}

function undefinedCalls(calls: WidgetCall[]): number {
	return calls.filter((call) => call.content === undefined).length;
}

function mountCalls(calls: WidgetCall[]): number {
	return calls.filter((call) => call.options?.placement === "belowEditor").length;
}

afterEach(() => {
	stopWidgetAnimation();
	for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("subagent render widget logical owner stability", () => {
	test("same-owner fresh wrappers update active reset/hydration in place without a blank remount", () => {
		const cwd = makeTempRoot("atomic-widget-owner-cwd-");
		const sessionFile = path.join(cwd, "session.jsonl");
		const first = makeCtx(cwd, sessionFile);
		const fresh = makeCtx(cwd, sessionFile);

		renderWidget(first.ctx, [makeJob()]);
		renderWidget(fresh.ctx, [makeJob()]);

		assert.equal(mountCalls(first.widgetCalls), 1);
		assert.equal(mountCalls(fresh.widgetCalls), 0, "fresh wrappers for the same owner must not remount");
		assert.equal(undefinedCalls(first.widgetCalls) + undefinedCalls(fresh.widgetCalls), 0);
		assert.equal(fresh.renderCount(), 1, "fresh same-owner update should render in place");
	});

	test("same-owner fresh wrapper with no active jobs still unmounts the mounted widget", () => {
		const cwd = makeTempRoot("atomic-widget-owner-cwd-");
		const sessionFile = path.join(cwd, "session.jsonl");
		const first = makeCtx(cwd, sessionFile);
		const fresh = makeCtx(cwd, sessionFile);

		renderWidget(first.ctx, [makeJob()]);
		renderWidget(fresh.ctx, []);

		assert.equal(undefinedCalls(first.widgetCalls), 1, "unmount targets the actual mounted UI context");
		assert.equal(undefinedCalls(fresh.widgetCalls), 0);
	});

	test("same-owner in-place updates refresh the teardown context", () => {
		const cwd = makeTempRoot("atomic-widget-owner-cwd-");
		const sessionFile = path.join(cwd, "session.jsonl");
		const first = makeCtx(cwd, sessionFile);
		const fresh = makeCtx(cwd, sessionFile);
		const empty = makeCtx(cwd, sessionFile);

		renderWidget(first.ctx, [makeJob()]);
		renderWidget(fresh.ctx, [makeJob()]);
		renderWidget(empty.ctx, []);

		assert.equal(
			undefinedCalls(first.widgetCalls),
			0,
			"stale wrappers should not receive same-owner teardown",
		);
		assert.equal(
			undefinedCalls(fresh.widgetCalls),
			1,
			"teardown should target the freshest same-owner wrapper",
		);
		assert.equal(
			undefinedCalls(empty.widgetCalls),
			0,
			"empty wrappers request teardown but do not own the mounted widget",
		);
	});

	test("session files relative to ctx.cwd keep the same owner", () => {
		const cwd = makeTempRoot("atomic-widget-owner-cwd-");
		const absoluteSessionFile = path.join(cwd, "session.jsonl");
		const relativeSessionFile = path.relative(cwd, absoluteSessionFile);
		const relative = makeCtx(cwd, relativeSessionFile);
		const absolute = makeCtx(cwd, absoluteSessionFile);

		renderWidget(relative.ctx, [makeJob()]);
		renderWidget(absolute.ctx, [makeJob()]);

		assert.equal(mountCalls(relative.widgetCalls), 1);
		assert.equal(
			mountCalls(absolute.widgetCalls),
			0,
			"ctx.cwd-relative session file must not remount after equivalent absolute file",
		);
		assert.equal(undefinedCalls(relative.widgetCalls) + undefinedCalls(absolute.widgetCalls), 0);
		assert.equal(absolute.renderCount(), 1, "absolute same-owner update should render in place");
	});

	test("different logical owner clears the old widget and mounts on the new context", () => {
		const cwd = makeTempRoot("atomic-widget-owner-cwd-");
		const otherCwd = makeTempRoot("atomic-widget-owner-other-");
		const statuses = new Map<string, string>();
		const first = makeCtx(cwd, path.join(cwd, "session.jsonl"), { statuses });
		const other = makeCtx(otherCwd, path.join(otherCwd, "session.jsonl"), { statuses });

		renderWidget(first.ctx, [makeJob()]);
		renderWidget(other.ctx, [makeJob()]);

		assert.equal(undefinedCalls(first.widgetCalls), 1);
		assert.equal(mountCalls(other.widgetCalls), 1);
		assert.equal(statuses.get(WIDGET_KEY), "Async agents: 1 running");
	});

	test("stale-owner empty updates do not clear the active owner status", () => {
		const cwd = makeTempRoot("atomic-widget-owner-cwd-");
		const otherCwd = makeTempRoot("atomic-widget-owner-other-");
		const statuses = new Map<string, string>();
		const active = makeCtx(cwd, path.join(cwd, "session.jsonl"), { statuses });
		const stale = makeCtx(otherCwd, path.join(otherCwd, "session.jsonl"), { statuses });

		renderWidget(active.ctx, [makeJob()]);
		renderWidget(stale.ctx, []);

		assert.equal(undefinedCalls(active.widgetCalls), 0);
		assert.equal(undefinedCalls(stale.widgetCalls), 0);
		assert.equal(statuses.get(WIDGET_KEY), "Async agents: 1 running");
	});

	test("stale session teardown cannot unmount another owner's active widget", () => {
		const cwd = makeTempRoot("atomic-widget-owner-cwd-");
		const otherCwd = makeTempRoot("atomic-widget-owner-other-");
		const active = makeCtx(cwd, path.join(cwd, "session.jsonl"));
		const stale = makeCtx(otherCwd, path.join(otherCwd, "session.jsonl"));

		renderWidget(active.ctx, [makeJob()]);
		stopWidgetAnimation(stale.ctx);

		assert.equal(undefinedCalls(active.widgetCalls), 0);
		assert.equal(active.renderCount(), 0);
	});

	test("same-surface workflow-stage API cannot replace or stop the parent API widget", () => {
		const cwd = makeTempRoot("atomic-widget-api-owner-");
		const sessionFile = path.join(cwd, "session.jsonl");
		const statuses = new Map<string, string>();
		const parent = makeCtx(cwd, sessionFile, { statuses });
		const stage = makeCtx(cwd, sessionFile, { statuses, setWidget: parent.ctx.ui.setWidget });
		const parentApi = {};
		const stageApi = {};

		renderWidget(parent.ctx, [makeJob()], parentApi);
		renderWidget(stage.ctx, [makeJob()], stageApi);
		renderWidget(stage.ctx, [], stageApi);
		assert.equal(statuses.get(WIDGET_KEY), "Async agents: 1 running", "stage empty updates must preserve parent status");
		stopWidgetAnimation(undefined, stageApi);
		renderWidget(parent.ctx, [makeJob("complete")], parentApi);

		assert.equal(mountCalls(parent.widgetCalls), 1);
		assert.equal(mountCalls(stage.widgetCalls), 0, "stage must not replace the parent mount");
		assert.equal(undefinedCalls(parent.widgetCalls), 0, "stage teardown must not clear the parent mount");
		assert.equal(parent.renderCount(), 1, "parent owner remains live after stage teardown");
		stopWidgetAnimation(undefined, parentApi);
	});

	test("independent widget surfaces can mount and tear down concurrently", () => {
		const cwd = makeTempRoot("atomic-widget-independent-parent-");
		const otherCwd = makeTempRoot("atomic-widget-independent-stage-");
		const parent = makeCtx(cwd, path.join(cwd, "session.jsonl"));
		const stage = makeCtx(otherCwd, path.join(otherCwd, "session.jsonl"));
		const parentApi = {};
		const stageApi = {};

		renderWidget(parent.ctx, [makeJob()], parentApi);
		renderWidget(stage.ctx, [makeJob()], stageApi);
		assert.equal(mountCalls(parent.widgetCalls), 1);
		assert.equal(mountCalls(stage.widgetCalls), 1);

		stopWidgetAnimation(undefined, stageApi);
		assert.equal(undefinedCalls(stage.widgetCalls), 1);
		assert.equal(undefinedCalls(parent.widgetCalls), 0);
		stopWidgetAnimation(undefined, parentApi);
		assert.equal(undefinedCalls(parent.widgetCalls), 1);
	});

	test("API teardown bypasses stale logical context matching", () => {
		const cwd = makeTempRoot("atomic-widget-authoritative-teardown-");
		const mounted = makeCtx(cwd, path.join(cwd, "mounted.jsonl"));
		const stale = makeCtx(cwd, path.join(cwd, "stale.jsonl"), { setWidget: mounted.ctx.ui.setWidget });
		const api = {};

		renderWidget(mounted.ctx, [makeJob()], api);
		stopWidgetAnimation(stale.ctx, api);
		assert.equal(undefinedCalls(mounted.widgetCalls), 0, "context-driven stale teardown remains guarded");
		stopWidgetAnimation(undefined, api);
		assert.equal(undefinedCalls(mounted.widgetCalls), 1, "API shutdown authoritatively releases its mount");
	});

	test("status cleanup failures do not block widget teardown", () => {
		const cwd = makeTempRoot("atomic-widget-owner-cwd-");
		const current = makeCtx(cwd, path.join(cwd, "session.jsonl"), {
			setStatus: () => {
				throw new Error("status unavailable");
			},
		});

		renderWidget(current.ctx, [makeJob()]);
		renderWidget(current.ctx, []);

		assert.equal(mountCalls(current.widgetCalls), 1);
		assert.equal(undefinedCalls(current.widgetCalls), 1);
	});

	test("fresh-context running/status/terminal updates do not blank until no jobs remain", () => {
		const cwd = makeTempRoot("atomic-widget-owner-cwd-");
		const sessionFile = path.join(cwd, "session.jsonl");
		const first = makeCtx(cwd, sessionFile);
		const status = makeCtx(cwd, sessionFile);
		const terminal = makeCtx(cwd, sessionFile);
		const empty = makeCtx(cwd, sessionFile);

		renderWidget(first.ctx, [makeJob("running")]);
		renderWidget(status.ctx, [makeJob("running")]);
		renderWidget(terminal.ctx, [makeJob("complete")]);

		const preEmptyBlankCount = [first, status, terminal].reduce(
			(sum, item) => sum + undefinedCalls(item.widgetCalls),
			0,
		);
		assert.equal(preEmptyBlankCount, 0, "status and terminal updates should not publish a transient blank");
		assert.equal(mountCalls(first.widgetCalls) + mountCalls(status.widgetCalls) + mountCalls(terminal.widgetCalls), 1);
		assert.equal(status.renderCount() + terminal.renderCount(), 2);

		renderWidget(empty.ctx, []);
		const postEmptyBlankCount = [first, status, terminal].reduce(
			(sum, item) => sum + undefinedCalls(item.widgetCalls),
			0,
		);
		assert.equal(
			postEmptyBlankCount,
			1,
			"the blank frame is reserved for the no-active transition",
		);
		assert.equal(
			undefinedCalls(terminal.widgetCalls),
			1,
			"no-active teardown targets the freshest visible same-owner wrapper",
		);
	});
});
