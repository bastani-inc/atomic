/**
 * The webhooks built-in's wiring (`src/extensions/webhooks/index.ts`).
 *
 * Issue #2345: the pure parts (config, templates, sender, reducer) have their
 * own suites. What is only testable here is the part that is not pure: which
 * session is allowed to send, what a config change does to deliveries already in
 * flight, whether an answered question stops its own retries, and whether
 * shutdown drains inside its budget. Events are driven through a real
 * `ExtensionRunner`, the way `packages/coding-agent/test/herdr-extension.test.ts`
 * drives Herdr, so the admission gate and the ownership guard are exercised for
 * real rather than simulated.
 *
 * Every URL here is unroutable and every token is fake; nothing is sent.
 */

import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { createEventBus } from "../../packages/coding-agent/src/core/event-bus.js";
import {
	createExtensionRuntime,
	loadExtensionFromFactory,
} from "../../packages/coding-agent/src/core/extensions/loader.js";
import { ExtensionRunner } from "../../packages/coding-agent/src/core/extensions/runner.js";
import { noOpUIContext } from "../../packages/coding-agent/src/core/extensions/runner-ui.js";
import type {
	ExtensionMode,
	OrchestrationContext,
	SubagentChildPolicy,
} from "../../packages/coding-agent/src/core/extensions/types.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { createWebhooksExtension } from "../../packages/coding-agent/src/extensions/webhooks/index.js";
import type {
	WebhookSendOptions,
	WebhookSendOutcome,
} from "../../packages/coding-agent/src/extensions/webhooks/sender.js";
import type { WebhookDestination } from "../../packages/coding-agent/src/extensions/webhooks/types.js";

const FAKE_TOKEN = "test-token-not-a-secret";

interface Sent {
	readonly name: string;
	readonly body: string;
	readonly signal: AbortSignal | undefined;
}

interface Harness {
	readonly runner: ExtensionRunner;
	readonly sent: Sent[];
	readonly notices: { message: string; type: string | undefined }[];
	/** Resolves the pending send for a destination, so a test can hold one open. */
	release(name: string, outcome?: WebhookSendOutcome): void;
	readonly configPath: string;
}

async function harness(
	document: unknown,
	over: {
		mode?: ExtensionMode;
		ui?: boolean;
		child?: SubagentChildPolicy;
		orchestration?: OrchestrationContext;
		hold?: boolean;
		shutdownGraceMs?: number;
	} = {},
): Promise<Harness> {
	const dir = await mkdtemp(join(tmpdir(), "webhooks-ext-"));
	const configPath = join(dir, "webhooks.json");
	await writeFile(configPath, JSON.stringify(document), "utf8");

	const sent: Sent[] = [];
	const notices: { message: string; type: string | undefined }[] = [];
	const waiting = new Map<string, (outcome: WebhookSendOutcome) => void>();

	const send = (
		target: WebhookDestination,
		body: string,
		options: WebhookSendOptions,
	): Promise<WebhookSendOutcome> => {
		sent.push({ name: target.name, body, signal: options.signal });
		if (over.hold !== true) return Promise.resolve({ kind: "accepted", status: 200, attempts: 1 });
		return new Promise<WebhookSendOutcome>((resolve) => {
			waiting.set(target.name, resolve);
			options.signal?.addEventListener("abort", () => resolve({ kind: "cancelled" }));
		});
	};

	const runtime = createExtensionRuntime();
	const extension = await loadExtensionFromFactory(
		createWebhooksExtension({
			configPath,
			send,
			...(over.shutdownGraceMs === undefined ? {} : { shutdownGraceMs: over.shutdownGraceMs }),
		}),
		dir,
		createEventBus(),
		runtime,
		"webhooks",
	);
	const runner = new ExtensionRunner(
		[extension],
		runtime,
		dir,
		SessionManager.inMemory(),
		{} as never,
		over.orchestration,
		over.child,
	);
	runner.setUIContext(
		over.ui === false
			? undefined
			: {
					...noOpUIContext,
					notify: (message: string, type?: "info" | "warning" | "error") => notices.push({ message, type }),
				},
		over.mode ?? "tui",
	);
	return {
		runner,
		sent,
		notices,
		configPath,
		release: (name, outcome = { kind: "accepted", status: 200, attempts: 1 }) => waiting.get(name)?.(outcome),
	};
}

/**
 * Raw JSON for the config file, deliberately not typed as a valid destination:
 * what the file may contain is exactly what validation is here to judge.
 */
function destination(over: Record<string, unknown> = {}): unknown {
	return {
		name: "My channel",
		type: "custom",
		enabled: true,
		events: ["agent_finished", "agent_needs_input"],
		url: "https://example.invalid/hook",
		headers: { Authorization: `Bearer ${FAKE_TOKEN}` },
		...over,
	};
}

const document = (...destinations: unknown[]) => ({ version: 1, destinations });

