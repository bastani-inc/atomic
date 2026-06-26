import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionContext } from "@bastani/atomic";
import { renderWidget, stopWidgetAnimation } from "../../packages/subagents/src/tui/render.js";
import type { AsyncJobState } from "../../packages/subagents/src/shared/types.js";

type SetWidgetArgs = Parameters<ExtensionContext["ui"]["setWidget"]>;
interface WidgetCall {
	key: string;
	content: SetWidgetArgs[1];
	options: SetWidgetArgs[2];
}

const tempRoots: string[] = [];

function makeTempRoot(prefix: string): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tempRoots.push(root);
	return root;
}

function makeCtx(cwd: string, sessionFile: string): { ctx: ExtensionContext; widgetCalls: WidgetCall[]; renderCount: () => number } {
	const widgetCalls: WidgetCall[] = [];
	let renders = 0;
	const ctx = {
		hasUI: true,
		cwd,
		ui: {
			setWidget: (key: string, content: SetWidgetArgs[1], options?: SetWidgetArgs[2]) => {
				widgetCalls.push({ key, content, options });
			},
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

	test("relative and absolute session file wrappers keep the same owner", () => {
		const cwd = makeTempRoot("atomic-widget-owner-cwd-");
		const absoluteSessionFile = path.join(cwd, "session.jsonl");
		const relativeSessionFile = path.relative(process.cwd(), absoluteSessionFile);
		const relative = makeCtx(cwd, relativeSessionFile);
		const absolute = makeCtx(cwd, absoluteSessionFile);

		renderWidget(relative.ctx, [makeJob()]);
		renderWidget(absolute.ctx, [makeJob()]);

		assert.equal(mountCalls(relative.widgetCalls), 1);
		assert.equal(mountCalls(absolute.widgetCalls), 0, "absolute wrapper must not remount after equivalent relative session file");
		assert.equal(undefinedCalls(relative.widgetCalls) + undefinedCalls(absolute.widgetCalls), 0);
		assert.equal(absolute.renderCount(), 1, "absolute same-owner update should render in place");
	});

	test("different logical owner clears the old widget and mounts on the new context", () => {
		const cwd = makeTempRoot("atomic-widget-owner-cwd-");
		const otherCwd = makeTempRoot("atomic-widget-owner-other-");
		const first = makeCtx(cwd, path.join(cwd, "session.jsonl"));
		const other = makeCtx(otherCwd, path.join(otherCwd, "session.jsonl"));

		renderWidget(first.ctx, [makeJob()]);
		renderWidget(other.ctx, [makeJob()]);

		assert.equal(undefinedCalls(first.widgetCalls), 1);
		assert.equal(mountCalls(other.widgetCalls), 1);
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

		const preEmptyBlankCount = [first, status, terminal].reduce((sum, item) => sum + undefinedCalls(item.widgetCalls), 0);
		assert.equal(preEmptyBlankCount, 0, "status and terminal updates should not publish a transient blank");
		assert.equal(mountCalls(first.widgetCalls) + mountCalls(status.widgetCalls) + mountCalls(terminal.widgetCalls), 1);
		assert.equal(status.renderCount() + terminal.renderCount(), 2);

		renderWidget(empty.ctx, []);
		assert.equal(undefinedCalls(first.widgetCalls), 1, "the blank frame is reserved for the no-active transition");
	});
});
