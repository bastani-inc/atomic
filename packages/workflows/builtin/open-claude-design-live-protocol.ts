/**
 * open-claude-design ⇄ impeccable live protocol.
 *
 * In a chat session the agent owns the live poll loop, and "the review is over"
 * needs no ceremony because the user simply keeps talking. A workflow stage
 * boundary is a commit point, and the live contract's `"timeout" -> LOOP` is an
 * instruction to a model rather than a constraint: a stage that concludes on a
 * poll timeout would end a review the user never finished.
 *
 * So the workflow drives the protocol instead. Polling and replying are durable
 * `ctx.tool` nodes; the model is invoked only for the events that need it
 * (`generate`, `steer`, `manual_edit_apply`, and mount failures). Termination
 * stops being a judgment and becomes the helper's own `exit` event.
 *
 * `timeout` is absorbed here rather than surfaced, so an idle hour costs no
 * graph nodes. Every poll/reply invocation must, however, exit successfully;
 * helper failures are surfaced instead of being mistaken for another timeout.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

/** JSON values emitted by the live helper. */
export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** Events the live helper delivers. Anything unknown is treated as ignorable. */
export type LiveEventType =
	| "generate"
	| "steer"
	| "accept"
	| "discard"
	| "prefetch"
	| "manual_edit_apply"
	| "variant_mounted"
	| "variant_mount_failed"
	| "timeout"
	| "exit";

export type LiveEvent = {
	readonly type: LiveEventType | string;
	readonly id?: string;
	readonly variant?: number;
	readonly variantId?: string;
	readonly url?: string;
	readonly pageUrl?: string;
	readonly error?: string;
	readonly file?: string;
	readonly sourceFile?: string;
	readonly message?: string;
	readonly data?: JsonValue;
	readonly screenshot?: string;
	readonly raw: string;
	/** Preserve additional upstream event fields without narrowing their JSON shape. */
	readonly [key: string]: JsonValue | undefined;
};

/** Events the model must handle before the loop may reply and poll again. */
const MODEL_EVENTS = new Set<string>(["generate", "steer", "manual_edit_apply", "variant_mount_failed"]);

export function needsModel(event: LiveEvent): boolean {
	return MODEL_EVENTS.has(event.type);
}

/** Reply status the helper expects for each model-handled event. */
export function replyTokenFor(event: LiveEvent): string {
	if (event.type === "steer") return "steer_done";
	return "done";
}

const LEGACY_REPLY_STATUSES = new Set(["done", "error", "complete", "discard", "discarded"]);

function isJsonObject(value: JsonValue): value is { readonly [key: string]: JsonValue } {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Last JSON object printed by a live script, which is the event payload. */
export function parseLiveEvent(stdout: string): LiveEvent {
	const lines = stdout.split(/\r?\n/).filter((line) => line.trim().startsWith("{"));
	for (const line of [...lines].reverse()) {
		try {
			const parsed = JSON.parse(line) as JsonValue;
			if (!isJsonObject(parsed) || typeof parsed.type !== "string") continue;
			// Keep the complete JSON event, not only the fields known by the old
			// protocol. 4.1.1 adds mount diagnostics and structured reply data.
			return { ...parsed, type: parsed.type, raw: line } as LiveEvent;
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

export type LiveReplyInput = {
	readonly workflowCwd: string;
	readonly event: LiveEvent;
	readonly status?: string;
	/** Source/manifest path accepted by generate and mount-failure replies. */
	readonly file?: string;
	/** The helper's positional message argument (there is no --message flag). */
	readonly message?: string;
	/** Structured result accepted by manual_edit_apply replies. */
	readonly data?: JsonValue;
	readonly signal?: AbortSignal;
	readonly deps?: LivePollDeps;
};

function assertSuccessfulScript(result: ScriptResult, operation: string): ScriptResult {
	if (result.code !== 0) {
		const details = result.stderr.length > 0 ? `: ${result.stderr}` : "";
		throw new Error(`${operation} failed with exit code ${result.code}${details}`);
	}
	return result;
}

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
	const script = liveScriptPath("live-poll.mjs");
	const run = input.deps?.run ?? runNodeScript;
	for (;;) {
		if (input.signal?.aborted === true) return { type: "exit", raw: "aborted" };
		const result = assertSuccessfulScript(await run(script, [], input.workflowCwd, input.signal), "live poll");
		const event = parseLiveEvent(result.stdout);
		if (event.type !== "timeout") return event;
	}
}

/** Acknowledge a model-handled event so the helper unblocks the overlay. */
export async function replyLiveEvent(input: LiveReplyInput): Promise<ScriptResult> {
	const id = input.event.id;
	if (typeof id !== "string" || id.length === 0 || id.startsWith("--")) {
		throw new Error(`Cannot reply to ${input.event.type}: live event id is missing`);
	}
	if (LEGACY_REPLY_STATUSES.has(id)) {
		throw new Error(`Cannot reply to live event ${id}: expected an event id before the reply status`);
	}
	const status = input.status ?? replyTokenFor(input.event);
	if (status.length === 0 || status.startsWith("--")) {
		throw new Error(`Cannot reply to live event ${id}: reply status is missing`);
	}
	const args = ["--reply", id, status];
	const file = input.file ?? input.event.file;
	const message = input.message ?? input.event.message;
	const data = input.data ?? input.event.data;
	if (file !== undefined) args.push("--file", file);
	if (data !== undefined) args.push("--data", JSON.stringify(data));
	if (message !== undefined) args.push(message);
	const script = liveScriptPath("live-poll.mjs");
	const run = input.deps?.run ?? runNodeScript;
	return assertSuccessfulScript(await run(script, args, input.workflowCwd, input.signal), "live reply");
}

/**
 * Absolute path to one of the impeccable live scripts.
 *
 * Always the copy that ships inside this package — `packages/workflows/skills`
 * in the repository, `dist/builtin/workflows/skills` once bundled — which sits
 * one level up from this module in both layouts, so `import.meta.url` finds it
 * without the host naming a path.
 *
 * A project-vendored copy is deliberately NOT consulted. The workflow drives
 * this protocol directly: it depends on `live-poll.mjs`'s CLI surface, its
 * `--reply` tokens, and its JSON event vocabulary. The bundled scripts ship and
 * are tested with this code, so they cannot drift from it; a forked copy in a
 * project could, and would break the loop in ways no test here would catch.
 */
export function liveScriptPath(script: string): string {
	return fileURLToPath(new URL(`../skills/impeccable/scripts/${script}`, import.meta.url));
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
	if (input.event.type === "variant_mount_failed") {
		return [
			...shared,
			[
				"<instructions>",
				"The browser could not mount the published variant. Inspect the reported variant source/module, fix the compile or runtime failure, and stop after the repair.",
				"Do not poll, do not reply, and do not exit the session: the workflow does that.",
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
			"3. Directly under the URL, print how the user ends the review, in plain text: click exit in the Impeccable overlay, close the browser tab, or say `exit live`. State that the review waits indefinitely until they do, and that ending it exports the design as it then stands, with no further round.",
			"4. Do NOT start a poll loop. The workflow owns polling and will call you back for each event that needs you. Ending your turn does not end the review.",
			"</instructions>",
		].join("\n"),
		"<output_format>Under 150 words: the live review URL, the manual fallback path, how to end the review, and whether the browser opened.</output_format>",
	].join("\n\n");
}
