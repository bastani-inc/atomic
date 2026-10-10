import assert from "node:assert/strict";
import { join } from "node:path";
import { SessionManager } from "@bastani/atomic";
import { test } from "vitest";
import { setAgentSessionAdapterDefaultCwd } from "../../packages/workflows/src/runs/foreground/stage-runner-session-options.js";
import type { StageOptions } from "../../packages/workflows/src/shared/types.js";
import { appendProseTurn, mockSession, run, workflow } from "./executor-shared.js";
import type { AgentSessionAdapter, StageSessionCreateOptions } from "./stage-runner-helpers.js";
import { mkdtemp, rm, tmpdir } from "./stage-runner-helpers.js";

for (const options of [undefined, {}, { thinkingLevel: "low" }] satisfies (StageOptions | undefined)[]) {
	for (const persist of [false, true]) {
		test(`stages with ${JSON.stringify(options)} inherit invocation cwd with persistence=${persist} (#3551)`, async () => {
			const cwd = await mkdtemp(join(tmpdir(), "workflow-owner-cwd-"));
			let created: StageSessionCreateOptions | undefined;
			const session = mockSession();
			session.prompt = async () => appendProseTurn(session.messages);
			try {
				const result = await run(
					workflow({
						name: "owner-cwd",
						description: "",
						inputs: {},
						outputs: {},
						run: async (ctx) => {
							await ctx.stage("worker", options).prompt("hello");
							return {};
						},
					}),
					{},
					{
						cwd,
						defaultSessionDir: persist ? join(cwd, "sessions") : undefined,
						adapters: {
							agentSession: {
								async create(sessionOptions) {
									created = sessionOptions;
									return session;
								},
							},
						},
					},
				);
				assert.equal(result.status, "completed", result.error);
				assert.notEqual(cwd, process.cwd());
				assert.equal(created?.cwd, cwd);
				assert.equal(created?.sessionManager?.getCwd(), persist ? cwd : undefined);
				assert.equal(created?.sessionManager?.getHeader()?.cwd, persist ? cwd : undefined);
			} finally {
				await rm(cwd, { recursive: true, force: true });
			}
		});
	}
}

for (const override of ["adapter", "cwd", "sessionManager", "sessionManagerWithAdapter"] as const) {
	test(`stage cwd preserves ${override} override (#3551)`, async () => {
		const root = await mkdtemp(join(tmpdir(), "workflow-cwd-override-"));
		const expectedCwd = join(root, override);
		const stageOptions =
			override === "cwd"
				? { cwd: expectedCwd }
				: override === "sessionManager" || override === "sessionManagerWithAdapter"
					? { sessionManager: SessionManager.inMemory(expectedCwd) }
					: undefined;
		let created: StageSessionCreateOptions | undefined;
		const session = mockSession();
		session.prompt = async () => appendProseTurn(session.messages);
		const adapter: AgentSessionAdapter = {
			async create(options) {
				created = options;
				return session;
			},
		};
		if (override !== "sessionManager") setAgentSessionAdapterDefaultCwd(adapter, join(root, "adapter"));
		try {
			const result = await run(
				workflow({
					name: "override-cwd",
					description: "",
					inputs: {},
					outputs: {},
					run: async (ctx) => {
						await ctx.stage("worker", stageOptions).prompt("hello");
						return {};
					},
				}),
				{},
				{ cwd: root, defaultSessionDir: join(root, "sessions"), adapters: { agentSession: adapter } },
			);
			assert.equal(result.status, "completed", result.error);
			assert.equal(created?.cwd ?? created?.sessionManager?.getCwd(), expectedCwd);
			assert.equal(created?.sessionManager?.getCwd(), expectedCwd);
			if (stageOptions?.sessionManager) assert.equal(created?.sessionManager, stageOptions.sessionManager);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
}
