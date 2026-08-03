/**
 * Manual visual snapshot of `StageChatView` across the mockup states
 * (§1 idle / §2 streaming / §3 paused / §4 notices / §5 settled).
 *
 * Usage: `bun run test/manual/stage-chat-render-snapshot.ts`
 *
 * Strips ANSI for readability — the goal is verifying the Pi-box vocabulary
 * (filled user bars, dim assistant prose, tool bars, banners, two-line footer,
 * dashed-hint strip) lays out correctly across viewport sizes.
 */

import type { StageControlHandle } from "../../packages/workflows/src/runs/foreground/stage-control-registry.ts";
import { createStore } from "../../packages/workflows/src/shared/store.ts";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.ts";
import { StageChatView } from "../../packages/workflows/src/tui/stage-chat-view.ts";

const ANSI = /\x1B\[[0-?]*[ -/]*[@-~]/g;
const strip = (s: string): string => s.replace(ANSI, "");

function setupRun(
	store: ReturnType<typeof createStore>,
	status: "pending" | "running" | "paused" | "blocked" | "completed" | "failed" = "running",
	opts: { withNotices?: boolean } = {},
): void {
	store.recordRunStart({
		id: "run-1",
		name: "review-fix-loop",
		inputs: {},
		status: "running",
		stages: [],
		startedAt: Date.now() - 38_000,
	});
	store.recordStageStart("run-1", {
		id: "stage-a",
		name: "review-a",
		status,
		parentIds: [],
		toolEvents: [],
		startedAt: Date.now() - 38_000,
		sessionId: "9e2a47c1aaaa",
		sessionFile: "/Users/me/.pi/sessions/run-9e2a/9e2a47c1.jsonl",
	});
	if (opts.withNotices) {
		store.recordStageNotice("run-1", "stage-a", {
			id: "n1",
			ts: Date.now(),
			kind: "thinking",
			from: "medium",
			to: "low",
			meta: 'stage.setThinkingLevel("low")',
		});
		store.recordStageNotice("run-1", "stage-a", {
			id: "n2",
			ts: Date.now(),
			kind: "model",
			from: "sonnet-4-5",
			to: "haiku-4",
			meta: "stage.setModel(haiku)",
		});
	}
}

interface FakeHandleOpts {
	status?: "pending" | "running" | "paused" | "blocked" | "completed" | "failed";
	isStreaming?: boolean;
}

function makeHandle(opts: FakeHandleOpts = {}): StageControlHandle {
	return {
		runId: "run-1",
		stageId: "stage-a",
		stageName: "review-a",
		status: opts.status ?? "running",
		sessionId: "9e2a47c1aaaa",
		sessionFile: "/Users/me/.pi/sessions/run-9e2a/9e2a47c1.jsonl",
		isStreaming: opts.isStreaming ?? false,
		messages: [],
		async ensureAttached() {},
		async prompt() {},
		async steer() {},
		async followUp() {},
		async pause() {},
		async resume() {},
		subscribe() {
			return () => {};
		},
	} as StageControlHandle;
}

function snapshot(label: string, view: StageChatView, width = 96): string {
	const lines = view.render(width).map(strip);
	return `===== ${label} (${width}×${lines.length}) =====\n${lines.join("\n")}\n`;
}

const theme = deriveGraphTheme({});

// §1 IDLE — fresh attach, no transcript.
{
	const store = createStore();
	setupRun(store, "pending");
	const view = new StageChatView({
		store,
		graphTheme: theme,
		runId: "run-1",
		stageId: "stage-a",
		workflowName: "review-fix-loop",
		handle: makeHandle({ status: "pending" }),
		onDetach: () => {},
		onClose: () => {},
		getViewportRows: () => 32,
	});
	console.log(snapshot("§1 IDLE", view));
	view.dispose();
}

// §2 STREAMING — turn in flight, transcript + tool bars.
{
	const store = createStore();
	setupRun(store);
	const view = new StageChatView({
		store,
		graphTheme: theme,
		runId: "run-1",
		stageId: "stage-a",
		workflowName: "review-fix-loop",
		handle: makeHandle({ isStreaming: true }),
		onDetach: () => {},
		onClose: () => {},
		getViewportRows: () => 32,
	});
	for (const ch of "Review the auth module for setRuntimeApiKey lifecycle.") view.handleInput(ch);
	view.handleInput("\r");
	// Inject extra transcript variants for visual coverage.
	// deno-fmt-ignore — accessing private transcript via a test seam.
	const writable = view as unknown as { transcript: unknown[] };
	writable.transcript.push({
		role: "thinking",
		text: "Looking at auth-storage.ts — tracing runtime overrides and dispose hygiene.",
	});
	writable.transcript.push({
		role: "assistant",
		text: "I'll walk through auth-storage.ts, then check dispose hygiene and env-var precedence.",
	});
	writable.transcript.push({
		role: "tool",
		name: "read",
		args: "path=packages/coding-agent/src/core/auth-storage.ts",
		state: "success",
		text: "← read auth-storage.ts",
	});
	writable.transcript.push({
		role: "tool",
		name: "grep",
		args: 'pattern="setRuntimeApiKey|clearRuntime"',
		state: "pending",
		text: "→ grep setRuntimeApiKey",
	});
	await new Promise((r) => queueMicrotask(r));
	await new Promise((r) => queueMicrotask(r));
	console.log(snapshot("§2 STREAMING", view));
	view.dispose();
}

// §3 PAUSED — yellow banner above transcript.
{
	const store = createStore();
	setupRun(store, "paused");
	const view = new StageChatView({
		store,
		graphTheme: theme,
		runId: "run-1",
		stageId: "stage-a",
		workflowName: "review-fix-loop",
		handle: makeHandle({ status: "paused" }),
		onDetach: () => {},
		onClose: () => {},
		getViewportRows: () => 28,
	});
	const writable = view as unknown as { transcript: unknown[] };
	writable.transcript.push({ role: "user", text: "Review the auth module for security issues." });
	writable.transcript.push({
		role: "assistant",
		text: "Started with auth-storage.ts — found one leak around setRuntimeApiKey not being cleared on dispose.",
	});
	writable.transcript.push({ role: "tool", name: "read", args: "path=auth-storage.ts", state: "success", text: "" });
	console.log(snapshot("§3 PAUSED", view));
	view.dispose();
}

// §4 NOTICES — workflow steered the stage.
{
	const store = createStore();
	setupRun(store, "running", { withNotices: true });
	const view = new StageChatView({
		store,
		graphTheme: theme,
		runId: "run-1",
		stageId: "stage-a",
		workflowName: "review-fix-loop",
		handle: makeHandle({ isStreaming: true }),
		onDetach: () => {},
		onClose: () => {},
		getViewportRows: () => 28,
	});
	const writable = view as unknown as { transcript: unknown[] };
	writable.transcript.unshift({
		role: "user",
		text: "Run a first pass quickly, then deepen on anything suspicious.",
	});
	console.log(snapshot("§4 NOTICES", view));
	view.dispose();
}

// §5 SETTLED — completed banner + read-only editor.
{
	const store = createStore();
	setupRun(store, "completed");
	const view = new StageChatView({
		store,
		graphTheme: theme,
		runId: "run-1",
		stageId: "stage-a",
		workflowName: "review-fix-loop",
		handle: undefined,
		onDetach: () => {},
		onClose: () => {},
		getViewportRows: () => 28,
	});
	const writable = view as unknown as { transcript: unknown[] };
	writable.transcript.push({ role: "user", text: "Review the auth module for security issues." });
	writable.transcript.push({ role: "assistant", text: "Three findings:" });
	writable.transcript.push({
		role: "assistant",
		text: "1. Runtime API key not cleared on dispose. 2. Env-var precedence masked. 3. No automated cleanup on process exit.",
	});
	writable.transcript.push({ role: "tool", name: "edit", args: "path=agent-session.ts", state: "success", text: "" });
	console.log(snapshot("§5 SETTLED", view));
	view.dispose();
}
