import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type * as C from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { TaskSupervisor } from "../../packages/coding-agent/src/core/tasks/supervisor.js";
import { sleep } from "../helpers/runtime.js";

type Rejection = object | string | number | boolean | bigint | symbol | null | undefined;
function value<T, E>(result: C.Result<T, E>): T {
	assert.equal(result.ok, true, result.ok ? undefined : JSON.stringify(result.error));
	if (!result.ok) throw new Error("refused");
	return result.value;
}
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: Rejection) => void;
	const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
	return { promise, resolve, reject };
}
/**
 * How long a settled runner may take to show in the owner's snapshot. It takes a few promise turns; the bound only has
 * to catch a report that never arrives, and a loaded Windows runner under Bun once took longer than one second.
 */
const CONVERGENCE_BUDGET_MS = 10_000;
async function eventually(check: () => boolean, what: string) {
	const deadline = Date.now() + CONVERGENCE_BUDGET_MS;
	while (!check() && Date.now() < deadline) await sleep(5);
	assert.ok(check(), `rejection reporting and independent cleanup must converge: ${what}`);
}
const faults: Rejection[] = [];
const onUnhandled = (reason: Rejection) => { faults.push(reason); };
process.on("unhandledRejection", onUnhandled);
const revoked = Proxy.revocable({}, {});
revoked.revoke();
const cases: Array<{ rejection: Rejection; message: string }> = [
	{ rejection: "credential-free rejection \n ", message: "credential-free rejection \n " },
	{ rejection: new Error(" verbatim error \n "), message: " verbatim error \n " },
	{ rejection: "", message: "" },
	{ rejection: null, message: "null" },
	{ rejection: undefined, message: "undefined" },
	{ rejection: Symbol("raw"), message: "Symbol(raw)" },
	{ rejection: 0.5, message: "0.5" },
	{ rejection: 0n, message: "0" },
	{ rejection: false, message: "false" },
	{ rejection: {}, message: "[object Object]" },
	{ rejection: { toString() { throw new Error("format trap"); } }, message: "Unprintable JavaScript rejection" },
	{ rejection: Object.create(null), message: "Unprintable JavaScript rejection" },
	{ rejection: revoked.proxy, message: "Unprintable JavaScript rejection" },
	{ rejection: Object.defineProperty(new Error(), "message", { get() { throw new Error("message trap"); } }), message: "Unprintable JavaScript rejection" },
];
// RFC #2884: rejection reasons are JS values, not an Error-only promise contract.
for (const path of ["result", "cleanup", "setup"]) {
	for (const [index, { rejection, message }] of cases.entries()) {
		const what = `${path} case ${index}`;
		const supervisor = new TaskSupervisor();
		const scope: C.OwnerScope = { kind: "session", sessionId: randomUUID() };
		const result = deferred<C.TaskResult>();
		const cleanup = deferred<C.Cleanup>();
		const host = supervisor.bindHostSession({
			scope, authorizeLaunch() {}, createRunner() {
				if (path === "setup") throw rejection;
				return { result: result.promise, cleanup: cleanup.promise };
			},
		});
		const owner = value(supervisor.openTaskOwner(host, scope));
		value(await supervisor.startAgentTask(owner, { kind: "agent", agent: "", task: "" }, "" as C.OperationId));
		const watch = value(supervisor.watchOwnerTasks(owner));
		try {
			if (path === "result") { result.reject(rejection); cleanup.resolve({ kind: "reaped" }); }
			if (path === "cleanup") { result.resolve({ kind: "failed", code: "natural", message: "" }); cleanup.reject(rejection); }
			await eventually(() => watch.snapshot.tasks[0].execution.kind === "settled" && ["failed", "reaped"].includes(watch.snapshot.tasks[0].cleanup.kind), what);
			const expected: C.TaskResult = path === "cleanup" ? { kind: "failed", code: "natural", message: "" } : { kind: "failed", code: path === "setup" ? "SpawnFailed" : "RunnerFailed", message };
			assert.deepEqual(watch.snapshot.tasks[0].execution, { kind: "settled", result: expected });
			const closing = await supervisor.closeTaskOwner(owner, "session-close");
			if (path === "result") value(closing);
			else {
				assert.equal(!closing.ok && closing.error.code, "CleanupFailed");
				await eventually(() => watch.snapshot.state === "closing", `${what} closing`);
				assert.equal(watch.snapshot.state, "closing");
				assert.deepEqual(watch.snapshot.tasks[0].cleanup, { kind: "failed", resources: [{ resource: path === "setup" ? "fake-runner-setup" : "fake-runner", code: path === "setup" ? "CleanupUnconfirmed" : "CleanupFailed", message }] });
			}
		} finally { watch.dispose(); }
	}
}
// RFC #2884: even rejection-valued cleanup is independent of a cancelled result that never settles.
for (const cleanupFirst of [true, false]) {
	const supervisor = new TaskSupervisor();
	const scope: C.OwnerScope = { kind: "session", sessionId: randomUUID() };
	const cleanup = deferred<C.Cleanup>();
	const host = supervisor.bindHostSession({ scope, authorizeLaunch() {}, createRunner() { return { result: new Promise<C.TaskResult>(() => {}), cleanup: cleanup.promise }; } });
	const owner = value(supervisor.openTaskOwner(host, scope));
	value(await supervisor.startAgentTask(owner, { kind: "agent", agent: "", task: "" }, "" as C.OperationId));
	if (cleanupFirst) { cleanup.reject(" raw cleanup "); await sleep(0); }
	const closing = supervisor.closeTaskOwner(owner, "session-close");
	if (!cleanupFirst) cleanup.reject(" raw cleanup ");
	const closed = await Promise.race([closing, sleep(CONVERGENCE_BUDGET_MS).then(() => undefined)]);
	assert.ok(closed, "failed cleanup must not wait for the cancelled result");
	assert.equal(!closed.ok && closed.error.code, "CleanupFailed");
	if (!closed.ok) assert.match(closed.error.message, / raw cleanup /);
}
await sleep(25);
process.off("unhandledRejection", onUnhandled);
assert.deepEqual(faults, [], "no unhandled rejection from valid JavaScript rejection reasons");
console.log(`JS REJECTIONS PRESERVED ${cases.length * 3} diagnostics and 2 independent cleanup orders`);
