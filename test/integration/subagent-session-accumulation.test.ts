/**
 * #5186: a supervising session that launches and finishes hundreds of subagents stays as fast and as small as one that
 * finished a few. The main session is a real `createAgentSession` with the bundled subagents and Intercom extensions; it
 * launches background children in batches through the `subagent` tool on a scripted model, as a supervisor does, and
 * each child reads a file twice and answers. Between 50 and 200 finished children, the heap a finished child leaves
 * behind, the timers it leaves pending and the time a new child takes to start must not grow with them.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import v8 from "node:v8";
import vm from "node:vm";
import {
	type FauxResponseFactory,
	fauxAssistantMessage,
	fauxToolCall,
	registerFauxProvider,
} from "@bastani/atomic-ai/compat";
import { afterAll, beforeAll, describe, test, vi } from "vitest";
import { InMemoryCodingAgentModelsStore } from "../../packages/coding-agent/src/core/models-store.js";
import { getOwnerTaskStore } from "../../packages/coding-agent/src/core/tasks/owner-store.js";
import { ownerTaskViewSource } from "../../packages/coding-agent/src/core/tasks/task-view-source.js";
import {
	type AgentSession,
	AuthStorage,
	createAgentSession,
	ModelRuntime,
	SettingsManager,
} from "../../packages/coding-agent/src/index.js";
import { clearSubagentControls } from "../../packages/subagents/src/runs/inprocess/control-registry.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

/** Structural cost: about 210 real child sessions, each reading a file twice, in one main session. */
const ACCUMULATION_TIMEOUT_MS = 600_000;
const PROVIDER = "faux-accumulation-5186";
const MAIN_MODEL = "main-5186";
const CHILD_MODEL = "child-5186";
/** Children running at once, as a supervisor keeps about a dozen. */
const BATCH = 12;
const FEW_FINISHED = 50;
const MANY_FINISHED = 200;
/** Each child reads this file twice: about 128 KiB of history a finished child kept in memory before the fix. */
const FILE_BYTES = 64 * 1024;
/**
 * The heap each finished child may still hold, measured from 50 to 200 finished: its task record and launch metadata.
 * Before the fix it kept its whole history and the text of every skill file it loaded, about 250 KiB here.
 */
const RETAINED_BYTES_PER_FINISHED_CHILD = 48 * 1024;
/** Timers the 150 children finished between the two measurements may leave pending; before the fix, one each. */
const PENDING_TIMERS_GROWTH = 16;
/** How much slower a new child may start with 200 finished children than with 50. */
const START_SLOWDOWN_FACTOR = 1.5;
const START_SLOWDOWN_SLACK_MS = 250;
const PROBES = 3;
const RESUME_MESSAGE = "RESUMED-5186";

interface Measurement {
	readonly heapBytes: number;
	readonly pendingTimers: number;
	readonly childStartMs: number;
}

const childStarts = new Map<string, number>();
const childFinished = new Set<string>();
const resumedRequests: string[] = [];
/** Each launched child's id, as resume names it, and task id, by its task number. */
const launches = new Map<string, { readonly childId: string; readonly taskId: string }>();

function taskNumber(text: string): string | undefined {
	return /TASK-(\d+)/.exec(text)?.[1];
}

const respond: FauxResponseFactory = (context, _options, _state, model) => {
	const messages = context.messages;
	if (model.id === CHILD_MODEL) {
		const text = JSON.stringify(messages);
		const task = taskNumber(JSON.stringify(messages.find((message) => message.role === "user")?.content ?? ""));
		if (task === undefined) return fauxAssistantMessage("no task");
		if (text.includes(RESUME_MESSAGE)) {
			resumedRequests.push(text);
			return fauxAssistantMessage(`resumed ${task}`);
		}
		if (!childStarts.has(task)) childStarts.set(task, performance.now());
		if (messages.filter((message) => message.role === "toolResult").length < 2)
			return fauxAssistantMessage([fauxToolCall("read", { path: "fixture.txt" })], { stopReason: "toolUse" });
		childFinished.add(task);
		return fauxAssistantMessage(`done ${task}`);
	}
	const last = messages.at(-1);
	const prompt = last?.role === "user" ? JSON.stringify(last.content) : "";
	const launch = /LAUNCH (\d+) FROM (\d+)/.exec(prompt);
	if (launch) {
		const [count, from] = [Number(launch[1]), Number(launch[2])];
		return fauxAssistantMessage(
			Array.from({ length: count }, (_, index) =>
				fauxToolCall("subagent", {
					agent: "worker-5186",
					task: `Do TASK-${from + index}`,
					wait: { kind: "background" },
				}),
			),
			{ stopReason: "toolUse" },
		);
	}
	const resume = /RESUME ([\w-]+:\d+)/.exec(prompt);
	if (resume)
		return fauxAssistantMessage(
			[
				fauxToolCall("subagent", {
					action: "resume",
					id: resume[1],
					message: RESUME_MESSAGE,
					wait: { kind: "background" },
				}),
			],
			{ stopReason: "toolUse" },
		);
	return fauxAssistantMessage("ok");
};

