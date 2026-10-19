import { describe, test } from "vitest";
import type { AgentSessionAdapter, InternalStageContext } from "./stage-runner-helpers.js";
import { assert, createStageContext, flushMicrotasks, makeMockSession, makeOpts } from "./stage-runner-helpers.js";

function contextOver(session: ReturnType<typeof makeMockSession>["session"]): InternalStageContext {
	const agentSession: AgentSessionAdapter = {
		async create() {
			return session;
		},
	};
	return createStageContext(makeOpts({ adapters: { agentSession } })) as InternalStageContext;
}

describe("createStageContext — idle for release", () => {
	test("a stage with no live session has nothing to release, and an idle one is releasable (#3622)", async () => {
		const { session } = makeMockSession({ async prompt() {} });
		const ctx = contextOver(session);

		assert.equal(ctx.__idleForRelease(), false);
		await ctx.prompt("initial");
		assert.equal(ctx.__idleForRelease(), true);
	});

	test("a message waiting in the admission queue blocks release until it settles (#3622)", async () => {
		const delivery = Promise.withResolvers<void>();
		const { session } = makeMockSession({
			async prompt() {},
			async sendUserMessage(_text, options) {
				await delivery.promise;
				options?.__workflowDelivery?.beforeDelivery?.();
				options?.__workflowDelivery?.delivered?.("prompt");
			},
		});
		const ctx = contextOver(session);
		await ctx.prompt("initial");

		const sending = ctx.__sendUserMessage("racing message");
		assert.equal(ctx.__idleForRelease(), false, "admission is held from the moment the message is submitted");
		delivery.resolve();
		await sending;
		assert.equal(ctx.__idleForRelease(), true);
	});

	test("a session restore that is still in flight blocks release (#3622)", async () => {
		const creation = Promise.withResolvers<void>();
		const { session } = makeMockSession({ async prompt() {}, async sendUserMessage() {} });
		const agentSession: AgentSessionAdapter = {
			async create() {
				await creation.promise;
				return session;
			},
		};
		const ctx = createStageContext(makeOpts({ adapters: { agentSession } })) as InternalStageContext;

		const restoring = ctx.__sendUserMessage("first message");
		await flushMicrotasks();
		assert.equal(ctx.__idleForRelease(), false);
		creation.resolve();
		await restoring;
		assert.equal(ctx.__idleForRelease(), true);
	});

	test("a session that is attached but not yet ready blocks release (#3622)", async () => {
		const readiness = Promise.withResolvers<void>();
		const { session } = makeMockSession({ async prompt() {} });
		const agentSession: AgentSessionAdapter = {
			async create() {
				return session;
			},
		};
		const ctx = createStageContext(
			makeOpts({ adapters: { agentSession }, onSessionReady: () => readiness.promise }),
		) as InternalStageContext;

		const ensuring = ctx.__ensureSession();
		await flushMicrotasks();
		assert.equal(ctx.__idleForRelease(), false);
		readiness.resolve();
		await ensuring;
		assert.equal(ctx.__idleForRelease(), true);
	});

	test("a retry waiting to run blocks release (#3622)", async () => {
		const failed = Promise.withResolvers<void>();
		const { session } = makeMockSession({
			async prompt() {
				failed.resolve();
				throw new Error("503 service unavailable");
			},
		});
		const agentSession: AgentSessionAdapter = {
			async create() {
				return {
					session,
					settingsManager: { getRetrySettings: () => ({ enabled: true, maxRetries: 2, baseDelayMs: 60_000 }) },
				};
			},
		};
		const ctx = createStageContext(
			makeOpts({ adapters: { agentSession }, stageOptions: { model: "anthropic/primary" } }),
		) as InternalStageContext;

		const prompting = ctx.prompt("go").then(
			() => undefined,
			(error: Error) => error,
		);
		await failed.promise;
		await flushMicrotasks();
		assert.equal(ctx.__idleForRelease(), false, "the stage is sleeping before its next attempt");

		await ctx.__dispose();
		assert.ok(await prompting, "disposing ends the wait with an error");
	});

	test("a controlled pause blocks release until the stage resumes (#3622)", async () => {
		const { session } = makeMockSession({ async prompt() {} });
		const ctx = contextOver(session);
		await ctx.prompt("initial");

		await ctx.__requestPause();
		assert.equal(ctx.__idleForRelease(), false);
		await ctx.__resume();
		assert.equal(ctx.__idleForRelease(), true);
	});

	test("a disposed stage is never releasable again (#3622)", async () => {
		const { session } = makeMockSession({ async prompt() {} });
		const ctx = contextOver(session);
		await ctx.prompt("initial");

		await ctx.__dispose();
		assert.equal(ctx.__idleForRelease(), false);
	});
});
