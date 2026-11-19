#!/usr/bin/env node
/**
 * Long-session memory soak: what one long-running main session keeps of the work it has finished.
 *
 * One main session (a real `createAgentSession` with the bundled subagents and Intercom extensions, over a
 * scripted model, with sessions and the run journal in SQLite as by default) starts from a long history and runs
 * `--rounds` rounds. Each round:
 *   - reads a slice of a large file, so the main context keeps growing;
 *   - starts a background shell with a heartbeat, whose completion notice arrives as a later turn;
 *   - launches `--forks` subagents in parallel with `context: "fork"` (each branches the whole main session);
 *   - launches one fresh subagent in the background, pauses it, resumes it with a message, and every other round
 *     quits and resumes it again;
 *   - lets every child report to the main session over Intercom (`contact_supervisor`);
 *   - reads and searches `history://` over a store seeded with `--history-sessions` other sessions;
 *   - starts on a model that fails, so model fallback moves it to the next model (children fall back too).
 *
 * Every `--sample-every` rounds the session waits until nothing runs, collects garbage, and samples heap and RSS, how
 * many `AgentSession` and `SessionManager` objects are still alive, and (with `--snapshot-dir`) writes a heap
 * snapshot. The report fits the heap retained per round between the first and the last sample.
 *
 * It runs on the built package, under Node (`--expose-gc`) or Bun: `npm run build` first.
 *
 *   node --expose-gc scripts/perf/long-session-memory-soak/benchmark.mjs --rounds 30 --label after --out after.json
 *   bun scripts/perf/long-session-memory-soak/benchmark.mjs --rounds 30
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
	options: {
		rounds: { type: "string", default: "30" },
		"sample-every": { type: "string", default: "5" },
		forks: { type: "string", default: "3" },
		"seed-entries": { type: "string", default: "4000" },
		"history-sessions": { type: "string", default: "40" },

		patterns: { type: "string", default: "read,shell,fork,background,intercom,history,fallback" },
		"snapshot-dir": { type: "string" },
		label: { type: "string", default: "soak" },
		out: { type: "string" },
		verbose: { type: "boolean", default: false },
	},
	strict: true,
});
const ROUNDS = Number(values.rounds);
const SAMPLE_EVERY = Number(values["sample-every"]);
const FORKS = Number(values.forks);
const SEED_ENTRIES = Number(values["seed-entries"]);
const HISTORY_SESSIONS = Number(values["history-sessions"]);

const PATTERNS = new Set(values.patterns.split(",").map((pattern) => pattern.trim()));
const VERBOSE = values.verbose;
const IS_BUN = typeof globalThis.Bun !== "undefined";
const FILE_LINES = 4_000;
const WORKER_PROMPT = "SOAK-WORKER: read the file, report progress, then answer.";
const ANSWER_BYTES = 4_096;
const PROVIDER = "faux-long-session-soak";
const MAIN_MODEL = "main-soak";
const FLAKY_MODEL = "flaky-soak";
const QUIET_MS = 1_500;

const collect = IS_BUN ? () => globalThis.Bun.gc(true) : globalThis.gc;
if (typeof collect !== "function") throw new Error("run with node --expose-gc, or with bun");

const root = mkdtempSync(join(tmpdir(), "atomic-long-session-soak-"));
const cwd = join(root, "project");
const agentDir = join(root, "agent");
mkdirSync(join(cwd, ".atomic", "agents"), { recursive: true });

mkdirSync(agentDir, { recursive: true });
process.env.ATOMIC_CODING_AGENT_DIR = agentDir;
process.env.ATOMIC_OFFLINE = "1";
process.env.ATOMIC_TELEMETRY_DISABLED = "1";
// The scripted provider would otherwise keep every session's last prompt as its simulated prompt cache.
process.env.PI_CACHE_RETENTION = "none";
writeFileSync(
	join(cwd, "big.ts"),
	Array.from(
		{ length: FILE_LINES },
		(_, line) => `export const value${line} = ${line} * 7919; // ${"x".repeat(48)} marker${line % 97}`,
	).join("\n"),
);
const settings = {
	compaction: { enabled: false },
	retry: { enabled: false },
	sessionSummary: { enabled: false },
	fallbackModels: [`${PROVIDER}/${MAIN_MODEL}`],
};
writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings, null, 2));
const childModel = PATTERNS.has("fallback") ? FLAKY_MODEL : MAIN_MODEL;
writeFileSync(
	join(cwd, ".atomic", "agents", "soak-worker.md"),
	`---\nname: soak-worker\ndescription: Reads, reports to its supervisor and answers\ntools: read, bash, intercom, contact_supervisor\nmodel: ${PROVIDER}/${childModel}\nfallbackModels: ${PROVIDER}/${MAIN_MODEL}\n---\n\n${WORKER_PROMPT}\n`,
);
const atomic = await import("@bastani/atomic");
const { AuthStorage, createAgentSession, ModelRuntime, SessionManager, SettingsManager, resolveSessionStore } = atomic;
const { fauxAssistantMessage, fauxToolCall, registerFauxProvider } = await import("@bastani/atomic-ai/compat");
const { getCurrentSystemPrompt } = await import("@bastani/atomic-ai");

const answer = (seed) => `${seed} `.repeat(Math.ceil(ANSWER_BYTES / (seed.length + 1))).slice(0, ANSWER_BYTES);
const textOf = (message) =>
	typeof message.content === "string"
		? message.content
		: Array.isArray(message.content)
			? message.content.map((block) => (block.type === "text" ? block.text : "")).join("\n")
			: "";

/**
 * Who is asking and for which step: a child by its agent's system prompt, else the main
 * session by its latest round prompt. Task notices quote a child's task, so markers count only where they are the
 * whole start of a prompt (a forked child's task is wrapped, so it is found by its marker anywhere after the fork).
 */