/** One completed agent loop: an assistant message, then an idle settle. */
async function finishOneLoop(runner: ExtensionRunner): Promise<void> {
	await runner.emit({ type: "agent_start" });
	await runner.emit({
		type: "agent_end",
		messages: [
			{
				role: "assistant",
				content: [{ type: "text", text: "Done." }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			},
		],
	} as never);
	await runner.emit({ type: "agent_settled" });
}

test("a finished agent loop delivers once to a subscribed destination, with the rendered body", async () => {
	const h = await harness(document(destination()));
	await h.runner.emit({ type: "session_start", reason: "startup" });
	await finishOneLoop(h.runner);

	assert.equal(h.sent.length, 1);
	assert.equal(h.sent[0]?.name, "My channel");
	const body = JSON.parse(h.sent[0]!.body) as Record<string, string>;
	assert.equal(body.event, "agent_finished");
	assert.equal(body.outcome, "completed");
	assert.match(body.message ?? "", /Atomic: Main agent finished/);
	assert.equal(body.details, "Done.");
	assert.deepEqual(h.notices, []);
	h.runner.invalidate();
});

test("nothing is delivered from a session that must not send", async () => {
	const cases: Parameters<typeof harness>[1][] = [
		{ mode: "print" },
		{ mode: "rpc" },
		{ mode: "json" },
		{ ui: false },
		{
			child: {
				managementActions: "restricted",
				fanoutAuthorized: false,
				inheritProjectContext: true,
				inheritSkills: true,
			},
		},
		{ orchestration: { kind: "workflow-stage" } as OrchestrationContext },
	];
	for (const over of cases) {
		const h = await harness(document(destination()), over);
		await h.runner.emit({ type: "session_start", reason: "startup" });
		await finishOneLoop(h.runner);
		assert.deepEqual(h.sent, [], JSON.stringify(over));
		h.runner.invalidate();
	}
});

test("a destination that is disabled, or not subscribed to the event, is skipped", async () => {
	const h = await harness(
		document(
			destination({ name: "Off", enabled: false }),
			destination({ name: "Other events", events: ["workflow_failed"] }),
			destination({ name: "Listening" }),
		),
	);
	await h.runner.emit({ type: "session_start", reason: "startup" });
	await finishOneLoop(h.runner);
	assert.deepEqual(
		h.sent.map((s) => s.name),
		["Listening"],
	);
	h.runner.invalidate();
});

test("an answered question aborts the delivery it was about", async () => {
	const h = await harness(document(destination()), { hold: true });
	await h.runner.emit({ type: "session_start", reason: "startup" });
	await h.runner.emit({ type: "ui_prompt_start", reason: "ui_prompt", kind: "custom", title: "Proceed?" });
	assert.equal(h.sent.length, 1, "the question started a delivery");
	assert.equal(h.sent[0]?.signal?.aborted, false);

	await h.runner.emit({ type: "ui_prompt_end", reason: "ui_prompt", kind: "custom" });
	// Aborting the signal is what stops the retries: fetchWithRetry tests the
	// caller's signal at the top of every attempt and abandons the wait between.
	assert.equal(h.sent[0]?.signal?.aborted, true, "the answer reached the delivery in flight");
	h.runner.invalidate();
});

test("a malformed config reports once and sends nothing", async () => {
	const h = await harness("not a webhooks document");
	await h.runner.emit({ type: "session_start", reason: "startup" });
	await finishOneLoop(h.runner);
	await finishOneLoop(h.runner);
	assert.deepEqual(h.sent, []);
	assert.equal(h.notices.length, 1, "one notice, however many events follow");
	assert.equal(h.notices[0]?.type, "error");
	assert.ok(!h.notices[0]?.message.includes("example.invalid"), "a diagnostic never carries a URL");
	h.runner.invalidate();
});

test("an entry that fails validation is named, and the valid ones keep working", async () => {
	const h = await harness(
		document(destination({ name: "Broken", events: ["not-an-event"] }), destination({ name: "Fine" })),
	);
	await h.runner.emit({ type: "session_start", reason: "startup" });
	await finishOneLoop(h.runner);
	assert.deepEqual(
		h.sent.map((s) => s.name),
		["Fine"],
	);
	assert.equal(h.notices.length, 1);
	assert.match(h.notices[0]?.message ?? "", /Broken/);
	assert.equal(h.notices[0]?.type, "warning");
	h.runner.invalidate();
});

test("shutdown waits for a delivery in flight only up to its grace, then abandons it", async () => {
	const h = await harness(document(destination()), { hold: true, shutdownGraceMs: 50 });
	await h.runner.emit({ type: "session_start", reason: "startup" });
	await h.runner.emit({ type: "ui_prompt_start", reason: "ui_prompt", kind: "input" });
	assert.equal(h.sent.length, 1);

	const started = Date.now();
	await h.runner.emit({ type: "session_shutdown", reason: "quit" });
	const elapsed = Date.now() - started;
	// Both bounds matter: it waits (so a delivery that would have finished gets
	// its chance), and it stops waiting (so quitting is not hostage to a receiver).
	assert.ok(elapsed >= 40, `shutdown should wait for its grace, took only ${elapsed}ms`);
	assert.ok(elapsed < 2_000, `shutdown must not wait on the receiver, took ${elapsed}ms`);
	assert.equal(h.sent[0]?.signal?.aborted, true, "an abandoned delivery is aborted, not left running");
	h.runner.invalidate();
});

test("nothing is delivered after shutdown", async () => {
	const h = await harness(document(destination()));
	await h.runner.emit({ type: "session_start", reason: "startup" });
	await h.runner.emit({ type: "session_shutdown", reason: "quit" });
	await finishOneLoop(h.runner);
	assert.deepEqual(h.sent, []);
	h.runner.invalidate();
});
