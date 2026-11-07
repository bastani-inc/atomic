/**
 * #4488 fixture: the owner of one background subagent in a process of its own, so a test can SIGKILL it. It is the
 * product's owner side wired as the subagents extension wires it: the real Intercom extension on the owner's event
 * bus, a task host, released-child wakes, and on `recover` the hold and restore a reopened session's recovery runs.
 * The child is a real session on a scripted model: it starts a shell task in the background and waits on it, so it is
 * released, and a woken child waits on it again. Its release delay is short, so one test can wake it many times.
 *
 * Usage: <jiti> released-subagent-owner.ts <launch|recover> <dir> <child-name>
 * Prints `READY <group>` once it is bound, with the Intercom group the child is launched in; `RUN start|end <n>` around
 * each run of the child; `RECORD <json>` when the child's record changes; `RECEIVED <json>` when the Intercom messages
 * its session holds change; `READ <json>` when the messages it read from cards a delivery saved while it was busy
 * change; and, on `recover`, `RESTORED <json>` with how each interrupted child was restored.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@bastani/atomic";
import {
	fauxAssistantMessage,
	fauxToolCall,
	registerFauxProvider,
	type ToolResultMessage,
} from "@bastani/pi-ai/compat";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.js";
import { ModelRuntime } from "../../packages/coding-agent/src/core/model-runtime.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { AgentTaskHost } from "../../packages/coding-agent/src/core/tasks/agent-adapter.js";
import { createChildCommandTaskOwner } from "../../packages/coding-agent/src/core/tasks/child-command-owner.js";
import intercomLightweight from "../../packages/intercom/index.js";
import { projectHomeGroup } from "../../packages/intercom/project-group.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agents.js";
import { requestSupervisorAuthorization } from "../../packages/subagents/src/intercom/supervisor-authorization.js";
import { runSync } from "../../packages/subagents/src/runs/foreground/execution.js";
import { bindReleasedChildWakes } from "../../packages/subagents/src/runs/foreground/released-child-wakes.js";
import { holdRunningSubagentChildren } from "../../packages/subagents/src/runs/foreground/subagent-child-hold.js";
import {
	createSubagentChildRecordSink,
	readSubagentChildRecords,
} from "../../packages/subagents/src/runs/foreground/subagent-child-records.js";
import {
	restoreSubagentChildren,
	type SubagentChildRestoreDeps,
} from "../../packages/subagents/src/runs/foreground/subagent-child-restore.js";
import { reopenChildSession } from "../../packages/subagents/src/runs/foreground/subagent-child-session.js";
import { runAgentTask } from "../../packages/subagents/src/runs/foreground/task-execution.js";
import type { RunSyncOptions, SingleResult } from "../../packages/subagents/src/shared/types.js";

const [phase, dir, childName] = process.argv.slice(2);
if ((phase !== "launch" && phase !== "recover") || !dir || !childName)
	throw new Error("usage: released-subagent-owner <launch|recover> <dir> <child-name>");

// The process lives until the test kills it, also while nothing but unref'd retry timers is pending.
setInterval(() => {}, 60_000);

/** Short, so a test can release and wake the child many times; the product's default is a minute. */
const RELEASE_AFTER_MS = 5_000;
const STATUS_POLL_MS = 100;
const RUN_ID = "rerelease";
const SHELL_TOOL = process.platform === "win32" ? "powershell" : "bash";
/** Reads its standard input, so it runs until its owner's process is gone and its pipe closes. */
const SHELL_COMMAND = process.platform === "win32" ? "$v = [Console]::ReadLine()" : "read v";
const cwd = join(dir, "project");
mkdirSync(cwd, { recursive: true });
const agentDir = process.env.ATOMIC_CODING_AGENT_DIR;
if (!agentDir) throw new Error("ATOMIC_CODING_AGENT_DIR names the node whose broker the owner uses");
/** The group the owner's Intercom joins, as the subagent tool launches its children in. */
const group = projectHomeGroup(cwd, agentDir, process.env, process.env) ?? "default";

const worker: AgentConfig = {
	name: "worker",
	description: "waits on its build and reads its messages",
	source: "project",
	filePath: join(cwd, "worker.md"),
	systemPrompt: "Wait for your build, and read every message that arrives.",
	systemPromptMode: "replace",
	inheritProjectContext: false,
	inheritSkills: false,
};

type Observation = { readonly kind?: string; readonly taskId?: string };

