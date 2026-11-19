import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/atomic-ai/compat";
import { test, vi } from "vitest";
import { stripAnsi } from "../../packages/coding-agent/src/utils/ansi.js";
import { workflowTranscriptResult } from "../../packages/workflows/src/extension/workflow-tool-inspection.js";
import type { StageChatView } from "../../packages/workflows/src/tui/stage-chat-view.js";
import { PooledStageHandle } from "../../packages/workflows/src/workers/pooled-stage-handle.js";
import { WorkerStageWatches } from "../../packages/workflows/src/workers/stage-watch.js";
import type { WatchId } from "../../packages/workflows/src/workers/stage-watch-types.js";
import { createStageSkillFixture } from "../fixtures/stage-chat-skill-session.js";

type Fixture = Awaited<ReturnType<typeof createStageSkillFixture>>;

/** Open the stage as another process's chat does: through a worker watch whose snapshot seeds a mirror handle. */
function withWorkerView<T>(fixture: Fixture, use: (mirror: PooledStageHandle) => T): T {
	const attempt = { workId: "work", generation: 1 };
	const watch = "watch-1" as WatchId;
	let mirror: PooledStageHandle | undefined;
	const watches = new WorkerStageWatches(
		fixture.registry,
		() => attempt,
		(message) => {
			if (message.kind !== "stage-command-result" || message.snapshot === undefined) return;
			const snapshot = structuredClone(message.snapshot);
			// Reading needs no transport: nothing here delivers to the stage.
			mirror = new PooledStageHandle(
				fixture.runId,
				fixture.stageId,
				"inspect",
				watch,
				snapshot,
				attempt,
				() => {},
				{} as never,
			);
		},
	);
	const target = { runId: fixture.runId, stageId: fixture.stageId };
	try {
		watches.serve({ kind: "stage-command", commandId: 1, attempt, op: "watch", watch, ...target });
		assert.ok(mirror, "the watch answers with a snapshot");
		return use(mirror);
	} finally {
		watches.serve({ kind: "stage-command", commandId: 2, attempt, op: "unwatch", watch });
		mirror?.dispose();
	}
}

const text = (view: StageChatView) => view.render(120).map(stripAnsi).join("\n");

/** The stage's transcript as the `workflow` tool returns it to the parent session. */
function stageTranscript(fixture: Fixture, options: { readonly tail?: number } = {}) {
	const result = workflowTranscriptResult(
		{ action: "transcript", runId: fixture.runId, stageId: fixture.stageId, ...options },
		{ store: fixture.store, stageControlRegistry: fixture.registry },
	);
	if (result.action !== "transcript") throw new Error(`Expected a transcript, got ${result.action}`);
	return result;
}

/** A failed request the stage retried: saved, then left out of its context, so its transcript differs from it. */
async function retriedFailure(fixture: Fixture): Promise<void> {
	const manager = fixture.stage.session.sessionManager;
	const failure = fauxAssistantMessage([], { stopReason: "error", errorMessage: "529 overloaded" });
	await manager.appendContextEdit(await manager.appendMessage(failure), null);
	fixture.stage.session.refreshContext();
}

test("a discarded branch's compaction notice does not make the healthy stage walk its history (#5649)", async () => {
	const fixture = await createStageSkillFixture({
		extensionFactories: [
			(pi) => {
				pi.on("session_before_compact", () => ({ cancel: true }));
			},
		],
	});
	try {
		const session = fixture.stage.session;
		const manager = session.sessionManager;
		const fork = manager.getLeafId();
		assert.ok(fork);
		await assert.rejects(session.compact(), /cancel/i);
		await manager.branch(fork);
		for (let index = 0; index < 64; index++)
			await manager.appendMessage({ role: "user", content: `healthy ${index}`, timestamp: index });
		session.refreshContext();
		const reads = vi.spyOn(manager, "getEntries");
		const result = stageTranscript(fixture);
		assert.equal(result.inlineMode, "path_only");
		assert.equal(result.entryCount, session.messages.length);
		assert.deepEqual(result.entries, []);
		assert.equal(session.transcriptMessages, session.messages, "the active branch uses its resident rows");
		assert.equal(reads.mock.calls.length, 0);
	} finally {
		await fixture.cleanup();
	}
});

