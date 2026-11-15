// Protocol-level stand-in for a local workflow worker, forked by test/integration/workflow-local-pool-attempt-counting
// .test.ts through LocalWorkerPool's internal `workerEntry` option (#4768). Every attempt it claims, it hands back at
// once as one the shared store kept refusing, as a worker does past its handoff bound. A `fenced-mode` file next to the
// journal changes how it ends each attempt (#4822): `stale` ends it as refused, with no fault; `fault` ends it on a
// fault of the pool that is no handoff.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const modePath = join(dirname(JSON.parse(process.argv[2]).journalPath), "fenced-mode");
const mode = existsSync(modePath) ? readFileSync(modePath, "utf8").trim() : "handoff";
const fault = { name: "StorageUnavailableError", message: "Storage unavailable: the store stayed busy", fields: {} };

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

await request({ kind: "ready" });
let revision = -1;
for (;;) {
	const control = await request({ kind: "control" });
	if (control.revision !== revision) {
		revision = control.revision;
		await request({ kind: "controlled", revision });
		if (control.state === "quit") process.exit(0);
	}
	const work = await request({ kind: "claim" }).catch(() => undefined);
	if (work)
		await request(
			mode === "stale"
				? { kind: "fenced" }
				: mode === "fault"
					? { kind: "fenced", fault }
					: { kind: "fenced", handoff: true, fault },
		);
	else await delay(10);
}
