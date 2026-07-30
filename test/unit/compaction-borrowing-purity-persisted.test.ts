/**
 * RFC §8 — borrowing purity on a *persisted* session.
 *
 * The companion in-memory test proves the invariant against a RAM-backed
 * `SessionManager`. This one proves it against the durable artifact, which is
 * what a reviewer or a resumed session actually reads: the JSONL prefix stays
 * byte-identical, exactly one line is appended, and it is the expected
 * compaction boundary.
 *
 * ⚠ CONTRACT CONFLICT — needs user clarification, not an implementation choice.
 * RFC §8 says the *entire* session entry list is "byte-identical to before"
 * after a rescued compaction. A successful durable compaction must append a
 * `CompactionEntry`, so the whole list cannot be unchanged; the two clauses
 * cannot both hold literally. This test encodes the feasible reading — an
 * append-only change consisting of exactly the one expected boundary, with no
 * model or thinking-level history — and asserts the byte-identity clause on the
 * pre-existing prefix, where it can hold. Only the user can reconcile the
 * literal wording with durable persistence.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai/compat";
import { getModel } from "@earendil-works/pi-ai/compat";
import { test } from "vitest";
import { AgentSession, type AgentSessionEvent } from "../../packages/coding-agent/src/core/agent-session.js";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.js";
import { ModelRuntime } from "../../packages/coding-agent/src/core/model-runtime.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import { createTestResourceLoader } from "../../packages/coding-agent/test/utilities.js";

const SESSION_MODEL = getModel("anthropic", "claude-sonnet-4-5")!;
const PRIMARY_KEY = "anthropic-secret-key";
const FALLBACK_KEY = "openai-secret-key";

function assistantMessage(text: string, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
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
		timestamp,
	} as AssistantMessage;
}

/** The session model always throttles; the configured fallback ranks the lines. */
function rescueStream(): { streamFn: StreamFn; models: string[] } {
	const models: string[] = [];
	const streamFn = ((model: Model<Api>) => {
		models.push(`${model.provider}/${model.id}`);
		const throttled = model.provider === "anthropic";
		return {
			result: async (): Promise<AssistantMessage> =>
				({
					role: "assistant",
					content: throttled ? [] : [{ type: "text", text: "3,8\n" }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: throttled ? "error" : "stop",
					...(throttled ? { errorMessage: "429 Too Many Requests" } : {}),
					timestamp: Date.now(),
				}) as AssistantMessage,
		};
	}) as unknown as StreamFn;
	return { streamFn, models };
}

interface PersistedHarness {
	session: AgentSession;
	manager: SessionManager;
	events: AgentSessionEvent[];
	/** Every event emitted on the *extension* channel, where `model_select` lives. */
	extensionEvents: string[];
	continueCalls: () => number;
	models: string[];
	sessionFile: string;
	dispose: () => void;
}

async function createPersistedSession(directory: string): Promise<PersistedHarness> {
	const { streamFn, models } = rescueStream();
	const manager = SessionManager.create(directory, directory);
	const agent = new Agent({
		getApiKey: () => PRIMARY_KEY,
		initialState: { model: SESSION_MODEL, systemPrompt: "test", tools: [], thinkingLevel: "high" },
		streamFn,
	});
	let continued = 0;
	const realContinue = agent.continue.bind(agent);
	agent.continue = ((...args: Parameters<typeof realContinue>) => {
		continued += 1;
		return realContinue(...args);
	}) as typeof agent.continue;

	const authStorage = AuthStorage.inMemory({
		anthropic: { type: "api_key", key: PRIMARY_KEY },
		openai: { type: "api_key", key: FALLBACK_KEY },
	});
	const modelRuntime = await ModelRuntime.create({ credentials: authStorage, modelsPath: null });
	const settingsManager = SettingsManager.inMemory();
	// One transport attempt per candidate, so the ladder alone explains the calls.
	settingsManager.applyOverrides({ retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 } });
	const session = new AgentSession({
		agent,
		sessionManager: manager,
		settingsManager,
		cwd: directory,
		modelRuntime,
		resourceLoader: createTestResourceLoader(),
		fallbackModels: ["openai/gpt-5.1"],
	});

	const now = Date.now();
	for (let turn = 0; turn < 6; turn++) {
		manager.appendMessage({ role: "user", content: `task ${turn}\nline a\nline b`, timestamp: now + turn * 2 });
		manager.appendMessage(assistantMessage(`answer ${turn}\nline c\nline d`, now + turn * 2 + 1));
	}
	agent.state.messages = manager.buildSessionContext().messages;

	const sessionFile = manager.getSessionFile();
	assert.ok(sessionFile, "the persisted session has no session file");

	const events: AgentSessionEvent[] = [];
	session.subscribe((event) => events.push(event));

	// `model_select` is an extension event, not an `AgentSessionEvent`, so
	// filtering the session event list for it proves nothing. Instrument the
	// channel it actually travels on: `_emitModelSelect` calls
	// `_extensionRunner.emit({ type: "model_select", ... })`.
	const extensionEvents: string[] = [];
	const runner = (session as unknown as { _extensionRunner: { emit: (event: { type?: string }) => Promise<unknown> } })
		._extensionRunner;
	const realEmit = runner.emit.bind(runner);
	runner.emit = (event: { type?: string }) => {
		extensionEvents.push(String(event?.type ?? ""));
		return realEmit(event);
	};

	return {
		session,
		manager,
		events,
		extensionEvents,
		continueCalls: () => continued,
		models,
		sessionFile,
		dispose: () => session.dispose(),
	};
}

