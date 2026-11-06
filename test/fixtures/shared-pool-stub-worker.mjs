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
function answerRefusal(promptId) {
	if (promptId.startsWith("refuse-")) return promptId.slice("refuse-".length);
	if (promptId !== "stale-once" || staleOnce.has(promptId)) return undefined;
	staleOnce.add(promptId);
	return "StaleAttempt";
}

let sequence = 0;
const pending = new Map();
process.on("message", (reply) => {
	if (reply.kind === "stage-command") {
		const refusal = reply.op === "answer" ? answerRefusal(reply.answer.promptId) : undefined;
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
	const work = await request({ kind: "claim" }).catch(() => undefined);
	if (!work) {
		await delay(25);
		continue;
	}
	const bound = work.execution.workspace?.kind === "bound-workspace" ? ` ${work.execution.workspace.worktree}` : "";
	appendFileSync(log, `${host} ${work.id} ${work.execution.cwd}${bound}\n`);
	await request({ kind: "stage-workspace", runId: work.childRunId, stageId: "stage" });
	if (process.env.SHARED_POOL_STUB_CRASH === "1") process.exit(1);
	await request({
		kind: "activity",
		runs: [
			{
				id: work.childRunId,
				name: "child",
				status: "running",
				startedAt: Date.now(),
				inputs: {},
				stages: [],
				toolNodes: [],
				rootRunId: start.root,
				parentRunId: start.root,
				parentStageId: work.boundaryId,
				...(process.env.SHARED_POOL_STUB_WAITS === "1"
					? {
							stages: [
								{
									id: "stage",
									name: "stage",
									status: "waiting",
									wait: { kind: "tool", since: Date.now() },
									parentIds: [],
									toolEvents: [],
								},
							],
						}
					: {}),
			},
		],
	});
	if (process.env.SHARED_POOL_STUB_WAITS === "1") {
		const released = await request({ kind: "place", op: "release" }).then(
			() => "released",
			() => "refused",
		);
		appendFileSync(log, `place-released ${host} ${work.id} ${released}\n`);
	}
	while (release !== undefined && !existsSync(release)) {
		await offerControl(await request({ kind: "heartbeat", reports: [] }));
		await delay(25);
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
