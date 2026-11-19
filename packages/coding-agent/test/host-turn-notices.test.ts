import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@bastani/atomic-agent-core";
import { fauxAssistantMessage } from "@bastani/atomic-ai/compat";
import { afterEach, test } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import { convertToLlm } from "../src/core/messages.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
});

/** A persisted session in a temporary directory, and how to open it again from its file. */
async function persistedSession(): Promise<{ manager: SessionManager; reopen(): Promise<SessionManager> }> {
	const root = mkdtempSync(join(tmpdir(), "host-turn-notices-"));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	const dir = join(root, "sessions");
	const manager = await SessionManager.create(root, dir);
	return { manager, reopen: () => SessionManager.open(manager.getSessionFile()!, dir, root) };
}

async function harnessFor(manager: SessionManager, settings: Parameters<typeof createHarness>[0]["settings"]) {
	const harness = await createHarness({ sessionManager: manager, settings });
	cleanups.push(() => harness.cleanup());
	return harness;
}

function messageText(message: AgentMessage): string {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: "text"; text: string } => block?.type === "text")
		.map((block) => block.text)
		.join("");
}

/** The rows a chat shows for these messages: responses, request errors and the lines Atomic writes itself. */
function rows(messages: readonly AgentMessage[]): string[] {
	return messages.flatMap((message) => {
		if (message.role === "assistant")
			return [message.stopReason === "error" ? `error: ${message.errorMessage}` : `reply: ${messageText(message)}`];
		if (message.role === "custom" && message.display) {
			const level = (message.details as { level?: string } | undefined)?.level ?? "";
			return [`${message.customType} ${level}: ${messageText(message)}`];
		}
		return [];
	});
}

/** The rows the session showed while it ran, from its events. */
function liveRows(harness: Harness): string[] {
	return rows(
		harness.events.flatMap((event: AgentSessionEvent) =>
			event.type === "message_end" && event.message.role !== "user" ? [event.message] : [],
		),
	);
}

const overloaded = () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" });

test("a final retry failure reopens with the session, in its place, and never reaches the model (#5649)", async () => {
	const { manager, reopen } = await persistedSession();
	const harness = await harnessFor(manager, { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } });
	harness.setResponses([overloaded(), overloaded()]);

	await harness.session.prompt("hello");

	const live = liveRows(harness);
	assert.deepEqual(live, [
		"error: overloaded_error",
		"error: overloaded_error",
		"atomic.notice error: Retry failed after 1 attempts: overloaded_error",
	]);
	const reopened = await reopen();
	assert.deepEqual(rows(reopened.buildSessionProjection("transcript").messages), live, "reopened rows");
	const context = reopened.buildSessionContext().messages;
	assert.ok(!context.some((message) => message.role === "custom"), "the line is not model context");
	assert.doesNotMatch(JSON.stringify(convertToLlm(harness.session.messages)), /Retry failed/);
});

test("a retry cancelled during its wait reopens as the same line (#5649)", async () => {
	const { manager, reopen } = await persistedSession();
	const harness = await harnessFor(manager, { retry: { enabled: true, maxRetries: 3, baseDelayMs: 5_000 } });
	harness.setResponses([overloaded()]);
	harness.session.subscribe((event) => {
		if (event.type === "auto_retry_start") harness.session.abortRetry();
	});

	await harness.session.prompt("hello");

	const live = liveRows(harness);
	assert.deepEqual(live, [
		"error: overloaded_error",
		"atomic.notice error: Retry failed after 1 attempts: Retry cancelled",
	]);
	assert.deepEqual(rows((await reopen()).buildSessionProjection("transcript").messages), live);
});

test("the next prompt follows the saved line, and its request leaves the line out (#5649)", async () => {
	const { manager, reopen } = await persistedSession();
	const harness = await harnessFor(manager, { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } });
	let lastContext = "";
	harness.setResponses([
		overloaded(),
		overloaded(),
		(context) => {
			lastContext = JSON.stringify(context);
			return fauxAssistantMessage("fine");
		},
	]);
	await harness.session.prompt("first");
	await harness.session.prompt("second");

	assert.match(lastContext, /second/);
	assert.doesNotMatch(lastContext, /Retry failed/);
	assert.deepEqual(rows((await reopen()).buildSessionProjection("transcript").messages).slice(-2), [
		"atomic.notice error: Retry failed after 1 attempts: overloaded_error",
		"reply: fine",
	]);
});

test("a provider error longer than the notice bound is saved cut at a whole character (#5649)", async () => {
	const { manager, reopen } = await persistedSession();
	const harness = await harnessFor(manager, { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } });
	// A page of mixed-width text with a surrogate pair at every possible cut.
	const page = `overloaded ${"漢字😀e\u0301".repeat(20_000)}`;
	const failing = () => fauxAssistantMessage("", { stopReason: "error", errorMessage: page });
	harness.setResponses([failing(), failing()]);

	await harness.session.prompt("hello");

	const notices = (await reopen())
		.getEntries()
		.flatMap((entry) => (entry.type === "custom" && entry.customType === "atomic.notice" ? [entry] : []));
	assert.equal(notices.length, 1);
	const text = (notices[0]!.data as { text: string }).text;
	assert.ok(Buffer.byteLength(text) <= 4096, `${Buffer.byteLength(text)} bytes`);
	assert.ok(text.isWellFormed(), "no lone surrogate");
	assert.ok(text.endsWith("…"));
	assert.ok(text.startsWith("Retry failed after 1 attempts: overloaded 漢字😀e\u0301"));
	const live = harness.events.flatMap((event) =>
		event.type === "message_end" && event.message.role === "custom" ? [messageText(event.message)] : [],
	);
	assert.deepEqual(live, [text], "the live line is the saved one");
});
