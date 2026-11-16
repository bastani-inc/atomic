/**
 * #5186: a supervising session that launches and finishes hundreds of subagents stays as fast and as small as one that
 * finished a few. The main session is a real `createAgentSession` with the bundled subagents and Intercom extensions; it
 * launches background children in batches through the `subagent` tool on a scripted model, as a supervisor does, and
 * each child reads a file twice and answers. Between 50 and 200 finished children, the heap a finished child leaves
 * behind, the timers it leaves pending and the work a new child's start takes must not grow with them.
 */
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
	getAgentDir,
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
/**
 * How much more work a new child's start may take with 200 finished children than with 50. A start's work is the CPU
 * time this process spends from its launch to its first model request, in units of a fixed reference computation timed
 * just before and after it: on a busy machine wall time measures the machine, and CPU time stretches too, on Windows
 * by up to 1.8× when other processes share a core, while the reference stretches with it. What remains is the work a
 * start does, which is what grows with every child the session launched. Its own conversation still grows with each
 * batch it launches, by about 1.2× here, so the bound allows twice the work: it catches a start that scales with the
 * children launched, as one did at 500 children before #5186 (6× the start time it had at 48).
 */
const START_WORK_GROWTH_FACTOR = 2;
/** Absorbs CPU accounting granularity, about 16 ms on Windows, and the noise of a few probes, in reference units. */
const START_WORK_SLACK = 1;
/** Records the reference computation sorts and serializes: about 50 ms of CPU on an idle farm machine. */
const REFERENCE_RECORDS = 40_000;
/** New children launched, one at a time, at each measurement; the median of their start work is compared. */
const PROBES = 5;
/** Collections whose least heap in use is taken as the heap a measurement holds. */
const HEAP_SAMPLES = 5;
const RESUME_MESSAGE = "RESUMED-5186";

interface Measurement {
	readonly heapBytes: number;
	readonly pendingTimers: number;
	/** The median work a new child's start took, from its launch to its first model request, in reference units. */
	readonly childStartWork: number;
	/** The median CPU time of the same starts and of the reference computation, reported but never asserted. */
	readonly childStartCpuMs: number;
	readonly referenceCpuMs: number;
	/** The median wall time of the same starts, reported but never asserted. */
	readonly childStartMs: number;
}

/** Each child's first model request: when it came and the CPU time this process had used by then. */
const childStarts = new Map<string, { readonly at: number; readonly cpuMs: number }>();
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
		if (!childStarts.has(task)) childStarts.set(task, { at: performance.now(), cpuMs: cpuMs() });
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
let lastLaunch = { at: 0, cpuMs: 0 };
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
		if (event.type === "tool_execution_start" && event.toolName === "subagent")
			lastLaunch = { at: performance.now(), cpuMs: cpuMs() };
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

/** The CPU time, user and system, this process has used so far. */
function cpuMs(): number {
	const { user, system } = process.cpuUsage();
	return (user + system) / 1_000;
}

function median(values: readonly number[]): number {
	return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
}

/** A fixed computation of the kind a start does, allocating, serializing and sorting records; its CPU time in ms. */
function referenceCpuMs(): number {
	const started = cpuMs();
	const records = Array.from({ length: REFERENCE_RECORDS }, (_, index) => ({
		id: `record-${(index * 7919) % REFERENCE_RECORDS}`,
		index,
		tags: [index % 3, index % 5, index % 7],
	}));
	const parsed = JSON.parse(JSON.stringify(records)) as typeof records;
	parsed.sort((a, b) => a.id.localeCompare(b.id));
	const byId = new Map(parsed.map((record) => [record.id, record]));
	if (byId.size === 0) throw new Error("the reference computation kept no record");
	return cpuMs() - started;
}

/**
 * The work and time a new child takes from its launch to its first model request, as medians of a few launches. Each
 * launch's CPU time is divided by the reference computation's, timed just before and just after it, so the load the
 * machine was under during that launch cancels out.
 */
async function childStart(): Promise<{
	readonly work: number;
	readonly cpuMs: number;
	readonly referenceMs: number;
	readonly ms: number;
}> {
	const work: number[] = [];
	const cpu: number[] = [];
	const reference: number[] = [];
	const wall: number[] = [];
	for (let probe = 0; probe < PROBES; probe++) {
		const task = String(launched);
		const before = referenceCpuMs();
		await launchAndFinish(1);
		const after = referenceCpuMs();
		const started = childStarts.get(task);
		const startCpu = started === undefined ? Number.NaN : started.cpuMs - lastLaunch.cpuMs;
		const unit = Math.max((before + after) / 2, 1);
		work.push(startCpu / unit);
		cpu.push(startCpu);
		reference.push(unit);
		wall.push(started === undefined ? Number.NaN : started.at - lastLaunch.at);
	}
	return { work: median(work), cpuMs: median(cpu), referenceMs: median(reference), ms: median(wall) };
}