/** The child starts its build in the background and waits on it; it starts a new one when the last is gone. */
function respond(context: { readonly messages: readonly { readonly role: string }[] }) {
	const shells = context.messages.filter(
		(message): message is ToolResultMessage<{ observation?: Observation }> =>
			message.role === "toolResult" && (message as ToolResultMessage).toolName === SHELL_TOOL,
	);
	const latest = shells.at(-1);
	const taskId = shells.findLast((message) => message.details?.observation?.kind === "yielded")?.details?.observation
		?.taskId;
	const observation = latest?.details?.observation;
	const finished =
		taskId === undefined || latest?.isError === true || (observation !== undefined && observation.kind !== "yielded");
	if (finished)
		return fauxAssistantMessage(
			[fauxToolCall(SHELL_TOOL, { command: SHELL_COMMAND, wait: { kind: "background" }, timeout: 3_600 })],
			{ stopReason: "toolUse" },
		);
	return fauxAssistantMessage([fauxToolCall(SHELL_TOOL, { action: "wait", id: taskId })], { stopReason: "toolUse" });
}

const faux = registerFauxProvider();
const model = faux.getModel();
const authStorage = AuthStorage.inMemory();
await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "faux-key" }));
const modelRuntime = await ModelRuntime.create({ credentials: authStorage, modelsPath: join(dir, "models.json") });
modelRuntime.registerProvider(model.provider, {
	baseUrl: model.baseUrl,
	api: model.api,
	models: faux.models.map((registered) => ({
		id: registered.id,
		name: registered.name,
		api: registered.api,
		reasoning: registered.reasoning,
		input: registered.input,
		cost: registered.cost,
		contextWindow: registered.contextWindow,
		maxTokens: registered.maxTokens,
		baseUrl: registered.baseUrl,
	})),
});
const topUp = () => {
	if (faux.getPendingResponseCount() < 100) faux.appendResponses(Array.from({ length: 200 }, () => respond));
};
topUp();

const store = await SqlSessionStore.open(await openNodeSqliteDatabase(join(dir, "owner.sqlite")));
const ownerFile = join(dir, "owner.json");
const sessionManager = existsSync(ownerFile)
	? await SessionManager.open(store, (JSON.parse(readFileSync(ownerFile, "utf8")) as { sessionId: string }).sessionId)
	: await SessionManager.create(store, cwd);
writeFileSync(ownerFile, JSON.stringify({ sessionId: sessionManager.getSessionId() }));

type Handler = (event: object, ctx: object) => unknown;
type EventHandler = (payload: unknown) => void;
const busHandlers = new Map<string, EventHandler[]>();
const events = {
	on(eventName: string, handler: EventHandler) {
		busHandlers.set(eventName, [...(busHandlers.get(eventName) ?? []), handler]);
		return () => busHandlers.set(eventName, (busHandlers.get(eventName) ?? []).filter((other) => other !== handler));
	},
	emit(eventName: string, payload: unknown) {
		for (const handler of busHandlers.get(eventName) ?? []) handler(payload);
	},
};
const appendEntry = async (customType: string, data?: unknown) => {
	await sessionManager.appendCustomEntry(customType, data);
};
let ownerIntercomId: string | undefined;
events.on("intercom:connected", (payload) => {
	ownerIntercomId = (payload as { readonly sessionId: string }).sessionId;
});
const handlers = new Map<string, Handler[]>();
let activeTools: string[] = [];
intercomLightweight({
	on(eventName: string, handler: Handler) {
		handlers.set(eventName, [...(handlers.get(eventName) ?? []), handler]);
	},
	registerTool() {},
	registerCommand() {},
	registerShortcut() {},
	registerMessageRenderer() {},
	appendEntry,
	async sendMessage() {},
	async sendMessages() {},
	getSessionName: () => "released-owner",
	setSessionName() {},
	getActiveTools: () => activeTools,
	setActiveTools(next: string[]) {
		activeTools = next;
	},
	events,
} as never);

const host = new AgentTaskHost({
	scope: { kind: "session", sessionId: sessionManager.getSessionId() },
	authorizeLaunch() {},
});
const parentCommandTaskOwner = createChildCommandTaskOwner(() => host);
const getChildSessionOptions: NonNullable<RunSyncOptions["getChildSessionOptions"]> = (base) => ({
	...base,
	model,
	modelRuntime,
	parentCommandTaskOwner,
	builtins: { workflows: false, subagents: false, mcp: false, "web-access": false },
});
const ctx = {
	hasUI: false,
	cwd,
	isIdle: () => true,
	model: undefined,
	thinkingLevel: undefined,
	sessionManager,
	getAgentTaskHost: () => host,
	getChildSessionOptions,
	modelRegistry: { getAvailable: () => [], getAll: () => [], find: () => undefined },
	ui: { confirm: async () => true, notify() {} },
} as unknown as ExtensionContext;
for (const handler of handlers.get("session_start") ?? [])
	await handler({ type: "session_start", reason: phase === "launch" ? "startup" : "resume" }, ctx);

