/**
 * A workflow stage that launched subagents and completed must leave nothing behind that keeps its history, extensions
 * and tools alive. A workflow run through the SDK runs its stages one after another, each a real stage session with
 * the bundled subagents and Intercom extensions that launches two children in one `subagent` call; every stage's session
 * is released when it completes. Once the run ended, the garbage collector must be able to reclaim every one of them.
 */
import assert from "node:assert/strict";
import { afterAll, beforeAll, expect, test } from "vitest";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import { createAgentSessionAdapter, run, workflow } from "../../packages/workflows/src/sdk-surface.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { trackCollection } from "../helpers/collect-garbage.js";
import {
	assertEveryOneCollected,
	CHILDREN_PER_PARENT,
	createRetentionFixture,
	DELEGATE,
	ENDED_SESSIONS_TIMEOUT_MS,
	PARENTS,
	quietSettings,
	type RetentionFixture,
} from "../helpers/ended-session-retention.js";

let fixture: RetentionFixture | undefined;
const stages = trackCollection();
let status: string | undefined;
// Children a stage launched: one it stopped watching may still be running when the stage completes, and ends with it,
// so the stages are measured by what they launched rather than by what answered.
let childrenLaunched = 0;

function countLaunches(event: { type: string; toolName?: string; result?: unknown }): void {
	if (event.type !== "tool_execution_end" || event.toolName !== "subagent") return;
	const details = (event.result as { details?: { taskRecords?: readonly unknown[] } } | undefined)?.details;
	childrenLaunched += details?.taskRecords?.length ?? 0;
}

beforeAll(async () => {
	const current = await createRetentionFixture();
	fixture = current;
	const sdk = createAgentSessionAdapter({
		cwd: current.cwd,
		agentDir: current.agentDir,
		model: current.parentModel,
		modelRuntime: current.modelRuntime,
		settingsManager: quietSettings(),
		builtins: { mcp: false, "web-access": false },
	});
	const definition = workflow({
		name: "ended-stage-retention",
		description: "",
		inputs: {},
		outputs: {},
		async run(ctx) {
			for (let stage = 0; stage < PARENTS; stage++)
				await ctx.task(`stage-${stage}`, { prompt: `${DELEGATE} ${stage}` });
			return {};
		},
	});
	const result = await run(
		definition,
		{},
		{
			cwd: current.cwd,
			store: createStore(),
			journal: { memory: true },
			adapters: {
				sessionStore: new MemorySessionStore(),
				agentSession: {
					async create(...args: Parameters<typeof sdk.create>) {
						const created = await sdk.create(...args);
						const session = "session" in created ? created.session : created;
						stages.track(session);
						session.subscribe(countLaunches);
						return created;
					},
				},
			},
		},
	);
	status = result.status;
}, ENDED_SESSIONS_TIMEOUT_MS);

afterAll(() => fixture?.dispose());

test(
	"every completed stage's session can be collected once its run ended",
	async () => {
		assert.equal(status, "completed");
		assert.equal(stages.created, PARENTS, "every stage ran in its own session");
		expect(childrenLaunched, "every stage launched its children").toBe(PARENTS * CHILDREN_PER_PARENT);
		await assertEveryOneCollected(stages);
	},
	ENDED_SESSIONS_TIMEOUT_MS,
);
