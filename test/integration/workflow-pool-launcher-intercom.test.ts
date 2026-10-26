/**
 * #4006: the session that launched a run steers the stages of its pooled children
 * (`workflows.localWorkers`) without joining `workflow:<rootRunId>`, while a session
 * that neither launched nor joined the run stays refused.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { registerPendingStageIntercomBridge } from "../../packages/workflows/src/extension/pending-stage-intercom.js";
import { run } from "../../packages/workflows/src/runs/foreground/sdk-run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { loadWorkerWorkflow } from "../../packages/workflows/src/workers/definitions.js";
import { IntercomBrokerFixture } from "../helpers/intercom-broker-fixture.js";
import { testRunId } from "../helpers/run-id.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";
import { untilOrRunEnds } from "../helpers/until-run.js";

const WORKER_INTERCOM_TIMEOUT_MS = 120_000;
const BROKER_STARTUP_TIMEOUT_MS = 60_000;
const CONDITION_TIMEOUT_MS = 60_000;

interface ToolResult {
	readonly content: ReadonlyArray<{ readonly type: string; readonly text: string }>;
	readonly details: { readonly queued?: boolean; readonly delivered?: boolean };
	readonly isError: boolean;
}

interface FixtureContext {
	readonly hasUI: false;
	readonly cwd: string;
	isIdle(): boolean;
	readonly model: { readonly id: string };
	readonly orchestrationContext: { readonly intercomGroup: string };
	readonly sessionManager: { getSessionId(): string; getBranch(): [] };
	readonly ui: { confirm(): Promise<boolean>; notify(): void };
}

type ToolParams = { readonly action: string; readonly message?: string; readonly to?: string };
type Execute = (
	toolCallId: string,
	params: ToolParams,
	signal: AbortSignal | undefined,
	onUpdate: undefined,
	ctx: FixtureContext,
) => Promise<ToolResult>;
type LifecycleHandler = (event: Record<string, string>, ctx: FixtureContext) => void | Promise<void>;
type EventHandler = (payload: object) => void;

/** A chat session in `default` with the real Intercom extension. */
function chatSession(sessionId: string, cwd: string) {
	const lifecycle = new Map<string, LifecycleHandler[]>();
	const events = new Map<string, EventHandler[]>();
	let execute: Execute | undefined;
	let activeTools: string[] = [];
	const context: FixtureContext = {
		hasUI: false,
		cwd,
		isIdle: () => true,
		model: { id: "test-model" },
		orchestrationContext: { intercomGroup: "default" },
		sessionManager: { getSessionId: () => sessionId, getBranch: () => [] },
		ui: { confirm: async () => true, notify() {} },
	};
	const pi = {
		on(name: string, handler: LifecycleHandler) {
			lifecycle.set(name, [...(lifecycle.get(name) ?? []), handler]);
		},
		registerTool(tool: { readonly name: string; readonly execute?: Execute }) {
			if (tool.name === "intercom") execute = tool.execute;
		},
		registerCommand() {},
		registerShortcut() {},
		registerMessageRenderer() {},
		async appendEntry() {},
		async sendMessage() {},
		async sendMessages() {},
		getSessionName: () => sessionId,
		setSessionName() {},
		getActiveTools: () => activeTools,
		setActiveTools(next: string[]) {
			activeTools = next;
		},
		events: {
			on(name: string, handler: EventHandler) {
				events.set(name, [...(events.get(name) ?? []), handler]);
				return () =>
					events.set(
						name,
						(events.get(name) ?? []).filter((candidate) => candidate !== handler),
					);
			},
			emit(name: string, payload: object) {
				for (const handler of events.get(name) ?? []) handler(payload);
			},
		},
	};
	const fire = async (name: string): Promise<void> => {
		for (const handler of lifecycle.get(name) ?? []) await handler({ type: name, reason: "startup" }, context);
	};
	return {
		pi,
		start: () => fire("session_start"),
		shutdown: () => fire("session_shutdown"),
		intercom(params: ToolParams): Promise<ToolResult> {
			assert.ok(execute);
			return execute("test-call", params, undefined, undefined, context);
		},
	};
}

function occurrences(text: string, marker: string): number {
	return text.split(marker).length - 1;
}

