// Protocol-level stand-in for a local workflow worker, forked by test/unit/workflow-pool-stale-attempt-commit.test.ts
// through LocalWorkerPool's internal `workerEntry` option (#4768). It claims its work, then sends a commit made for an
// earlier attempt of that work and one made for the attempt it holds, and records each answer in
// `stale-commit-replies.log` next to the journal. Afterwards it only follows pool control, so the pool can close it.
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const start = JSON.parse(process.argv[2]);
const replies = join(dirname(start.journalPath), "stale-commit-replies.log");

let sequence = 0;
const pending = new Map();
process.on("message", (reply) => {
	if (reply.delivery) {
		process.send({ id: 0, kind: "delivery-ack", deliveryId: reply.delivery.id });
		return;
	}
	const receiver = pending.get(reply.id);
	pending.delete(reply.id);
	if (reply.error) receiver?.reject(reply.error);
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

await request({ kind: "ready" });
let work;
while (!(work = await request({ kind: "claim" }))) await delay(25);
for (const [label, generation] of [
	["earlier", work.generation - 1],
	["held", work.generation],
])
	await request({
		kind: "commit",
		operation: `${label}-operation`,
		mutation: { kind: "session-append", sessionId: "session", entries: [], expectSeq: 0 },
		attempt: { id: work.id, generation },
	}).then(
		() => appendFileSync(replies, `${JSON.stringify({ label, outcome: "answered" })}\n`),
		(error) => appendFileSync(replies, `${JSON.stringify({ label, outcome: "refused", name: error?.name, reason: error?.reason })}\n`),
	);
let revision = -1;
for (;;) {
	const control = await request({ kind: "control" });
	if (control.revision !== revision) {
		revision = control.revision;
		await request({ kind: "controlled", revision });
		if (control.state === "quit") process.exit(0);
	}
	await delay(25);
}
