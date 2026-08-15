/**
 * open-claude-design ⇄ impeccable live protocol.
 *
 * In a chat session the agent owns the live poll loop, and "the review is over"
 * needs no ceremony because the user simply keeps talking. A workflow stage
 * boundary is a commit point, and the live contract's `"timeout" -> LOOP` is an
 * instruction to a model rather than a constraint: a stage that concludes on a
 * poll timeout returns a valid structured answer for a review the user never
 * finished, and the refinement loop routes on it.
 *
 * So the workflow drives the protocol instead. Polling and replying are durable
 * `ctx.tool` nodes; the model is invoked only for the events that need it
 * (`generate`, `steer`, `manual_edit_apply`). Termination stops being a
 * judgment and becomes the helper's own `exit` event.
 *
 * `timeout` is absorbed here rather than surfaced, so an idle hour costs no
 * graph nodes.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Events the live helper delivers. Anything unknown is treated as ignorable. */
export type LiveEventType =
	| "generate"
	| "steer"
	| "accept"
	| "discard"
	| "prefetch"
	| "manual_edit_apply"
	| "timeout"
	| "exit";

export type LiveEvent = {
	readonly type: LiveEventType | string;
	readonly id?: string;
	readonly message?: string;
	readonly pageUrl?: string;
	readonly screenshot?: string;
	/** Retained verbatim so an event stage sees exactly what the helper sent. */
	readonly raw: string;
};

/** Events the model must handle before the loop may reply and poll again. */
const MODEL_EVENTS = new Set<string>(["generate", "steer", "manual_edit_apply"]);

export function needsModel(event: LiveEvent): boolean {
	return MODEL_EVENTS.has(event.type);
}

/** Reply token the contract expects for each model-handled event. */
export function replyTokenFor(event: LiveEvent): string {
	if (event.type === "steer") return "steer_done";
	return "done";
}

/**
 * Where the impeccable live scripts live, in resolution order.
 *
 * The skill ships inside this package — `packages/workflows/skills/impeccable`
 * in the repository, `dist/builtin/workflows/skills/impeccable` once bundled —
 * and sits one level up from this module in both layouts, so `import.meta.url`
 * finds it without the host telling us where it is. A project that vendors its
 * own copy under `.agents/skills` wins, so a fork can be driven without
 * rebuilding Atomic.
 */
function scriptDirs(workflowCwd: string): readonly string[] {
	const bundled = fileURLToPath(new URL("../skills/impeccable/scripts/", import.meta.url));
	return [join(workflowCwd, ".agents", "skills", "impeccable", "scripts"), bundled];
}

/** Absolute path to a live script. The bundled skill makes this effectively total. */
export function resolveLiveScript(workflowCwd: string, script: string): string | undefined {
	for (const dir of scriptDirs(workflowCwd)) {
		const candidate = join(dir, script);
		if (existsSync(candidate)) return candidate;
	}
	return undefined;
}

export type ScriptResult = { readonly code: number; readonly stdout: string; readonly stderr: string };

function runNodeScript(
	scriptPath: string,
	args: readonly string[],
	cwd: string,
	signal?: AbortSignal,
): Promise<ScriptResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [scriptPath, ...args], {
			cwd,
			env: { ...process.env, GH_PAGER: "cat" },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let settled = false;
		const onAbort = () => child.kill("SIGTERM");
		signal?.addEventListener("abort", onAbort, { once: true });
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", onAbort);
			reject(error);
		});
		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", onAbort);
			resolve({ code: code ?? -1, stdout: stdout.trim(), stderr: stderr.trim() });
		});
	});
}

/** Last JSON object printed by a live script, which is the event payload. */
export function parseLiveEvent(stdout: string): LiveEvent {
	const lines = stdout.split(/\r?\n/).filter((line) => line.trim().startsWith("{"));
	for (const line of [...lines].reverse()) {
		try {
			const parsed: unknown = JSON.parse(line);
			if (typeof parsed !== "object" || parsed === null) continue;
			const record = parsed as Record<string, unknown>;
			const type = typeof record.type === "string" ? record.type : undefined;
			if (type === undefined) continue;
			return {
				type,
				raw: line,
				...(typeof record.id === "string" ? { id: record.id } : {}),
				...(typeof record.message === "string" ? { message: record.message } : {}),
				...(typeof record.pageUrl === "string" ? { pageUrl: record.pageUrl } : {}),
				...(typeof record.screenshot === "string" ? { screenshot: record.screenshot } : {}),
			};
		} catch {
			/* not the event line */
		}
	}
	// An unreadable poll is not an ending. Treat it as a timeout so the caller
	// polls again rather than concluding a review nobody finished.
	return { type: "timeout", raw: stdout };
}

export type LivePollDeps = {
	readonly run?: (scriptPath: string, args: readonly string[], cwd: string, signal?: AbortSignal) => Promise<ScriptResult>;
};

/**
 * Poll until the helper delivers an event that matters. `timeout` events and
 * unreadable output loop internally, so callers only ever see substantive
 * events or `exit`.
 */
export async function pollLiveEvent(input: {
	readonly workflowCwd: string;
	readonly signal?: AbortSignal;
	readonly deps?: LivePollDeps;
}): Promise<LiveEvent> {
	const script = resolveLiveScript(input.workflowCwd, "live-poll.mjs");
	if (script === undefined) return { type: "exit", raw: "live-poll.mjs is not installed in this project" };
	const run = input.deps?.run ?? runNodeScript;
	for (;;) {
		if (input.signal?.aborted === true) return { type: "exit", raw: "aborted" };
		const result = await run(script, [], input.workflowCwd, input.signal);
		const event = parseLiveEvent(result.stdout);
		if (event.type !== "timeout") return event;
	}
}

