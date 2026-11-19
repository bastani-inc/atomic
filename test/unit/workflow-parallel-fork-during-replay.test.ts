import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, test } from "vitest";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import { stripWorkflowOnlyOptions } from "../../packages/workflows/src/runs/foreground/stage-runner-options.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";
import { closeMemoryTestBackends, createMemoryTestBackend } from "../helpers/workflow-journal.js";
import { appendProseTurn, mockSession, run, workflow } from "./executor-shared.js";
import type { AgentSessionAdapter } from "./stage-runner-helpers.js";

useTemporaryAgentDir();
afterEach(closeMemoryTestBackends);

test("a parallel captures its fork before an earlier replay write finishes (#5630)", async () => {
	const backend = await createMemoryTestBackend();
	const runId = randomUUID();
	const sessionStore = new MemorySessionStore();
	const { sessionManager: source } = await stripWorkflowOnlyOptions({ sessionStore }, undefined, {
		runId,
		stageId: "source",
		stageName: "source",
	});
	assert.ok(source);
	await source.appendMessage({ role: "user", content: "before launch", timestamp: 1 });

	let replay = false;
	const writing = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const prefixes: unknown[][] = [];
	const definition = workflow({
		name: "fork-during-replay",
		description: "",
		inputs: {},
		outputs: {},
		async run(ctx) {
			const cached = ctx.stage("cached");
			if (!replay) {
				await cached.complete("saved");
				return {};
			}
			await writing.promise;
			const group = ctx.parallel(
				[
					{ name: "left", prompt: "left" },
					{ name: "right", prompt: "right" },
				],
				{
					context: "fork",
					forkFromSessionId: source.getSessionId(),
					sessionStore,
				},
			);
			try {
				await source.appendMessage({ role: "user", content: "after launch", timestamp: 2 });
				assert.deepEqual(prefixes, [], "no child opens before the replay write is released");
			} finally {
				release.resolve();
			}
			await group;
			return {};
		},
	});
	const agentSession: AgentSessionAdapter = {
		async create({ sessionManager }, meta) {
			if (meta?.stageName === "left" || meta?.stageName === "right") {
				assert.ok(sessionManager);
				prefixes.push(
					sessionManager.buildSessionContext().messages.map((m) => ("content" in m ? m.content : m.role)),
				);
			}
			const session = mockSession(sessionManager);
			session.prompt = async () => appendProseTurn(session.messages);
			return session;
		},
	};
	const options = {
		runId,
		durableBackend: backend,
		adapters: { complete: { complete: async (text: string) => text }, agentSession },
	};
	const execute = () => run(definition, {}, { ...options, store: createStore() });
	assert.equal((await execute()).status, "completed");
	replay = true;
	const commit = backend.commitCheckpoint.bind(backend);
	backend.commitCheckpoint = async (checkpoint, options) => {
		if (checkpoint.checkpointId.startsWith("stage-replay-meta:")) {
			writing.resolve();
			await release.promise;
		}
		return commit(checkpoint, options);
	};
	const resumed = await execute();
	assert.equal(resumed.status, "completed", resumed.error);
	assert.deepEqual(prefixes, [["before launch"], ["before launch"]]);
});