function latestMarker(messages) {
	const child = getCurrentSystemPrompt(messages)?.includes(WORKER_PROMPT);
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== "user") continue;
		const text = textOf(message);
		const match = child
			? /SOAK-CHILD r=(\d+) i=(\d+)( SLOW)?/.exec(text)
			: /^(ROUND) r=(\d+)(?: i=(\d+))?/.exec(text);
		if (!match) continue;
		if (child)
			return { kind: "SOAK-CHILD", round: Number(match[1]), index: Number(match[2]), slow: !!match[3], at: index };
		return { kind: match[1], round: Number(match[2]), index: Number(match[3] ?? 0), slow: false, at: index };
	}
	return undefined;
}

let flakyFailures = 0;
let lastBackgroundChild;
const stats = { notices: 0, childAnswers: 0, mainRounds: 0, toolErrors: 0 };
const errorSamples = [];

function mainSteps(round) {
	const steps = [];
	if (PATTERNS.has("read"))
		steps.push(() => fauxToolCall("read", { path: `big.ts:${1 + ((round * 397) % (FILE_LINES - 700))}+450` }));
	if (PATTERNS.has("shell"))
		steps.push(() =>
			fauxToolCall("bash", {
				command: `sleep ${round % 10 === 1 ? 62 : 1}; seq ${round} ${round + 3000}`,
				wait: { kind: "background" },
				heartbeatMs: 60_000,
			}),
		);
	if (PATTERNS.has("fork") && FORKS > 0)
		steps.push(() =>
			fauxToolCall("subagent", {
				tasks: Array.from({ length: FORKS }, (_, index) => ({
					agent: "soak-worker",
					task: `SOAK-CHILD r=${round} i=${index}`,
				})),
				context: "fork",
				wait: { kind: "foreground" },
			}),
		);
	if (PATTERNS.has("background")) {
		steps.push(() =>
			fauxToolCall("subagent", {
				agent: "soak-worker",
				task: `SOAK-CHILD r=${round} i=99 SLOW`,
				wait: { kind: "background" },
			}),
		);
		steps.push((results) => fauxToolCall("subagent", { action: "pause", id: backgroundChildId(results) }));
		steps.push((results) =>
			fauxToolCall("subagent", {
				action: "resume",
				id: backgroundChildId(results),
				message: `continue round ${round}`,
			}),
		);
		if (round % 2 === 0) {
			steps.push((results) => fauxToolCall("subagent", { action: "quit", id: backgroundChildId(results) }));
			steps.push((results) => fauxToolCall("subagent", { action: "resume", id: backgroundChildId(results) }));
		}
	}
	if (PATTERNS.has("history")) {
		steps.push(() => fauxToolCall("read", { path: "history://sessions" }));
		steps.push(() => fauxToolCall("search", { pattern: `seeded topic ${round % 13}`, paths: "history://" }));
	}
	return steps;
}