/** Acknowledge a model-handled event so the helper unblocks the overlay. */
export async function replyLiveEvent(input: {
	readonly workflowCwd: string;
	readonly token: string;
	readonly signal?: AbortSignal;
	readonly deps?: LivePollDeps;
}): Promise<ScriptResult> {
	const script = resolveLiveScript(input.workflowCwd, "live-poll.mjs");
	if (script === undefined) return { code: 0, stdout: "", stderr: "live-poll.mjs is not installed" };
	const run = input.deps?.run ?? runNodeScript;
	return run(script, ["--reply", input.token], input.workflowCwd, input.signal);
}

/** Prompt for the stage that handles one live event. */
export function buildLiveEventPrompt(input: {
	readonly event: LiveEvent;
	readonly previewPath: string;
}): string {
	const shared = [
		`<live_event>\n${input.event.raw}\n</live_event>`,
		`<preview_path>${input.previewPath}</preview_path>`,
		"<role>You are an opinionated staff design engineer inside an impeccable `live` session. The workflow owns the poll loop; handle exactly this one event and stop.</role>",
	];
	if (input.event.type === "generate") {
		return [
			...shared,
			[
				"<instructions>",
				"Follow the live contract for a `generate` event:",
				"1. Reuse `event.scaffold` when present and read the annotation screenshot when one is attached.",
				"2. Extract the page identity FIRST, then produce three DISTINCT on-brand variants and publish them for the user to preview.",
				"3. Apply the craft floors by construction as you write. Do not screenshot, re-render, or QA between generate and accept; the overlay preview is the verification channel.",
				"Do not poll, do not reply, and do not exit the session: the workflow does that. Stop as soon as the variants are published.",
				"</instructions>",
			].join("\n"),
		].join("\n\n");
	}
	if (input.event.type === "steer") {
		return [
			...shared,
			[
				"<instructions>",
				"Follow the live contract for a `steer` event: read the message and pageUrl, then do the work — page edits, navigation help, or a short answer.",
				"Do not poll, do not reply, and do not exit the session: the workflow does that. Stop when the steer is handled.",
				"</instructions>",
			].join("\n"),
		].join("\n\n");
	}
	return [
		...shared,
		[
			"<instructions>",
			"Apply this manual edit event per the live contract, then stop. Do not poll, reply, or exit; the workflow does that.",
			"</instructions>",
		].join("\n"),
	].join("\n\n");
}

/** Prompt for the stage that boots the session and hands the loop back to the workflow. */
export function buildLiveSessionStartPrompt(input: {
	readonly previewPath: string;
	readonly previewFileUrl: string;
	readonly browserBootstrapRules: string;
	readonly round: number;
}): string {
	return [
		`<preview_path>${input.previewPath}</preview_path>`,
		`<preview_file_url>${input.previewFileUrl}</preview_file_url>`,
		`<browser_use_guidelines>${input.browserBootstrapRules}</browser_use_guidelines>`,
		"<role>You are an opinionated staff design engineer opening an impeccable `live` review session.</role>",
		[
			"<objective>",
			`Start review session ${input.round}: boot live against the static preview and open it in the user's browser. Then STOP.`,
			"</objective>",
		].join("\n"),
		[
			"<instructions>",
			"1. Drive `/skill:impeccable live` against the static preview: run `live.mjs` with `--target` pointed at the preview file, or the equivalent `.impeccable/live/config.json` entry, and open the URL that serves it.",
			"2. Print the live `http://` review URL in plain text, plus the preview file URL as the manual fallback, so anyone attaching to this run can find the review.",
			"3. Do NOT start a poll loop. The workflow owns polling and will call you back for each event that needs you. Ending your turn does not end the review.",
			"</instructions>",
		].join("\n"),
		"<output_format>Under 120 words: the live review URL, the manual fallback path, and whether the browser opened.</output_format>",
	].join("\n\n");
}

/** Prompt for the stage that reports a finished session as the structured deliverable. */
export function buildLiveSessionSummaryPrompt(input: { readonly previewPath: string }): string {
	return [
		`<preview_path>${input.previewPath}</preview_path>`,
		"<context>The live session has ended: the helper delivered `exit`, which is why you are being asked now. Every event in this session was handled in your own earlier turns.</context>",
		"<role>You are an opinionated staff design engineer reporting a finished design review.</role>",
		[
			"<instructions>",
			"Report the whole session from what actually happened in it. Do not re-open the browser, poll, or start another session.",
			"Accepted variants and steered edits are already written into the preview; notes are the only thing still unapplied.",
			"</instructions>",
		].join("\n"),
		[
			"<output_format>",
			"Markdown for the transcript with `display_method`, `preview_path`, `live_changes`, `annotated_snapshot`, and `user_notes`, then finish with the STRUCTURED final answer this stage's schema declares — that structured value, not the prose, is what the workflow reads (issue #2401):",
			"`decision`: `export` when this preview should go to the exporter as it stands; `regenerate` when the user wants a fresh pass from the brief.",
			"`user_notes`: one entry per note, verbatim; empty when there were none.",
			"`live_changes`: one entry per variant or edit the user accepted; empty when there were none.",
			"`annotated_snapshot`: the screenshot path when one was captured; omit it otherwise.",
			"</output_format>",
		].join("\n"),
	].join("\n\n");
}
