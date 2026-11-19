import assert from "node:assert/strict";
// The extension imports the SDK by package name; the built CLI imports its host by file. Bun can load both copies.
import { bindTaskResumer } from "@bastani/atomic";
import {
	AgentTaskHost,
	agentPanelItems,
	bindOwnerTaskStore,
	OwnerTaskStore,
	ownerTaskViewSource,
	stopAgentPanelItem,
} from "../../../packages/coding-agent/dist/index.js";

const session = {};
const host = new AgentTaskHost({ scope: { kind: "session", sessionId: "panel-stop" }, authorizeLaunch() {} });
const { supervisor, owner } = host.ownerBinding;
const store = new OwnerTaskStore(supervisor, owner);
const messages = [];
const unbind = bindTaskResumer(supervisor, {
	stop: (id) => host.cancelTask(id, "quit"),
	readOnlyReason: () => undefined,
	async resume(id, message) {
		messages.push([id, message]);
		return { ok: true };
	},
});
try {
	bindOwnerTaskStore(session, store);
	assert.ok(store.connect().ok);
	const dispatched = Promise.withResolvers();
	const started = await host.startAgentTask({ kind: "agent", agent: "worker", task: "hold" }, "launch", ({ signal }) => {
		dispatched.resolve();
		return {
			result: new Promise((resolve) => {
				signal.addEventListener("abort", () => resolve({ kind: "cancelled", cause: signal.reason }), { once: true });
			}),
			cleanup: Promise.resolve({ kind: "reaped" }),
		};
	});
	assert.ok(started.ok);
	await dispatched.promise;
	const id = started.value.taskId;
	assert.ok((await host.observeAgentLaunch(id)).ok);
	store.drain();
	const [item] = agentPanelItems(session);
	assert.equal(item.state, "running");
	assert.deepEqual(await stopAgentPanelItem(session, item.id), { ok: true });
	const settled = await host.waitForTask(id);
	assert.ok(settled.ok && settled.value.kind === "settled");
	assert.equal(settled.value.result.cause, "quit");
	store.drain();
	await ownerTaskViewSource(store).sendTaskMessage(id, "continue");
	assert.deepEqual(messages, [[id, "continue"]]);
} finally {
	unbind();
	store.dispose();
	await host.close("session-close");
}
