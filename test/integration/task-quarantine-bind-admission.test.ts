import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { isTaskCleanupAdmissionTimeoutError } from "@bastani/atomic";
import { test } from "vitest";
import type {
	ResourceAdmission,
	ResourcePermit,
	ResourceProcessIdentity,
} from "../../packages/coding-agent/src/core/sdk-types.js";
import { AgentTaskHost } from "../../packages/coding-agent/src/core/tasks/agent-adapter.js";
import type { OperationId, TaskId } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { QUARANTINED_ADMISSION_WAIT_MS } from "../../packages/coding-agent/src/core/tasks/supervisor.js";
import {
	fileExistsSync,
	makeTempDirectory,
	readTextSync,
	removeTempDirectory,
	sleep,
	writeTextSync,
} from "../helpers/runtime.js";

const TERM_AND_DRAIN_GRACE_MS = 2_250;
const STRUCTURAL_HEADROOM_MS = 10_000;
const BIND_ENTRY_LIMIT_MS = STRUCTURAL_HEADROOM_MS;
const QUARANTINE_EVENT_LIMIT_MS = TERM_AND_DRAIN_GRACE_MS + STRUCTURAL_HEADROOM_MS;
const WAITING_LIMIT_MS = STRUCTURAL_HEADROOM_MS;
const FIRST_LAUNCH_LIMIT_MS = BIND_ENTRY_LIMIT_MS + QUARANTINE_EVENT_LIMIT_MS + WAITING_LIMIT_MS;
const BLOCKED_LAUNCH_LIMIT_MS = QUARANTINED_ADMISSION_WAIT_MS + STRUCTURAL_HEADROOM_MS;
const RELEASE_LIMIT_MS = STRUCTURAL_HEADROOM_MS;
const CLOSE_LIMIT_MS = QUARANTINE_EVENT_LIMIT_MS;
const TEST_TIMEOUT_MS =
	FIRST_LAUNCH_LIMIT_MS + BLOCKED_LAUNCH_LIMIT_MS + RELEASE_LIMIT_MS + CLOSE_LIMIT_MS + STRUCTURAL_HEADROOM_MS;
const POLL_MS = 50;

class GatedBindAdmission implements ResourceAdmission {
	held = 0;
	acquired = 0;
	releaseCalls = 0;
	permit: ResourcePermit | undefined;
	readonly bindReceivers: unknown[] = [];
	readonly bound: ResourceProcessIdentity[] = [];
	readonly releaseReceivers: unknown[] = [];
	private readonly queue: Array<() => void> = [];
	constructor(
		private readonly gate: Promise<void>,
		private readonly bindEntered: () => void,
	) {}
	get waiting(): number {
		return this.queue.length;
	}
	acquire(_kind: "session" | "process", signal?: AbortSignal): Promise<ResourcePermit> {
		if (signal?.aborted) return Promise.reject(signal.reason);
		return new Promise((resolve, reject) => {
			const grant = () => {
				this.held++;
				this.acquired++;
				let released = false;
				const permit: ResourcePermit = async function (this: unknown) {
					admission.releaseCalls++;
					admission.releaseReceivers.push(this);
					if (released) return;
					released = true;
					admission.held--;
					admission.queue.shift()?.();
				};
				permit.bindProcess = async function (this: unknown, identity: ResourceProcessIdentity) {
					admission.bindReceivers.push(this);
					admission.bound.push(identity);
					admission.bindEntered();
					await admission.gate;
				};
				this.permit = permit;
				resolve(permit);
			};
			const admission = this;
			if (this.held < 1) return grant();
			this.queue.push(grant);
			signal?.addEventListener(
				"abort",
				() => {
					const index = this.queue.indexOf(grant);
					if (index < 0) return;
					this.queue.splice(index, 1);
					reject(signal.reason);
				},
				{ once: true },
			);
		});
	}
}

function escapedHolderCommand(dir: string): string {
	return [
		`echo $$ > '${dir}/group'`,
		`setsid /bin/sh -c 'echo $$ > "$1"; while [ ! -e "$2" ]; do sleep 0.01; done' sh '${dir}/holder' '${dir}/release' &`,
		`while [ ! -s '${dir}/holder' ]; do sleep 0.01; done`,
		"echo LATE-CLEANUP-OUTPUT",
		"exit 7",
	].join("\n");
}

function pidFile(dir: string, name: string): number | undefined {
	const path = `${dir}/${name}`;
	if (!fileExistsSync(path)) return undefined;
	const pid = Number(readTextSync(path, "utf8").trim());
	return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		assert.equal((error as NodeJS.ErrnoException).code, "ESRCH");
		return false;
	}
}

