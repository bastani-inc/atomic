// Protocol-level stand-in for a local workflow worker, forked by the load gate
// (test/integration/workflow-pool-load-gate.test.ts) through LocalWorkerPool's internal
// `workerEntry` option. It speaks the real worker IPC protocol
// (packages/workflows/src/workers/protocol.ts) and produces the traffic a busy
// agent stage produces: heartbeats (renew, control, activity, usage), tool
// checkpoints, the root pending-stage route an Intercom-capable stage takes, and
// a pooled stage session created and appended to with message entries, some
// over 100 KB. Every commit is a real pool mutation that the root validates and
// journals; nothing is short-circuited.
//
// It loads only Node built-ins so that 150 of them stay cheap. It reads the
// boundary-start checkpoint of its claimed work from the journal, as a real
// worker's read-only journal reader does, to derive the child run topology its
// checkpoints must carry.
//
// The test steers it through a phase file next to the journal:
//   traffic -> heartbeats plus checkpoint and session traffic
//   settle  -> heartbeats only
//   quiet   -> heartbeats only, with renewals counted for the journal-growth check
//   finish  -> report statistics, then complete the claimed work
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";

const start = JSON.parse(process.argv[2]);
const directory = dirname(start.journalPath);
const config = JSON.parse(readFileSync(join(directory, "load-config.json"), "utf8"));
const CHECKPOINT_EVENT = "CheckpointRecorded";

let sequence = 0;
const pending = new Map();
process.on("message", (reply) => {
	if (reply.delivery) {
		process.send({ id: 0, kind: "delivery-ack", deliveryId: reply.delivery.id });
		return;
	}
	const receiver = pending.get(reply.id);
	pending.delete(reply.id);
	if (reply.error) receiver?.reject(new Error(reply.error));
	else receiver?.resolve(reply.value);
});
process.on("disconnect", () => process.exit(1));

function request(message) {
	return new Promise((resolve, reject) => {
		const id = ++sequence;
		pending.set(id, { resolve, reject });
		process.send({ ...message, id }, (error) => {
			if (error) reject(error);
		});
	});
}

let claimed;

// A stub that fails exits like a real worker. It does not replay cached checkpoints, so
// its replacement fails too; the failure log keeps the first cause for the test report.
function fail(error) {
	process.stderr.write(`load stub worker failed: ${error?.stack ?? error}\n`);
	appendFileSync(config.failureLog, `pid ${process.pid} work ${claimed ?? "none"}: ${error?.message ?? error}\n`);
	process.exit(1);
}

function phase() {
	try {
		return readFileSync(config.phaseFile, "utf8").trim() || "traffic";
	} catch {
		return "traffic";
	}
}

const jitter = (ms) => Math.round(ms * (0.5 + Math.random()));

/** Code-like text of exactly `bytes` characters, so entry sizes are what the config says. */
function text(bytes, seed) {
	let out = "";
	for (let line = 0; out.length < bytes; line++)
		out += `${String(line).padStart(5, "0")}  const value_${seed}_${line} = compute(${(line * 7919) % 104729}, "${seed}"); // keep\n`;
	return out.slice(0, bytes);
}

let controlRevision = -1;
let busy = false;
async function observeControl() {
	const control = await request({ kind: "control" });
	if (control.revision === controlRevision) return control;
	controlRevision = control.revision;
	if (control.state !== "quit" || !busy) await request({ kind: "controlled", revision: control.revision });
	return control;
}

const journal = new DatabaseSync(start.journalPath, { readOnly: true, timeout: 60_000 });
const boundaryStart = journal.prepare("SELECT payload FROM wf_events WHERE run_id = ? AND key = ?");

