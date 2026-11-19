import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const loadSdk = (name) =>
	import(pathToFileURL(createRequire(join(process.argv[2], name, "consumer.mjs")).resolve("@bastani/atomic")).href);
const a = await loadSdk("a");
const b = await loadSdk("b");
assert.notEqual(a.bindTaskResumer, b.bindTaskResumer);
const hostA = new a.AgentTaskHost({ scope: { kind: "session", sessionId: "A" }, authorizeLaunch() {} });
const hostB = new b.AgentTaskHost({ scope: { kind: "session", sessionId: "B" }, authorizeLaunch() {} });
const { supervisor, owner } = hostB.ownerBinding;
const store = new b.OwnerTaskStore(supervisor, owner);
const session = {};
const stopped = new Set();
const handler = {
	readOnlyReason: () => undefined,
	resume: async () => ({ ok: true }),
	isStopped: (id) => stopped.has(id),
	async stop(id) {
		stopped.add(id);
		return { ok: true };
	},
};
const foreignReads = [];
const handlerA = process.argv[3] === "shared" ? handler : {
	...handler,
	isStopped(id) {
		foreignReads.push(id);
		return false;
	},
};
const offA = a.bindTaskResumer(hostA.ownerBinding.supervisor, handlerA);
// A bundled extension may also register B's handler through A's SDK copy.
const offB = (handlerA === handler ? b : a).bindTaskResumer(supervisor, handler);
try {
	b.bindOwnerTaskStore(session, store);
	assert.ok(store.connect().ok);
	const settle = Promise.withResolvers();
	const started = await hostB.startAgentTask({ kind: "agent", agent: "worker", task: "release" }, "launch", () => ({
		result: settle.promise,
		cleanup: Promise.resolve({ kind: "reaped" }),
	}));
	assert.ok(started.ok);
	const id = started.value.taskId;
	assert.ok((await hostB.observeAgentLaunch(id)).ok);
	settle.resolve({ kind: "cancelled", cause: "pause", released: { waitingOn: [{ toolCallId: "call", toolName: "bash" }] } });
	assert.ok((await hostB.waitForTask(id)).ok);
	store.drain();
	const row = () => b.agentPanelItems(session)[0];
	assert.equal(row().state, "waiting");
	foreignReads.length = 0;
	assert.equal(row().waitingOn, "bash");
	assert.deepEqual(foreignReads, [], "repainting B must not ask A about B's task");
	assert.deepEqual(await b.stopAgentPanelItem(session, row().id), { ok: true });
	assert.equal(row().state, "stopped");
	offA();
	await hostA.close("session-close");
	assert.equal(row().state, "stopped", "closing A must not unregister B's stop handler");
	offB();
	assert.equal(row().state, "waiting", "after B unregisters, the panel no longer consults its handler");
} finally {
	offA();
	offB();
	store.dispose();
	await hostA.close("session-close");
	await hostB.close("session-close");
}
