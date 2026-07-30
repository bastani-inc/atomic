/**
 * A post-mortem stage chat restores its saved session lazily, on the first
 * accepted message. That restore is a real wait, so the pane must show Working
 * for it rather than sitting idle until the session finally exists.
 *
 * Also checks that restore stays conversation-only: the workflow stage snapshot
 * must remain terminal throughout, and a failed restore must not leave Working
 * stuck.
 *
 * cross-ref:
 *   - packages/workflows/src/runs/foreground/postmortem-stage-chat.ts
 *   - packages/workflows/src/runs/foreground/stage-runner-controller.ts
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import { ensurePostMortemStageHandle } from "../../packages/workflows/src/runs/foreground/postmortem-stage-chat.js";
import { createStageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import type { StageAdapters } from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import type { StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { mockSession, type StageSessionRuntime } from "./executor-shared.js";
import {
	assert,
	createStore,
	deriveGraphTheme,
	StageChatView,
	type StageControlHandle,
	setupRun,
	stripAnsi,
} from "./stage-chat-view-helpers.js";

let tempDir = "";
beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "atomic-postmortem-working-"));
});
afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

function retainedSessionFile(name: string): string {
	const path = join(tempDir, `${name}.jsonl`);
	writeFileSync(
		path,
		`${[
			JSON.stringify({
				type: "session",
				version: 3,
				id: `${name}-session`,
				timestamp: new Date().toISOString(),
				cwd: tempDir,
			}),
			JSON.stringify({
				type: "message",
				id: `${name}-message`,
				parentId: null,
				timestamp: new Date().toISOString(),
				message: { role: "user", content: "Original stage request" },
			}),
		].join("\n")}\n`,
	);
	return path;
}

function completedStage(sessionFile: string): StageSnapshot {
	return {
		id: "stage-a",
		name: "review-a",
		status: "completed",
		parentIds: [],
		toolEvents: [],
		sessionFile,
	};
}

interface LazyHandleFixture {
	readonly handle: StageControlHandle;
	readonly view: StageChatView;
	readonly store: ReturnType<typeof createStore>;
	readonly creationEntered: Promise<void>;
	readonly releaseCreation: () => void;
	readonly failCreation: (error: Error) => void;
	readonly promptCalls: string[];
	readonly lifecycleEvents: string[];
	renderRequests: number;
}

function lazyPostMortemFixture(name: string, sessionFile: string): LazyHandleFixture {
	const entered = Promise.withResolvers<void>();
	const gate = Promise.withResolvers<void>();
	const promptCalls: string[] = [];
	const lifecycleEvents: string[] = [];
	const session: StageSessionRuntime = {
		...mockSession(),
		sessionFile,
		async prompt(text: string) {
			lifecycleEvents.push("prompt");
			promptCalls.push(text);
		},
		async sendUserMessage(content: unknown) {
			lifecycleEvents.push("send");
			promptCalls.push(String(content));
		},
		async closeWorkflowStageGeneration() {
			lifecycleEvents.push("close_generation");
		},
	} as StageSessionRuntime;
	const adapters: StageAdapters = {
		agentSession: {
			async create() {
				entered.resolve();
				await gate.promise;
				return session;
			},
		},
	};
	const registry = createStageControlRegistry();
	const stage = completedStage(sessionFile);
	const result = ensurePostMortemStageHandle(`run-${name}`, stage, {
		registry,
		adapters,
		cwd: tempDir,
	});
	assert.equal(result.ok, true);
	if (!result.ok) throw new Error("expected an eligible post-mortem stage");

	const store = createStore();
	setupRun(store, "run-1", "stage-a", "completed");
	const fixture: LazyHandleFixture = {
		handle: result.handle,
		store,
		creationEntered: entered.promise,
		releaseCreation: () => gate.resolve(),
		failCreation: (error) => gate.reject(error),
		promptCalls,
		lifecycleEvents,
		renderRequests: 0,
		view: undefined as unknown as StageChatView,
	};
	(fixture as { view: StageChatView }).view = new StageChatView({
		store,
		graphTheme: deriveGraphTheme({}),
		runId: "run-1",
		stageId: "stage-a",
		workflowName: "test-wf",
		handle: result.handle,
		onDetach: () => {},
		onClose: () => {},
		requestRender: () => {
			fixture.renderRequests += 1;
		},
	});
	return fixture;
}

function renderText(view: StageChatView): string {
	return stripAnsi(view.render(96).join("\n"));
}

test("a post-mortem chat shows Working while its saved session restores", async () => {
	const sessionFile = retainedSessionFile("restore-working");
	const fixture = lazyPostMortemFixture("restore", sessionFile);

	try {
		assert.doesNotMatch(renderText(fixture.view), /Working/);
		fixture.renderRequests = 0;

		const delivery = fixture.handle.sendUserMessage?.("follow up after the fact");
		assert.ok(delivery, "post-mortem handles expose sendUserMessage");
		await fixture.creationEntered;

		assert.match(
			renderText(fixture.view),
			/Working/,
			"expected Working while the retained session was still restoring",
		);
		assert.equal(fixture.view._hasAnimationTick, true);
		assert.ok(fixture.renderRequests > 0, "expected an immediate render request");
		assert.deepEqual(fixture.promptCalls, [], "no SDK mutation before restore completes");

		fixture.releaseCreation();
		await delivery;
		assert.deepEqual(fixture.promptCalls, ["follow up after the fact"]);
		assert.deepEqual(
			fixture.lifecycleEvents,
			["close_generation", "send"],
			"post-mortem generation closure must precede SDK delivery",
		);

		// Conversation-only: the workflow snapshot stays terminal.
		assert.equal(fixture.store.runs()[0]!.stages[0]!.status, "completed");
	} finally {
		fixture.releaseCreation();
		fixture.view.dispose();
	}
});

test("a failed restore settles the post-mortem chat instead of sticking on Working", async () => {
	const sessionFile = retainedSessionFile("restore-failure");
	const fixture = lazyPostMortemFixture("failure", sessionFile);

	try {
		const delivery = fixture.handle.sendUserMessage?.("follow up that cannot land");
		assert.ok(delivery);
		await fixture.creationEntered;
		assert.match(renderText(fixture.view), /Working/);

		fixture.failCreation(new Error("retained session is unreadable"));
		await assert.rejects(delivery, /retained session is unreadable/);

		assert.doesNotMatch(renderText(fixture.view), /Working/, "a failed restore must not leave Working stuck");
		assert.equal(fixture.view._hasAnimationTick, false);
		assert.deepEqual(fixture.promptCalls, []);
		assert.deepEqual(fixture.lifecycleEvents, [], "failed restore must not close or deliver");
		assert.equal(fixture.store.runs()[0]!.stages[0]!.status, "completed");
	} finally {
		fixture.view.dispose();
	}
});