let runs = 0;
const runtime = {
	runSync: async (...args: Parameters<typeof runSync>): Promise<SingleResult> => {
		const [parentCwd, agents, agentName, task, options] = args;
		const run = ++runs;
		process.stdout.write(`RUN start ${run}\n`);
		try {
			return await runSync(parentCwd, agents, agentName, task, {
				...options,
				// A real session: the test runner's NODE_ENV would make every child a scripted test session.
				testSession: false,
				releaseWhenWaiting: { afterMs: RELEASE_AFTER_MS },
			});
		} finally {
			process.stdout.write(`RUN end ${run}\n`);
		}
	},
};
const deps: SubagentChildRestoreDeps = {
	pi: { events, appendEntry, getSessionName: () => "released-owner" } as never,
	config: {},
	discoverAgents: () => ({ agents: [worker] }),
	runtime,
};
bindReleasedChildWakes(deps, ctx, events);
process.stdout.write(`READY ${group}\n`);

if (phase === "launch") {
	const supervisorAuthorization = await requestSupervisorAuthorization(events, childName);
	if (ownerIntercomId === undefined) throw new Error("the owner's Intercom never connected");
	const response = await runAgentTask({
		host,
		cwd,
		agents: [worker],
		agent: worker.name,
		task: "Start your build and wait for it; read every message that arrives.",
		options: {
			cwd,
			runId: RUN_ID,
			index: 0,
			sessionDir: join(dir, "children"),
			intercomSessionName: childName,
			intercomGroup: group,
			intercomEvents: events,
			// The child registers with the broker under its name, reporting to this owner, as a launched child does.
			orchestratorIntercomTarget: ownerIntercomId,
			getChildSessionOptions,
			...(supervisorAuthorization ? { supervisorAuthorization } : {}),
		},
		wait: { kind: "background" },
		recordChild: createSubagentChildRecordSink({ appendEntry }, ctx),
		runtime,
	});
	if (response.kind !== "admitted") throw new Error(`the child was not admitted: ${JSON.stringify(response)}`);
} else {
	// What a reopened session does: hold its interrupted children's sends at once, then restore them in its recovery.
	void holdRunningSubagentChildren(events, ctx);
	const outcomes = await restoreSubagentChildren(deps, ctx);
	process.stdout.write(`RESTORED ${JSON.stringify(outcomes.map((outcome) => outcome.kind))}\n`);
}

let lastRecord = "";
let lastReceived = "";
let lastRead = "";
for (;;) {
	topUp();
	const record = readSubagentChildRecords(sessionManager.getEntries()).get(`${RUN_ID}:0`);
	if (record !== undefined) {
		const shown = JSON.stringify({
			state: record.state,
			terminalStatus: record.terminalStatus ?? null,
			taskId: record.taskId ?? null,
			childSessionFile: record.childSessionFile ?? null,
		});
		if (shown !== lastRecord) {
			lastRecord = shown;
			process.stdout.write(`RECORD ${shown}\n`);
		}
		const reopened = await reopenChildSession({ sessionManager }, record);
		if ("sessionManager" in reopened) {
			const received = JSON.stringify(
				reopened.sessionManager.getEntries().flatMap((entry) => {
					const message = (entry as { details?: { message?: { id?: unknown } } }).details?.message;
					return entry.type === "custom_message" &&
						entry.customType === "intercom_message" &&
						typeof message?.id === "string"
						? [message.id]
						: [];
				}),
			);
			if (received !== lastReceived) {
				lastReceived = received;
				process.stdout.write(`RECEIVED ${received}\n`);
			}
			// The model-facing turn of each card a delivery saved while the child was busy, once per reading.
			const entries = reopened.sessionManager.getEntries();
			const messageIdOf = new Map(
				entries.flatMap((entry) => {
					const message = (entry as { details?: { message?: { id?: unknown } } }).details?.message;
					return entry.type === "custom_message" && typeof message?.id === "string" ? [[entry.id, message.id]] : [];
				}),
			);
			const read = JSON.stringify(
				entries.flatMap((entry) => {
					const of = (entry as { details?: { protectedReconciliationOf?: unknown } }).details?.protectedReconciliationOf;
					return entry.type === "custom_message" && typeof of === "string" && messageIdOf.has(of)
						? [messageIdOf.get(of)]
						: [];
				}),
			);
			if (read !== lastRead) {
				lastRead = read;
				process.stdout.write(`READ ${read}\n`);
			}
		}
	}
	await new Promise((resolve) => setTimeout(resolve, STATUS_POLL_MS));
}