/**
 * The heap in use once nothing is left to collect, as the least of a few collections apart: one collection can find
 * work still settling, a completion delivery or a compilation, that the next one does not.
 */
async function settledHeapBytes(): Promise<number> {
	const samples: number[] = [];
	for (let sample = 0; sample < HEAP_SAMPLES; sample++) {
		await new Promise((resolve) => setTimeout(resolve, 250));
		collectGarbage();
		collectGarbage();
		samples.push(process.memoryUsage().heapUsed);
	}
	return Math.min(...samples);
}

async function measure(): Promise<Measurement> {
	const start = await childStart();
	// Let the children's sessions finish closing and their completions reach the main session.
	await new Promise((resolve) => setTimeout(resolve, 1_500));
	return {
		heapBytes: await settledHeapBytes(),
		pendingTimers: v8.queryObjects(TimeoutClass, { format: "count" }) as number,
		childStartWork: start.work,
		childStartCpuMs: start.cpuMs,
		referenceCpuMs: start.referenceMs,
		childStartMs: start.ms,
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

	test("a finished child leaves no history, skill text or timer behind, and a new child's start does no more work with 200 finished than with 50 (#5186)", () => {
		const few = measured.get(FEW_FINISHED)!;
		const many = measured.get(MANY_FINISHED)!;
		const children = childFinished.size - FEW_FINISHED - PROBES;
		const retainedPerChild = (many.heapBytes - few.heapBytes) / children;
		const report = JSON.stringify({ few, many, children, retainedPerChild });
		assert.ok(retainedPerChild <= RETAINED_BYTES_PER_FINISHED_CHILD, `retained heap per finished child: ${report}`);
		assert.ok(many.pendingTimers - few.pendingTimers <= PENDING_TIMERS_GROWTH, `pending timers: ${report}`);
		assert.ok(
			many.childStartWork <= few.childStartWork * START_WORK_GROWTH_FACTOR + START_WORK_SLACK,
			`new child start work: ${report}`,
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

	test(
		"a finished child whose session file was deleted still shows its result, creates no file, and refuses resume clearly (#5186)",
		async () => {
			const second = launches.get("1");
			assert.ok(second, "the second child was launched");
			const agentDir = getAgentDir();
			const childFiles = () =>
				readdirSync(agentDir, { recursive: true, encoding: "utf8" }).filter(
					(name) =>
						name.includes("subagent-sessions") &&
						name.endsWith(".jsonl") &&
						readFileSync(join(agentDir, name), "utf8").includes('Do TASK-1"'),
				);
			const [file] = childFiles();
			assert.ok(file, "the child saved its session file");
			rmSync(join(agentDir, file));
			const sessionFiles = () =>
				readdirSync(agentDir, { recursive: true, encoding: "utf8" })
					.filter((name) => name.endsWith(".jsonl") && !name.includes("artifacts"))
					.sort();
			const before = sessionFiles();

			const store = getOwnerTaskStore(session);
			assert.ok(store, "the main session has a task store");
			const view = ownerTaskViewSource(store);
			const detail = await view.taskDetailText(second.taskId as never);
			assert.match(detail.prompt ?? "", /Do TASK-1/);
			assert.equal(detail.output, "done 1");
			const page = await view.readTaskTranscript(second.taskId as never);
			assert.ok(!page.ok, "the transcript says its history is gone");
			assert.match(page.error.message, /moved or deleted/);
			assert.deepEqual(sessionFiles(), before, "reading a deleted history creates no session file");

			const results: string[] = [];
			const unsubscribe = session.subscribe((event) => {
				if (event.type === "tool_execution_end" && event.toolName === "subagent")
					results.push(JSON.stringify(event.result));
			});
			try {
				await session.prompt(`RESUME ${second.childId}`, { streamingBehavior: "followUp" });
				await vi.waitFor(() => assert.equal(results.length, 1), { timeout: 60_000, interval: 20 });
			} finally {
				unsubscribe();
			}
			assert.match(results[0]!, /session file is missing/);
			assert.equal(resumedRequests.length, 1, "the child was not resumed without its history");
			assert.deepEqual(sessionFiles(), before, "a refused resume creates no session file");
		},
		ACCUMULATION_TIMEOUT_MS,
	);
});