function attemptedKeys(session: AgentSession): string[] {
	return [...(session as unknown as { _fallbackAttemptedKeys: Set<string> })._fallbackAttemptedKeys];
}

function jsonlLines(path: string): string[] {
	return recordsOf(readFileSync(path, "utf-8"));
}

/** JSONL records in a captured file snapshot. */
function recordsOf(raw: string): string[] {
	return raw.split("\n").filter((line) => line.length > 0);
}

test("a rescued compaction appends exactly one durable boundary and nothing else", async () => {
	const directory = mkdtempSync(join(tmpdir(), "compaction-purity-persisted-"));
	const harness = await createPersistedSession(directory);
	try {
		const before = {
			model: harness.session.model,
			thinkingLevel: harness.session.thinkingLevel,
			attempted: attemptedKeys(harness.session),
			raw: readFileSync(harness.sessionFile, "utf-8"),
		};

		const result = await harness.session.compact({ preserve_recent: 2 });

		// The session model was tried first; the configured fallback rescued it.
		assert.deepEqual(harness.models, ["anthropic/claude-sonnet-4-5", "openai/gpt-5.1"]);
		assert.equal(result.rung, "planned");
		assert.deepEqual(result.plannerModel, { provider: "openai", id: "gpt-5.1", thinkingLevel: "high" });

		// Live session state is untouched.
		assert.equal(harness.session.model, before.model);
		assert.equal(harness.session.thinkingLevel, before.thinkingLevel);
		assert.deepEqual(attemptedKeys(harness.session), before.attempted);

		// The durable record changed only by appending: every pre-existing byte is
		// still exactly where it was.
		const after = readFileSync(harness.sessionFile, "utf-8");
		assert.equal(after.slice(0, before.raw.length), before.raw);

		// And the append is exactly the one expected compaction boundary.
		const addedLines = jsonlLines(harness.sessionFile).slice(recordsOf(before.raw).length);
		assert.equal(addedLines.length, 1);
		const added = JSON.parse(addedLines[0]) as {
			type: string;
			details?: { rung?: string; strategy?: string; plannerModel?: unknown };
		};
		assert.equal(added.type, "compaction");
		assert.equal(added.details?.strategy, "verbatim-lines");
		assert.equal(added.details?.rung, "planned");
		assert.deepEqual(added.details?.plannerModel, { provider: "openai", id: "gpt-5.1", thinkingLevel: "high" });

		// No model or thinking-level history was written by the rescue.
		for (const line of jsonlLines(harness.sessionFile)) {
			const entry = JSON.parse(line) as { type?: string };
			assert.ok(
				entry.type !== "model_change" && entry.type !== "thinking_level_change",
				`the rescued compaction wrote a ${entry.type} entry`,
			);
		}

		// Session-channel events: no model change or fallback announcement.
		const forbiddenSessionEvents = new Set(["model_changed", "model_fallback_start"]);
		assert.deepEqual(
			harness.events.filter((event) => forbiddenSessionEvents.has(event.type as string)),
			[],
		);

		// Extension-channel events: `model_select` travels here, not on
		// AgentSessionEvent, so its absence is proved on the instrumented channel
		// rather than by filtering a union that cannot contain it.
		assert.ok(
			!harness.extensionEvents.includes("model_select"),
			`the rescue emitted model_select: ${harness.extensionEvents.join(", ")}`,
		);
		// The channel really is live — the compaction hooks did fire through it.
		assert.ok(
			harness.extensionEvents.includes("session_compact"),
			`the extension channel was not exercised: ${harness.extensionEvents.join(", ")}`,
		);
		assert.equal(harness.continueCalls(), 0);
	} finally {
		harness.dispose();
		rmSync(directory, { recursive: true, force: true });
	}
});

test("no borrowed or session credential reaches the durable session artifacts", async () => {
	const directory = mkdtempSync(join(tmpdir(), "compaction-purity-secrets-"));
	const harness = await createPersistedSession(directory);
	try {
		const result = await harness.session.compact({ preserve_recent: 2 });
		assert.equal(result.plannerModel?.id, "gpt-5.1");

		// Every file the compaction may have written: the JSONL, its backup
		// snapshot, and any diagnostic or success sidecar.
		const written = readdirSync(directory).map((name) => join(directory, name));
		assert.ok(written.length >= 1, "the persisted session wrote no files");
		for (const file of written) {
			let raw: string;
			try {
				raw = readFileSync(file, "utf-8");
			} catch {
				continue; // a directory, not a file
			}
			assert.ok(!raw.includes(PRIMARY_KEY), `${file} leaked the session model credential`);
			assert.ok(!raw.includes(FALLBACK_KEY), `${file} leaked the borrowed model credential`);
			assert.ok(!raw.includes("apiKey"), `${file} contains an apiKey field`);
		}
	} finally {
		harness.dispose();
		rmSync(directory, { recursive: true, force: true });
	}
});
