// Protocol-level stand-in for a worker of a shared pool (#4310), forked by the test/unit/workflow-shared-pool-coordinator*.test.ts files
// through the pool's internal `workerEntry`. It speaks the real worker IPC protocol: it claims work, records where its
// stage runs, publishes its run, and completes the work once SHARED_POOL_STUB_RELEASE exists (at once without it). It
// answers every stage prompt it is given. Each claim is one line in SHARED_POOL_STUB_LOG: `<host> <work id> <cwd>`, then
// the worktree of the #3109 workspace the child is bound to when it is bound to one, and
// each answer one line `answer <run id> <stage id> <prompt id>`; its start options, with its pid, the first entry of its
// PATH and its SHARED_POOL_GIT_MARKER, are the line `start <json>`. With SHARED_POOL_STUB_CRASH=1 it exits with status 1
// right after recording where its stage runs, as a worker that crashed mid-child. On the host SHARED_POOL_STUB_HANG_HOST
// names, it never reports ready, as a worker stuck starting up. With SHARED_POOL_STUB_WAITS=1 its stage waits released
// for a tool result and the attempt gives its place back, logged as `place-released <host> <work id> <released|refused>`.
// With SHARED_POOL_STUB_LIVE_STAGE=1 its run has one live
// agent stage, "stage", whose session is "session-stage" and whose brokered question is "q1" (#4391), and it publishes
// the run again while it waits for release. It takes stage inputs of every kind (#4391), one line each in the log:
// `question <run id> <stage id>`, `user <delivery op> <intent> <text>` (with ` expand=<boolean>` when the text says
// whether to expand prompt templates) and `intercom <session id> <message id>`. A
// delivery op or message id "stale-once" is refused as stale once, "refuse-<refusal>" is refused with that refusal, and
// a delivery op "error-<detail>" fails with that detail. Each Intercom message a stage session takes the first time is
// also the line `received <session id> <message id>`. A delivery op "await-answer" is deferred as awaiting input
// until the stage took the answer to prompt "unblock". With SHARED_POOL_STUB_SESSION_PER_HOST=1 the stage's session is
// "session-<host>", as a replacement on another host runs a new session. An Intercom message for another session than
// the stage's is not taken yet (`StaleAttempt`), as a stage's inbox answers for a session that never handed its sink
// over; on the host SHARED_POOL_STUB_INTERCOM_PENDING_HOST names, no Intercom message is taken yet. A message id
// "error-<detail>" fails in the session with that detail. On the host
// SHARED_POOL_STUB_CLAIM_GATE_HOST names, the worker claims nothing until the file SHARED_POOL_STUB_CLAIM_GATE exists.
// A stage input command for another attempt than the one the worker holds is answered `StaleAttempt`.
import { appendFileSync, existsSync } from "node:fs";
import { delimiter } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const start = JSON.parse(process.argv[2]);
const host = start.shared?.host ?? "unshared";
const log = process.env.SHARED_POOL_STUB_LOG;
const release = process.env.SHARED_POOL_STUB_RELEASE;
appendFileSync(
	log,
	`start ${JSON.stringify({
		...start,
		pid: process.pid,
		pathHead: (process.env.PATH ?? "").split(delimiter)[0],
		gitMarker: process.env.SHARED_POOL_GIT_MARKER ?? null,
	})}\n`,
);

// An answer to prompt "refuse-<refusal>" is refused with that refusal; one to "stale-once" is refused as stale once.
const staleOnce = new Set();
function answerRefusal(promptId, kind = "answer") {
	if (promptId.startsWith("refuse-")) return promptId.slice("refuse-".length);
	if (promptId !== "stale-once" || staleOnce.has(`${kind}:${promptId}`)) return undefined;
	staleOnce.add(`${kind}:${promptId}`);
	return "StaleAttempt";
}