function backgroundChildId(results) {
	for (let index = results.length - 1; index >= 0; index--) {
		const result = results[index];
		if (result.toolName !== "subagent") continue;
		const match = /"intercomTarget":"([^"]+)"/.exec(textOf(result));
		if (match) {
			lastBackgroundChild = match[1];
			return lastBackgroundChild;
		}
	}
	return lastBackgroundChild ?? "missing";
}

function respond(context, _options, _state, model) {
	const messages = context.messages;
	if (model.id === FLAKY_MODEL) {
		flakyFailures += 1;
		return fauxAssistantMessage("", {
			stopReason: "error",
			errorMessage: "429 Too Many Requests: rate limit exceeded",
		});
	}
	const marker = latestMarker(messages);
	if (!marker) return fauxAssistantMessage(`ack ${answer("notice").slice(0, 200)}`);
	const after = messages.slice(marker.at + 1);
	const results = after.filter((message) => message.role === "toolResult");
	for (const result of results) {
		if (!result.isError) continue;
		const sample = `${result.toolName}: ${textOf(result).slice(0, 300)}`;
		if (!errorSamples.includes(sample)) {
			stats.toolErrors += 1;
			if (errorSamples.length < 20) errorSamples.push(sample);
		}
	}
	if (marker.kind === "SOAK-CHILD") {
		const steps = [() => fauxToolCall("read", { path: `big.ts:${1 + marker.index * 100}+400` })];
		if (PATTERNS.has("intercom"))
			steps.push(() =>
				fauxToolCall("contact_supervisor", {
					reason: "progress_update",
					message: `UPDATE: child ${marker.round}/${marker.index} read its slice`,
				}),
			);
		if (marker.slow) steps.push(() => fauxToolCall("bash", { command: "sleep 8; echo slow done" }));
		const step = steps[results.length];
		if (step) return fauxAssistantMessage([step(results)], { stopReason: "toolUse" });
		stats.childAnswers += 1;
		return fauxAssistantMessage(answer("child"));
	}
	const steps = mainSteps(marker.round);
	const step = steps[results.length];
	if (step) return fauxAssistantMessage([step(results)], { stopReason: "toolUse" });
	if (results.length === steps.length && after.at(-1)?.role === "toolResult") {
		stats.mainRounds += 1;
		return fauxAssistantMessage(answer("main"));
	}
	stats.notices += 1;
	return fauxAssistantMessage(`ack ${answer("notice").slice(0, 200)}`);
}

const faux = registerFauxProvider({ provider: PROVIDER, models: [{ id: MAIN_MODEL }, { id: FLAKY_MODEL }] });
faux.setResponses(Array.from({ length: 1_000_000 }, () => respond));
const authStorage = AuthStorage.inMemory();
await authStorage.modify(PROVIDER, async () => ({ type: "api_key", key: "faux-key" }));
const modelRuntime = await ModelRuntime.create({ credentials: authStorage, modelsPath: null });
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
		contextWindow: 2_000_000,
		maxTokens: registered.maxTokens,
		cost: registered.cost,
	})),
});

const store = await resolveSessionStore(cwd, { agentDir, settings });
const filler = (seed, bytes) => `${seed} `.repeat(Math.ceil(bytes / (seed.length + 1))).slice(0, bytes);

/** Other sessions of the project, for history to list and search. */
async function seedHistory() {
	for (let session = 0; session < HISTORY_SESSIONS; session++) {
		const manager = await SessionManager.create(store, cwd);
		for (let turn = 0; turn < 40; turn++) {
			await manager.appendMessage({
				role: "user",
				content: `seeded topic ${turn % 13} session ${session}`,
				timestamp: Date.now(),
			});
			await manager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: filler(`seeded answer ${session}/${turn}`, 2_000) }],
				api: faux.api,
				provider: PROVIDER,
				model: MAIN_MODEL,
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			});
		}
	}
}