test.skipIf(process.platform === "win32")(
	"the launching session steers a pooled child's stage by exact path and pattern without joining (#4006)",
	async () => {
		const directory = makeTempDirectory("pool-launcher-intercom-");
		const broker = new IntercomBrokerFixture(join(directory, "agent"));
		broker.overrideAgentDir();
		const { default: intercom } = await import("../../packages/intercom/index.js");
		const { getJitiCliPath } = await import("../../packages/intercom/broker/spawn.js");
		const { getBrokerSocketPath } = await import("../../packages/intercom/broker/paths.js");
		const intercomPath = fileURLToPath(new URL("../../packages/intercom", import.meta.url));
		const path = join(directory, "journal.sqlite");
		const database = await openNodeSqliteDatabase(path);
		const journal = await SqlRunJournal.open(database);
		const backend = await JournalDurableBackend.open(journal, { ownsJournal: false });
		await database.exec("CREATE TABLE test_pool_gate(released INTEGER); INSERT INTO test_pool_gate VALUES (0)");
		const childPath = fileURLToPath(new URL("../fixtures/pool-intercom-child.ts", import.meta.url));
		const child = await loadWorkerWorkflow(childPath, "child");
		const store = createStore();
		const root = testRunId("pool-launcher");
		const group = `workflow:${root}`;
		const controller = new AbortController();
		const launcher = chatSession("pool-launcher-session", directory);
		const outsider = chatSession("pool-outsider-session", directory);
		let disposeBridge: (() => void) | undefined;
		let execution: ReturnType<typeof run> | undefined;
		try {
			broker.trackBroker(
				spawn(process.execPath, [getJitiCliPath(intercomPath), join(intercomPath, "broker/broker.ts")], {
					env: process.env,
					stdio: "ignore",
				}),
			);
			await broker.holdSession(getBrokerSocketPath(), BROKER_STARTUP_TIMEOUT_MS);
			// The launcher hosts the root run's route, as a chat session that starts a workflow does.
			intercom(launcher.pi as never);
			disposeBridge = registerPendingStageIntercomBridge(launcher.pi as never, store);
			intercom(outsider.pi as never);
			await launcher.start();
			await outsider.start();
			execution = run(
				workflow({
					name: "pool-launcher-root",
					description: "",
					inputs: {},
					outputs: {},
					async run(ctx) {
						await ctx.workflow(child, { inputs: { label: "pooled", journalPath: path } });
						return {};
					},
				}),
				{},
				{
					runId: root,
					cwd: directory,
					store,
					durableBackend: backend,
					signal: controller.signal,
					localWorkers: { count: 1, definitions: [{ path: childPath, exportName: "child" }] },
				},
			);
			const pooledStage = () => {
				const childRun = store.runs().find((entry) => entry.parentRunId === root);
				const stage = childRun?.stages.find((candidate) => candidate.name === "agent");
				return childRun === undefined || stage === undefined
					? undefined
					: { runId: childRun.id, stageId: stage.id };
			};
			// The launcher lists the pooled stage without having joined the invocation group; copy its listed target.
			let exactTarget: string | undefined;
			await untilOrRunEnds(
				async () => {
					const stage = pooledStage();
					if (stage === undefined) return false;
					const listed = (await launcher.intercom({ action: "list" })).content[0]?.text ?? "";
					exactTarget = listed.match(new RegExp(`\`(${group}/[^\`]*/${stage.stageId})\` \\[PENDING\\]`))?.[1];
					return exactTarget !== undefined;
				},
				execution,
				CONDITION_TIMEOUT_MS,
			);
			const target = pooledStage()!;
			assert.ok(exactTarget !== undefined);

			const refused = await outsider.intercom({ action: "send", to: `${group}/**`, message: "outsider-pattern" });
			assert.equal(refused.isError, true);
			assert.ok(refused.content[0]?.text.includes(`join ${group}`), refused.content[0]?.text);
			const refusedExact = await outsider.intercom({ action: "send", to: exactTarget, message: "outsider-exact" });
			assert.equal(refusedExact.isError, true);

			const exact = await launcher.intercom({ action: "send", to: exactTarget, message: "launcher-exact-marker" });
			assert.equal(exact.isError, false, exact.content[0]?.text);
			assert.equal(exact.details.queued, true);
			const pattern = await launcher.intercom({
				action: "send",
				to: `${group}/**`,
				message: "launcher-pattern-marker",
			});
			assert.equal(pattern.isError, false, pattern.content[0]?.text);
			assert.equal(pattern.details.queued, true);

			await database.run("UPDATE test_pool_gate SET released = 1");
			const outcome = await execution;
			assert.equal(outcome.status, "completed", JSON.stringify(outcome.error));
			// The fixture's stage replies with the context it received: each send arrived exactly once.
			const childRun = store.runs().find((entry) => entry.id === target.runId);
			const result = String(childRun?.stages.find((stage) => stage.id === target.stageId)?.result);
			assert.equal(occurrences(result, "launcher-exact-marker"), 1, result);
			assert.equal(occurrences(result, "launcher-pattern-marker"), 1, result);
			assert.equal(occurrences(result, "outsider-"), 0, result);
		} finally {
			controller.abort();
			await database.run("UPDATE test_pool_gate SET released = 1");
			await execution;
			disposeBridge?.();
			await outsider.shutdown();
			await launcher.shutdown();
			await backend.close();
			await journal.close();
			await database.close();
			await broker.cleanup();
			removeTempDirectory(directory);
		}
	},
	WORKER_INTERCOM_TIMEOUT_MS,
);