function collectGarbage(): void {
	v8.setFlagsFromString("--expose-gc");
	try {
		(vm.runInNewContext("gc") as () => void)();
	} finally {
		v8.setFlagsFromString("--no-expose-gc");
	}
}

const TimeoutClass = setTimeout(() => {}, 0).constructor as new (...args: never[]) => object;

let cwd: string;
let session: AgentSession;
let unregister: () => void;
let launched = 0;
let lastLaunchAt = 0;
const measured = new Map<number, Measurement>();

async function supervisor(): Promise<AgentSession> {
	const faux = registerFauxProvider({ provider: PROVIDER, models: [{ id: MAIN_MODEL }, { id: CHILD_MODEL }] });
	unregister = () => faux.unregister();
	faux.setResponses(Array.from({ length: 20_000 }, () => respond));
	const authStorage = AuthStorage.inMemory();
	await authStorage.modify(PROVIDER, async () => ({ type: "api_key", key: "faux-key" }));
	const modelRuntime = await ModelRuntime.create({
		credentials: authStorage,
		modelsPath: null,
		modelsStore: new InMemoryCodingAgentModelsStore(),
	});
	modelRuntime.registerProvider(PROVIDER, {
		baseUrl: faux.getModel().baseUrl,
		apiKey: "faux-key",
		api: faux.api,
		models: faux.models.map((registered) => ({
			id: registered.id,
			name: registered.name,
			api: registered.api,
			reasoning: registered.reasoning,
			input: registered.input,
			contextWindow: registered.contextWindow,
			maxTokens: registered.maxTokens,
			cost: registered.cost,
		})),
	});
	const { session } = await createAgentSession({
		cwd,
		modelRuntime,
		model: faux.getModel(MAIN_MODEL),
		settingsManager: SettingsManager.inMemory({
			compaction: { enabled: false },
			retry: { enabled: false },
			sessionSummary: { enabled: false },
		}),
		builtins: { mcp: false, "web-access": false },
	});
	session.subscribe((event) => {
		if (event.type === "tool_execution_start" && event.toolName === "subagent") lastLaunchAt = performance.now();
		if (event.type !== "tool_execution_end" || event.toolName !== "subagent") return;
		const details = (event.result as { details?: { taskRecords?: Array<Record<string, unknown>> } }).details;
		for (const record of details?.taskRecords ?? []) {
			const task = taskNumber(String(record.title));
			const ref = record.ref as { taskId: string };
			if (task !== undefined && !launches.has(task))
				launches.set(task, { childId: String(record.launchOperationId), taskId: ref.taskId });
		}
	});
	return session;
}

/** Launch `count` background children at once and wait until each has answered. */
async function launchAndFinish(count: number): Promise<void> {
	const from = launched;
	launched += count;
	await session.prompt(`LAUNCH ${count} FROM ${from}`, { streamingBehavior: "followUp" });
	await vi.waitFor(
		() => {
			for (let task = from; task < from + count; task++) assert.ok(childFinished.has(String(task)));
		},
		{ timeout: 120_000, interval: 20 },
	);
}

/** How long a new child takes from its launch to its first model request, as the median of a few launches. */
async function childStartMs(): Promise<number> {
	const starts: number[] = [];
	for (let probe = 0; probe < PROBES; probe++) {
		const task = String(launched);
		await launchAndFinish(1);
		starts.push((childStarts.get(task) ?? Number.NaN) - lastLaunchAt);
	}
	return starts.sort((a, b) => a - b)[Math.floor(PROBES / 2)]!;
}