/** The main session's earlier work: a long history of turns with tool results, as after hours of use. */
async function seedMain() {
	const manager = await SessionManager.create(store, cwd);
	for (let entry = 0; entry < SEED_ENTRIES; entry += 3) {
		const id = `seed_${entry}`;
		await manager.appendMessage({
			role: "user",
			content: `earlier request ${entry}: ${filler("context", 300)}`,
			timestamp: Date.now(),
		});
		await manager.appendMessage({
			role: "assistant",
			content: [
				{ type: "text", text: filler(`reasoning ${entry}`, 600) },
				{ type: "toolCall", id, name: "read", arguments: { path: "big.ts", offset: 1, limit: 100 } },
			],
			api: faux.api,
			provider: PROVIDER,
			model: MAIN_MODEL,
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.now(),
		});
		await manager.appendMessage({
			role: "toolResult",
			toolCallId: id,
			toolName: "read",
			content: [{ type: "text", text: filler(`file text ${entry}`, 3_000) }],
			isError: false,
			timestamp: Date.now(),
		});
	}
	return manager;
}

const seedStarted = performance.now();
if (PATTERNS.has("history")) await seedHistory();
const mainManager = await seedMain();
const seedSeconds = +((performance.now() - seedStarted) / 1000).toFixed(1);

const settingsManager = SettingsManager.inMemory(settings);
const { session } = await createAgentSession({
	cwd,
	agentDir,
	modelRuntime,
	model: faux.getModel(MAIN_MODEL),
	settingsManager,
	sessionManager: mainManager,
	builtins: { mcp: false, "web-access": false },
});

let lastEventAt = Date.now();
session.subscribe(() => {
	lastEventAt = Date.now();
});

async function quiet(ms) {
	for (;;) {
		await new Promise((resolve) => setTimeout(resolve, 100));
		if (!session.isStreaming && Date.now() - lastEventAt >= ms) return;
	}
}

let jsc;
if (IS_BUN) jsc = await import("bun:jsc");
let v8;
if (!IS_BUN) v8 = await import("node:v8");