async function waitFor<T>(poll: () => T | undefined, limitMs: number, failure: string): Promise<T> {
	const deadline = Date.now() + limitMs;
	for (;;) {
		const value = poll();
		if (value !== undefined) return value;
		assert.ok(Date.now() < deadline, failure);
		await sleep(POLL_MS);
	}
}

function settle(promise: Promise<unknown>): Promise<unknown> {
	return promise.then(
		() => undefined,
		(reason: unknown) => reason,
	);
}

function within<T>(promise: Promise<T>, limitMs: number, failure: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expired = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error(failure)), limitMs);
	});
	return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

test.runIf(process.platform === "linux")(
	"a command admission waiting while the first permit's process bind is pending is bounded once that permit is stored (#4338)",
	async () => {
		const dir = makeTempDirectory("atomic-bind-admission-");
		const gate = deferred();
		const bindEntered = deferred();
		const quarantine = deferred<TaskId>();
		const admission = new GatedBindAdmission(gate.promise, bindEntered.resolve);
		const host = new AgentTaskHost({
			scope: { kind: "session", sessionId: randomUUID() },
			authorizeLaunch() {},
			resourceAdmission: admission,
			onTaskCleanupQuarantined: (ref) => quarantine.resolve(ref.taskId),
		});
		const { supervisor, owner } = host.ownerBinding;
		const launch = (command: string, limitMs: number) =>
			supervisor.startCommandTask(
				owner,
				{ kind: "command", command, terminal: { kind: "pipe" } },
				randomUUID() as OperationId,
				AbortSignal.timeout(limitMs),
			);
		const pending: Array<Promise<unknown>> = [];
		try {
			const first = launch(escapedHolderCommand(dir), FIRST_LAUNCH_LIMIT_MS);
			pending.push(settle(first));
			await within(bindEntered.promise, BIND_ENTRY_LIMIT_MS, "the first permit's process bind never began");
			const firstTaskId = await within(
				quarantine.promise,
				QUARANTINE_EVENT_LIMIT_MS,
				"the first command's cleanup was never quarantined",
			);

			const second = settle(launch("echo SECOND", BLOCKED_LAUNCH_LIMIT_MS));
			pending.push(second);
			await waitFor(
				() => (admission.waiting === 1 ? true : undefined),
				WAITING_LIMIT_MS,
				"the second admission never started waiting",
			);
			assert.equal(admission.held, 1);

			gate.resolve();
			const firstResult = await within(first, BIND_ENTRY_LIMIT_MS, "the first launch never finished binding");
			assert.ok(firstResult.ok);
			assert.equal(supervisor.taskReference(firstResult.value).taskId, firstTaskId);

			const error = await within(second, BLOCKED_LAUNCH_LIMIT_MS, "the second admission was never bounded");
			assert.ok(isTaskCleanupAdmissionTimeoutError(error), String(error));
			assert.equal(error.phase, "command-admission");
			assert.equal(error.timeoutMs, QUARANTINED_ADMISSION_WAIT_MS);
			assert.deepEqual(
				error.failures.map((failure) => failure.taskId),
				[firstTaskId],
			);
			assert.equal(admission.held, 1);
			assert.equal(admission.releaseCalls, 0);
			assert.equal(admission.acquired, 1);

			assert.equal(admission.bound.length, 1);
			assert.equal(admission.bound[0]?.kind, "unix-process-group");
			assert.equal(admission.bindReceivers[0], admission.permit, "bindProcess keeps the permit as its receiver");

			writeTextSync(`${dir}/release`, "");
			await waitFor(
				() => (admission.releaseCalls > 0 ? true : undefined),
				RELEASE_LIMIT_MS,
				"the confirmed cleanup never released its permit",
			);
			assert.equal(admission.held, 0);
			assert.deepEqual(admission.releaseReceivers, [undefined], "the permit is released as a standalone function");
		} finally {
			gate.resolve();
			writeTextSync(`${dir}/release`, "");
			const holder = pidFile(dir, "holder");
			if (holder !== undefined && processExists(holder)) process.kill(holder, "SIGKILL");
			try {
				await within(Promise.all(pending), FIRST_LAUNCH_LIMIT_MS, "a launch outlived its outer guard");
				const closed = await within(
					host.close("session-close"),
					CLOSE_LIMIT_MS,
					"the owner did not close within its bound",
				);
				assert.ok(closed.ok || closed.error.code === "CleanupFailed", closed.ok ? "" : closed.error.message);
			} finally {
				removeTempDirectory(dir);
			}
		}
	},
	TEST_TIMEOUT_MS,
);