async function measure(): Promise<Measurement> {
	const start = await childStartMs();
	// Let the children's sessions finish closing and their completions reach the main session.
	await new Promise((resolve) => setTimeout(resolve, 1_500));
	collectGarbage();
	collectGarbage();
	return {
		heapBytes: process.memoryUsage().heapUsed,
		pendingTimers: v8.queryObjects(TimeoutClass, { format: "count" }) as number,
		childStartMs: start,
	};
}

describe("a long supervising session as its children accumulate (#5186)", () => {
	beforeAll(async () => {
		vi.stubEnv("NODE_ENV", "production");
		// The scripted provider would otherwise keep every child's last prompt as its simulated prompt cache.
		vi.stubEnv("PI_CACHE_RETENTION", "none");
		cwd = makeTempDirectory("atomic-accumulation-5186-");
		mkdirSync(join(cwd, ".atomic", "agents"), { recursive: true });
		writeFileSync(join(cwd, "fixture.txt"), "x".repeat(FILE_BYTES));
		writeFileSync(
			join(cwd, ".atomic", "agents", "worker-5186.md"),
			`---\nname: worker-5186\ndescription: Reads a fixture and answers\ntools: read\nmodel: ${PROVIDER}/${CHILD_MODEL}\n---\n\nRead the fixture, then answer.\n`,
		);
		session = await supervisor();
		while (childFinished.size < FEW_FINISHED) await launchAndFinish(BATCH);
		measured.set(FEW_FINISHED, await measure());
		while (childFinished.size < MANY_FINISHED) await launchAndFinish(BATCH);
		measured.set(MANY_FINISHED, await measure());
	}, ACCUMULATION_TIMEOUT_MS);

	afterAll(async () => {
		await session?.dispose();
		unregister?.();
		clearSubagentControls();
		vi.unstubAllEnvs();
		if (cwd) removeTempDirectory(cwd);
	});

	test("a finished child leaves no history, skill text or timer behind, and a new child starts as fast with 200 finished as with 50 (#5186)", () => {
		const few = measured.get(FEW_FINISHED)!;
		const many = measured.get(MANY_FINISHED)!;
		const children = childFinished.size - FEW_FINISHED - PROBES;
		const retainedPerChild = (many.heapBytes - few.heapBytes) / children;
		const report = JSON.stringify({ few, many, children, retainedPerChild });
		assert.ok(retainedPerChild <= RETAINED_BYTES_PER_FINISHED_CHILD, `retained heap per finished child: ${report}`);
		assert.ok(many.pendingTimers - few.pendingTimers <= PENDING_TIMERS_GROWTH, `pending timers: ${report}`);
		assert.ok(
			many.childStartMs <= few.childStartMs * START_SLOWDOWN_FACTOR + START_SLOWDOWN_SLACK_MS,
			`new child start: ${report}`,
		);
	});

	test("a finished child's /tasks detail and transcript are read back from its session store (#5186)", async () => {
		const first = launches.get("0");
		assert.ok(first, "the first child was launched");
		const store = getOwnerTaskStore(session);
		assert.ok(store, "the main session has a task store");
		const view = ownerTaskViewSource(store);
		const detail = await view.taskDetailText(first.taskId as never);
		assert.match(detail.prompt ?? "", /Do TASK-0/);
		assert.equal(detail.output, "done 0");
		const page = await view.readTaskTranscript(first.taskId as never);
		assert.ok(page.ok, "the finished child's transcript is readable");
		assert.deepEqual(
			page.value.messages.map((message) => message.role),
			["user", "assistant", "toolResult", "assistant", "toolResult", "assistant"],
		);
	});

	test(
		"a finished child resumes with its whole history after its memory was released (#5186)",
		async () => {
			const first = launches.get("0");
			assert.ok(first, "the first child was launched");
			await session.prompt(`RESUME ${first.childId}`, { streamingBehavior: "followUp" });
			await vi.waitFor(() => assert.equal(resumedRequests.length, 1), { timeout: 120_000, interval: 20 });
			const request = resumedRequests[0]!;
			assert.ok(request.includes("Do TASK-0"), "the resumed child still has its task");
			assert.ok(request.includes("done 0"), "the resumed child still has its answer");
		},
		ACCUMULATION_TIMEOUT_MS,
	);
});