async function settle() {
	for (let round = 0; round < 12; round++) {
		collect();
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

function liveCounts() {
	if (IS_BUN) {
		const types = jsc.heapStats().objectTypeCounts;
		return {
			agentSessions: (types.AgentSession ?? 0) + (types.AgentSessionBase ?? 0),
			sessionManagers: types.SessionManager ?? 0,
		};
	}
	if (typeof v8.queryObjects !== "function") return {};
	return {
		agentSessions: v8.queryObjects(atomic.AgentSession, { format: "count" }),
		sessionManagers: v8.queryObjects(SessionManager, { format: "count" }),
	};
}

const samples = [];

/** Process-level counts the heap does not show: anonymous RSS and its high-water mark, open descriptors, threads. */
function processCounts() {
	const counts = {};
	try {
		const status = readFileSync("/proc/self/status", "utf8");
		for (const [key, label] of [
			["RssAnon", "rssAnonMB"],
			["VmHWM", "hwmMB"],
			["Threads", "threads"],
		]) {
			const match = new RegExp(`^${key}:\\s+(\\d+)`, "m").exec(status);
			if (match) counts[label] = key === "Threads" ? Number(match[1]) : +(Number(match[1]) / 1024).toFixed(1);
		}
		counts.fds = readdirSync("/proc/self/fd").length;
	} catch {}
	if (IS_BUN) {
		const stats = jsc.heapStats();
		counts.heapCapacityMB = +(stats.heapCapacity / 2 ** 20).toFixed(1);
		counts.extraMemoryMB = +(stats.extraMemorySize / 2 ** 20).toFixed(1);
		const mimalloc = jsc.memoryUsage();
		counts.mallocMB = +(mimalloc.current / 2 ** 20).toFixed(1);
		counts.mallocPeakMB = +(mimalloc.peak / 2 ** 20).toFixed(1);
	}
	return counts;
}
let lastLongShellAt = 0;
async function sample(round) {
	// A heartbeat shell runs a minute: wait until it and its notice are done.
	const longShellLeft = lastLongShellAt + 66_000 - Date.now();
	if (longShellLeft > 0) await new Promise((resolve) => setTimeout(resolve, longShellLeft));
	await quiet(4_000);
	await settle();
	const memory = process.memoryUsage();
	const heapUsed = IS_BUN ? jsc.heapStats().heapSize : memory.heapUsed;
	const point = {
		round,
		heapUsedMB: +(heapUsed / 2 ** 20).toFixed(1),
		rssMB: +(memory.rss / 2 ** 20).toFixed(1),
		externalMB: +(memory.external / 2 ** 20).toFixed(1),
		...processCounts(),
		...liveCounts(),
		mainEntries: session.sessionManager.getEntries().length,
		...stats,
		flakyFailures,
	};
	samples.push(point);
	console.error(JSON.stringify(point));
	if (values["snapshot-dir"]) {
		mkdirSync(values["snapshot-dir"], { recursive: true });
		const file = join(values["snapshot-dir"], `${values.label}-round-${round}.heapsnapshot`);
		if (IS_BUN) writeFileSync(file, globalThis.Bun.generateHeapSnapshot("v8"));
		else v8.writeHeapSnapshot(file);
	}
}

const started = performance.now();
await sample(0);
for (let round = 1; round <= ROUNDS; round++) {
	if (PATTERNS.has("fallback")) await session.setModel(faux.getModel(FLAKY_MODEL));
	if (PATTERNS.has("shell") && round % 10 === 1) lastLongShellAt = Date.now();
	const roundStarted = performance.now();
	// A background notice can start a turn between the quiet check and this prompt; the round waits for it.
	for (;;) {
		try {
			await session.prompt(`ROUND r=${round}: do this round's work.`);
			break;
		} catch (error) {
			if (error?.code !== "agent_session_busy") throw error;
			await quiet(500);
		}
	}
	await quiet(QUIET_MS);
	if (VERBOSE) {
		const messages = session.messages;
		let from = messages.length - 1;
		while (from > 0 && !(messages[from].role === "user" && textOf(messages[from]).startsWith(`ROUND r=${round}`)))
			from--;
		for (const message of messages.slice(from))
			console.error(
				`  ${message.role}${message.toolName ? `:${message.toolName}` : ""}${message.customType ? `:${message.customType}` : ""} ${textOf(message).replace(/\s+/g, " ").slice(0, 400)}`,
			);
	}
	if (VERBOSE)
		console.error(`round ${round} ${((performance.now() - roundStarted) / 1000).toFixed(1)}s`, JSON.stringify(stats));
	if (round % SAMPLE_EVERY === 0 || round === ROUNDS) await sample(round);
}

const first = samples[1] ?? samples[0];
const last = samples.at(-1);
const report = {
	label: values.label,
	runtime: IS_BUN ? `bun ${globalThis.Bun.version}` : `node ${process.version}`,
	platform: process.platform,
	rounds: ROUNDS,
	forks: FORKS,
	seedEntries: SEED_ENTRIES,
	historySessions: HISTORY_SESSIONS,

	patterns: [...PATTERNS],
	seedSeconds,
	seconds: +((performance.now() - started) / 1000).toFixed(1),
	retainedKBPerRound: +(((last.heapUsedMB - first.heapUsedMB) * 1024) / Math.max(1, last.round - first.round)).toFixed(
		1,
	),
	errorSamples,
	samples,
};
const text = JSON.stringify(report, null, 2);
if (values.out) writeFileSync(values.out, `${text}\n`);
console.log(text);
await session.dispose();
faux.unregister();
await store.close?.();
try {
	const pid = Number((await import("node:fs")).readFileSync(join(agentDir, "intercom", "broker.pid"), "utf8").trim());
	if (pid > 0) process.kill(pid, "SIGKILL");
} catch {}
try {
	rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
} catch (error) {
	console.error(`left ${root}: ${error instanceof Error ? error.message : String(error)}`);
}
process.exit(0);