const LIVE_STAGE = process.env.SHARED_POOL_STUB_LIVE_STAGE === "1";
const SESSION_ID = process.env.SHARED_POOL_STUB_SESSION_PER_HOST === "1" ? `session-${host}` : "session-stage";
/** Prompt ids this worker's stage took an answer for. */
const answered = new Set();
/** Intercom messages this worker's stage session took, by session and message id. */
const received = new Set();
const QUESTION = {
	promptId: "q1",
	kind: "ask_user_question",
	params: {
		questions: [
			{
				question: "Ship it?",
				header: "Ship",
				multiSelect: false,
				options: [
					{ label: "yes", description: "Ship it now" },
					{ label: "no", description: "Hold it" },
				],
			},
		],
	},
};

/** The stub's answer to one stage command of the kinds a stage input carries (#4391). */
function stageInputResult(command) {
	if (command.op === "question") {
		appendFileSync(log, `question ${command.runId} ${command.stageId}\n`);
		return { question: QUESTION };
	}
	if (command.op === "user-message") {
		const expand = command.expandPromptTemplates === undefined ? "" : ` expand=${command.expandPromptTemplates}`;
		appendFileSync(log, `user ${command.deliveryOp} ${command.intent} ${command.text}${expand}\n`);
		// A stage waiting for the answer to prompt "unblock" defers this text until it has it.
		if (command.deliveryOp === "await-answer" && !answered.has("unblock")) return { refusal: "AwaitingInput" };
		if (command.deliveryOp.startsWith("error-"))
			return { error: { name: "Error", message: command.deliveryOp.slice("error-".length), fields: {} } };
		const refusal = answerRefusal(command.deliveryOp, "user");
		if (refusal !== undefined) return { refusal };
		return { action: command.intent === "steer" ? "steer" : "followUp" };
	}
	appendFileSync(log, `intercom ${command.sessionId} ${command.message.id}\n`);
	if (command.sessionId !== SESSION_ID || process.env.SHARED_POOL_STUB_INTERCOM_PENDING_HOST === host)
		return { refusal: "StaleAttempt" };
	if (command.message.id.startsWith("error-"))
		return { error: { name: "Error", message: command.message.id.slice("error-".length), fields: {} } };
	const refusal = answerRefusal(command.message.id, "intercom");
	if (refusal !== undefined) return { refusal };
	// As a stage session does, it takes each message once: one handed over again is already held.
	const key = `${command.sessionId} ${command.message.id}`;
	if (!received.has(key)) {
		received.add(key);
		appendFileSync(log, `received ${key}\n`);
	}
	return {};
}

let sequence = 0;
const pending = new Map();
/** The attempt this worker holds now. */
let held;
process.on("message", (reply) => {
	if (reply.kind === "stage-command" && ["question", "user-message", "intercom"].includes(reply.op)) {
		// A command for another attempt than the one this worker holds is stale, as a worker's airlock answers.
		const current = reply.attempt?.workId === held?.id && reply.attempt?.generation === held?.generation;
		process.send({
			id: 0,
			kind: "stage-command-result",
			commandId: reply.commandId,
			...(current ? stageInputResult(reply) : { refusal: "StaleAttempt" }),
		});
		return;
	}
	if (reply.kind === "stage-command") {
		const refusal = reply.op === "answer" ? answerRefusal(reply.answer.promptId) : undefined;
		if (reply.op === "answer" && refusal === undefined) answered.add(reply.answer.promptId);
		if (reply.op === "answer") appendFileSync(log, `answer ${reply.runId} ${reply.stageId} ${reply.answer.promptId}\n`);
		process.send({
			id: 0,
			kind: "stage-command-result",
			commandId: reply.commandId,
			...(refusal === undefined ? {} : { refusal }),
		});
		return;
	}
	if (reply.kind === "pool-control") {
		void offerControl(reply.control);
		return;
	}
	if (reply.kind !== undefined) return;
	const receiver = pending.get(reply.id);
	pending.delete(reply.id);
	if (reply.error) receiver?.reject(Object.assign(new Error(reply.error), { reply }));
	else receiver?.resolve(reply.value);
});
process.on("disconnect", () => process.exit(0));

function request(message) {
	return new Promise((resolve, reject) => {
		const id = ++sequence;
		pending.set(id, { resolve, reject });
		process.send({ ...message, id }, (error) => {
			if (error) reject(error);
		});
	});
}