const histories = [
	{ history: "a plain history", retried: false },
	{ history: "a retried failure", retried: true },
];

test.each(histories)(
	"a stage reopened after its prompt could not be saved shows that prompt once on either host, after $history (#5613)",
	async ({ retried }) => {
		const fixture = await createStageSkillFixture();
		try {
			if (retried) await retriedFailure(fixture);
			const live = fixture.mount();
			const manager = fixture.stage.session.sessionManager;
			const append = manager.appendMessage.bind(manager);
			const prompt = "Prompt the full disk could not hold";
			vi.spyOn(manager, "appendMessage").mockImplementation(async (message) => {
				if (message.role === "user" && JSON.stringify(message.content).includes(prompt))
					throw new Error("ENOSPC: no space left on device");
				return append(message);
			});
			fixture.stage.appendResponses([fauxAssistantMessage("Never requested.")]);
			await fixture.handle.prompt(prompt).catch(() => {});
			const count = (view: StageChatView) => text(view).split(prompt).length - 1;
			assert.equal(count(live), 1);
			assert.equal(count(fixture.mount()), 1);
			withWorkerView(fixture, (mirror) => assert.equal(count(fixture.mount({ handle: mirror })), 1));
		} finally {
			await fixture.cleanup();
		}
	},
);

test.each(histories)(
	"a stage opened on a call saved without its result shows the call was interrupted on either host, after $history (#5613)",
	async ({ retried }) => {
		const fixture = await createStageSkillFixture();
		try {
			if (retried) await retriedFailure(fixture);
			const session = fixture.stage.session;
			const call = fauxToolCall("bash", { command: "echo saved-call" }, { id: "call-without-result" });
			await session.sessionManager.appendMessage(fauxAssistantMessage([call], { stopReason: "toolUse" }));
			session.refreshContext();
			assert.match(text(fixture.mount()), /interrupted after it started/);
			withWorkerView(fixture, (mirror) =>
				assert.match(text(fixture.mount({ handle: mirror })), /interrupted after it started/),
			);
		} finally {
			await fixture.cleanup();
		}
	},
);

test("the workflow transcript of a stage never returns a hidden row left out of its context (#5613)", async () => {
	const fixture = await createStageSkillFixture();
	try {
		const session = fixture.stage.session;
		const id = await session.sessionManager.appendCustomMessageEntry("note", "HIDDEN NOTE FOR THE MODEL", false);
		await session.sessionManager.appendContextEdit(id, null);
		session.refreshContext();
		const result = stageTranscript(fixture, { tail: 1 });
		assert.equal(result.source, "live");
		assert.deepEqual(
			result.entries.map((entry) => entry.text),
			["Stage ready for skill commands."],
		);
	} finally {
		await fixture.cleanup();
	}
});

test("a worker view of a stage holds no hidden rows left out of its context (#5613)", async () => {
	const fixture = await createStageSkillFixture();
	try {
		const session = fixture.stage.session;
		for (let index = 0; index < 4; index++) {
			const id = await session.sessionManager.appendCustomMessageEntry(
				"note",
				`${index}:${"x".repeat(32_768)}`,
				false,
			);
			await session.sessionManager.appendContextEdit(id, null);
		}
		session.refreshContext();
		withWorkerView(fixture, (mirror) => {
			assert.deepEqual(
				mirror.messages.filter((message) => message.role === "custom" && message.customType === "note"),
				[],
			);
			assert.equal(mirror.messages.length, session.messages.length);
		});
	} finally {
		await fixture.cleanup();
	}
});

test("a path-only workflow transcript of a stage reads none of its saved entries (#5613)", async () => {
	const fixture = await createStageSkillFixture();
	try {
		const session = fixture.stage.session;
		for (let index = 0; index < 64; index++)
			await session.sessionManager.appendMessage({ role: "user", content: `message ${index}`, timestamp: index });
		session.refreshContext();
		const reads = vi.spyOn(session.sessionManager, "getEntries");
		const result = stageTranscript(fixture);
		assert.equal(result.inlineMode, "path_only");
		assert.equal(result.entryCount, session.messages.length);
		assert.equal(reads.mock.calls.length, 0);
	} finally {
		await fixture.cleanup();
	}
});