async function perform(work) {
	busy = true;
	claimed = work.id;
	const root = start.root;
	const scope = work.scope;
	const row = boundaryStart.get(root, JSON.stringify([CHECKPOINT_EVENT, "stage", `boundary-start:${scope}`]));
	if (!row) throw new Error(`Boundary start for ${scope} is not journaled`);
	const owner = JSON.parse(String(row.payload)).topology.boundary;
	const run = { ...owner.child };
	const startedAt = Date.now();
	const stageId = randomUUID();
	const sessionId = randomUUID();
	const stats = {
		work: work.id,
		commits: 0,
		toolCheckpoints: 0,
		appends: 0,
		largeAppends: 0,
		appendedBytes: 0,
		renewals: 0,
		quietRenewals: 0,
		activities: 0,
		maxCommitMs: 0,
		routeMs: 0,
	};
	const toolNodes = [];
	const toolEvents = [];
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	let lastSeq = 0;
	let lastEntryId = null;
	let stageStatus = "running";

	const stage = () => ({
		id: stageId,
		name: "agent",
		status: stageStatus,
		parentIds: ["tool-0"],
		executionOrder: 1,
		startedAt,
		...(stageStatus === "completed" ? { endedAt: Date.now(), result: "done" } : {}),
		replayKey: "agent",
		sessionId,
		pendingStageDeliveryAvailable: true,
		model: "fixture/load-model",
		toolEvents: toolEvents.slice(-20),
	});
	const snapshot = () => ({
		id: run.runId,
		name: run.runName,
		inputs: work.inputs,
		status: "running",
		stages: [stage()],
		toolNodes: [...toolNodes],
		startedAt,
		parentRunId: run.parentRunId,
		parentStageId: run.parentStageId,
		rootRunId: root,
		phase: "executing",
		phaseStartedAt: startedAt,
		lastProgressAt: Date.now(),
	});
	const stageCheckpoint = () => ({
		kind: "stage",
		workflowId: root,
		checkpointId: `${scope}:session:${sessionId}:${randomUUID()}`,
		replayKey: `${scope}:agent`,
		name: "agent",
		sessionId,
		completedAt: Date.now(),
		startedAt,
		model: "fixture/load-model",
		topology: {
			version: 1,
			stageId,
			parentIds: ["tool-0"],
			order: 1,
			sourceOrder: 0,
			status: "running",
			run,
		},
	});
	const commit = async (mutation) => {
		const began = performance.now();
		const receipt = await request({ kind: "commit", operation: randomUUID(), mutation });
		stats.maxCommitMs = Math.max(stats.maxCommitMs, Math.round(performance.now() - began));
		stats.commits++;
		return receipt;
	};
	const commitTool = async () => {
		const ordinal = toolNodes.length;
		const nodeId = `tool-${ordinal}`;
		const output = text(1_024 + Math.floor(Math.random() * 3_072), `${nodeId}-${work.id}`);
		const now = Date.now();
		const parentIds = ordinal === 0 ? [] : [stageId];
		await commit({
			kind: "checkpoint",
			checkpoint: {
				kind: "tool",
				workflowId: root,
				checkpointId: `${scope}:tool:${ordinal}`,
				name: `step-${ordinal}`,
				args: { ordinal },
				argsHash: `${scope}:tool-args:${ordinal}`,
				output,
				completedAt: now,
				topology: { version: 1, nodeId, ordinal, order: ordinal, parentIds, startedAt: now, endedAt: now, run },
			},
		});
		toolNodes.push({
			kind: "tool",
			id: nodeId,
			name: `step-${ordinal}`,
			argsHash: `${scope}:tool-args:${ordinal}`,
			ordinal,
			parentIds,
			status: "completed",
			startedAt: now,
			endedAt: now,
			resultSummary: output.slice(0, 120),
			attachable: false,
		});
		stats.toolCheckpoints++;
	};
	const entry = (message) => {
		const id = randomUUID().slice(0, 8);
		const value = { type: "message", id, parentId: lastEntryId, timestamp: new Date().toISOString(), message };
		lastEntryId = id;
		return value;
	};
	// Stagger each stub's large entries so the pool sees them throughout the window.
	const largeOffset = Math.floor(Math.random() * config.largeEvery);
	const append = async () => {
		const index = stats.appends;
		const large = (index + largeOffset) % config.largeEvery === config.largeEvery - 1;
		const bytes = large ? config.largeEntryBytes : 1_536 + Math.floor(Math.random() * 4_608);
		const callId = `call-${index}`;
		const now = Date.now();
		const entries =
			index % 2 === 0
				? [
						entry({
							role: "assistant",
							content: [
								{ type: "text", text: text(Math.floor(bytes / 2), `assistant-${index}`) },
								{
									type: "toolCall",
									id: callId,
									name: "bash",
									arguments: { command: text(Math.floor(bytes / 2), `command-${index}`) },
								},
							],
							api: "openai-completions",
							provider: "fixture",
							model: "load-model",
							usage: {
								input: 900,
								output: 300,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 1_200,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							},
							stopReason: "toolUse",
							timestamp: now,
						}),
					]
				: [
						entry({
							role: "toolResult",
							toolCallId: callId,
							toolName: "bash",
							content: [{ type: "text", text: text(bytes, `result-${index}`) }],
							isError: false,
							timestamp: now,
						}),
					];
		const receipt = await commit({ kind: "session-append", checkpoint: stageCheckpoint(), entries, expectSeq: lastSeq });
		lastSeq = receipt.lastSeq;
		usage.input += 900;
		usage.output += 300;
		toolEvents.push({ name: "bash", input: { command: `step ${index}` }, output: text(400, `event-${index}`), startedAt: now, endedAt: Date.now() });
		stats.appends++;
		stats.appendedBytes += bytes;
		if (large) stats.largeAppends++;
	};

	let renewal;
	let controlPulse;
	let report;
	const heartbeat = setInterval(() => {
		renewal ??= request({ kind: "renew" })
			.then(() => {
				stats.renewals++;
				if (phase() === "quiet") stats.quietRenewals++;
			})
			.catch(fail)
			.finally(() => {
				renewal = undefined;
			});
		controlPulse ??= observeControl()
			.catch(fail)
			.finally(() => {
				controlPulse = undefined;
			});
		report ??= (async () => {
			await request({ kind: "activity", runs: [snapshot()] });
			stats.activities++;
			await request({
				kind: "usage",
				reports: [{ key: `stage:${run.runId}:${stageId}`, usage: { ...usage } }],
			});
		})()
			.catch(fail)
			.finally(() => {
				report = undefined;
			});
	}, config.heartbeatMs);

	// The order a real worker follows when an Intercom-capable agent stage starts:
	// publish the stage, take the root's pending-stage route, write the session,
	// then report the session ready for queued deliveries.
	await commitTool();
	await request({ kind: "activity", runs: [snapshot()] });
	const routeStartedAt = performance.now();
	const capability = await request({ kind: "route", runId: run.runId });
	if (typeof capability !== "string") throw new Error("Root pending-stage route is unavailable");
	stats.routeMs = Math.round(performance.now() - routeStartedAt);
	const created = await commit({
		kind: "session-create",
		checkpoint: stageCheckpoint(),
		header: {
			id: sessionId,
			version: 4,
			createdAt: new Date(startedAt).toISOString(),
			cwd: String(work.execution.cwd),
			internal: true,
			workflow: { runId: run.runId, stageId, stageName: "agent" },
		},
		entries: [entry({ role: "user", content: text(2_048, `prompt-${work.id}`), timestamp: Date.now() })],
	});
	lastSeq = created.lastSeq;
	await request({ kind: "delivery-ready", runId: run.runId, stageId, stageName: "agent", sessionId });
	await request({ kind: "activity", runs: [snapshot()] });
	mkdirSync(config.activeDirectory, { recursive: true });
	writeFileSync(join(config.activeDirectory, work.id), "");

	let nextAppend = Date.now() + jitter(config.appendIntervalMs);
	let nextTool = Date.now() + jitter(config.toolIntervalMs);
	while (phase() === "traffic") {
		const now = Date.now();
		if (now >= nextTool) {
			await commitTool();
			nextTool = Date.now() + jitter(config.toolIntervalMs);
		} else if (now >= nextAppend) {
			await append();
			nextAppend = Date.now() + jitter(config.appendIntervalMs);
		} else await delay(Math.min(nextTool, nextAppend, now + 250) - now);
	}
	while (phase() !== "finish") await delay(100);
	clearInterval(heartbeat);
	await renewal;
	await controlPulse;
	await report;
	stageStatus = "completed";
	mkdirSync(config.statsDirectory, { recursive: true });
	writeFileSync(join(config.statsDirectory, `${work.id}.json`), JSON.stringify(stats));
	await request({ kind: "usage", reports: [{ key: `stage:${run.runId}:${stageId}`, usage: { ...usage } }] });
	await observeControl();
	await request({
		kind: "complete",
		result: { runId: run.runId, status: "completed", result: {}, stages: [stage()], toolNodes: [...toolNodes] },
	});
	busy = false;
}

try {
	await request({ kind: "ready" });
	for (;;) {
		const control = await observeControl();
		if (control.state !== "running") {
			await delay(25);
			continue;
		}
		const work = await request({ kind: "claim" });
		if (!work) {
			await delay(25 + Math.random() * 25);
			continue;
		}
		await perform(work);
	}
} catch (error) {
	fail(error);
}