let revision = -1;
let state = "running";
// Pool control arrives pushed, in heartbeat replies and from control reads; a newer revision is applied and acknowledged.
async function offerControl(control) {
	if (control.revision <= revision) return;
	revision = control.revision;
	state = control.state;
	await request({ kind: "controlled", revision });
}
async function followControl() {
	await offerControl(await request({ kind: "control" }));
	return state;
}

if (process.env.SHARED_POOL_STUB_HANG_HOST === host) await new Promise(() => setInterval(() => {}, 60_000));
await request({ kind: "ready" });
// SHARED_POOL_STUB_EXIT_IDLE=1: the worker dies as soon as it is ready, before it claims anything.
if (process.env.SHARED_POOL_STUB_EXIT_IDLE === "1") process.exit(1);
for (;;) {
	if ((await followControl()) !== "running") {
		await delay(25);
		continue;
	}
	if (process.env.SHARED_POOL_STUB_CLAIM_GATE_HOST === host && !existsSync(process.env.SHARED_POOL_STUB_CLAIM_GATE)) {
		await delay(25);
		continue;
	}
	const work = await request({ kind: "claim" }).catch(() => undefined);
	if (!work) {
		await delay(25);
		continue;
	}
	held = work;
	const bound = work.execution.workspace?.kind === "bound-workspace" ? ` ${work.execution.workspace.worktree}` : "";
	appendFileSync(log, `${host} ${work.id} ${work.execution.cwd}${bound}\n`);
	await request({ kind: "stage-workspace", runId: work.childRunId, stageId: "stage" });
	if (process.env.SHARED_POOL_STUB_CRASH === "1") process.exit(1);
	const startedAt = Date.now();
	const liveStage = {
		id: "stage",
		name: "stage",
		status: "running",
		parentIds: [],
		executionOrder: 1,
		startedAt,
		replayKey: "stage",
		sessionId: SESSION_ID,
		pendingStageDeliveryAvailable: true,
		inputRequest: {
			id: QUESTION.promptId,
			kind: QUESTION.kind,
			questions: [
				{ question: "Ship it?", header: "Ship", multiSelect: false, options: [{ label: "yes" }, { label: "no" }] },
			],
			createdAt: startedAt,
		},
		toolEvents: [],
	};
	const waitingStage = {
		id: "stage",
		name: "stage",
		status: "suspended",
		wait: { kind: "tool", since: startedAt },
		parentIds: [],
		toolEvents: [],
	};
	const publish = () =>
		request({
			kind: "activity",
			runs: [
				{
					id: work.childRunId,
					name: "child",
					status: "running",
					startedAt,
					inputs: {},
					stages: process.env.SHARED_POOL_STUB_WAITS === "1" ? [waitingStage] : LIVE_STAGE ? [liveStage] : [],
					toolNodes: [],
					rootRunId: start.root,
					parentRunId: start.root,
					parentStageId: work.boundaryId,
				},
			],
		});
	await publish();
	if (process.env.SHARED_POOL_STUB_WAITS === "1") {
		const released = await request({ kind: "place", op: "release" }).then(
			() => "released",
			() => "refused",
		);
		appendFileSync(log, `place-released ${host} ${work.id} ${released}\n`);
	}
	let beats = 0;
	while (release !== undefined && !existsSync(release)) {
		await offerControl(await request({ kind: "heartbeat", reports: [] }));
		if (LIVE_STAGE && ++beats % 8 === 0) await publish();
		await delay(25);
	}
	// SHARED_POOL_STUB_FINISH_STAGE=1: on release, the stage finishes and is published so before the child completes.
	if (LIVE_STAGE && process.env.SHARED_POOL_STUB_FINISH_STAGE === "1") {
		liveStage.status = "completed";
		await publish();
		await delay(1_500);
	}
	await request({
		kind: "complete",
		result: { runId: work.childRunId, status: "completed", result: {}, stages: [], toolNodes: [] },
	});
	// SHARED_POOL_STUB_RECYCLE=1: past its memory limit after its first child, the worker ends itself to be replaced.
	if (process.env.SHARED_POOL_STUB_RECYCLE === "1") {
		await request({ kind: "recycle", attempts: 1, rssBytes: 1 });
		process.exit(0);
	}
}
