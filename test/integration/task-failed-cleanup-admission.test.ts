import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { isRetryableTaskError, isTaskCleanupAdmissionTimeoutError } from "@bastani/atomic";
import { test } from "vitest";
import type { ResourceAdmission, ResourcePermit } from "../../packages/coding-agent/src/core/sdk-types.js";
import { AgentTaskHost } from "../../packages/coding-agent/src/core/tasks/agent-adapter.js";
import type { OperationId } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { QUARANTINED_ADMISSION_WAIT_MS } from "../../packages/coding-agent/src/core/tasks/supervisor.js";
import { fileExistsSync, makeTempDirectory, readTextSync, removeTempDirectory, sleep } from "../helpers/runtime.js";

const TERM_AND_DRAIN_GRACE_MS = 2_250;
const STOP_QUARANTINE_BOUND_MS = 15_000;
const STRUCTURAL_HEADROOM_MS = 10_000;
const PID_FILE_LIMIT_MS = STRUCTURAL_HEADROOM_MS;
const FAILED_CLEANUP_LIMIT_MS = TERM_AND_DRAIN_GRACE_MS + STOP_QUARANTINE_BOUND_MS + STRUCTURAL_HEADROOM_MS;
const BLOCKED_LAUNCH_LIMIT_MS = QUARANTINED_ADMISSION_WAIT_MS + STRUCTURAL_HEADROOM_MS;
const CLOSE_LIMIT_MS = STOP_QUARANTINE_BOUND_MS + STRUCTURAL_HEADROOM_MS;
const TEST_TIMEOUT_MS =
	PID_FILE_LIMIT_MS + FAILED_CLEANUP_LIMIT_MS + BLOCKED_LAUNCH_LIMIT_MS + CLOSE_LIMIT_MS + STRUCTURAL_HEADROOM_MS;
const POLL_MS = 50;

class SinglePermitAdmission implements ResourceAdmission {
	held = 0;
	acquired = 0;
	releaseCalls = 0;
	private readonly waiters: Array<() => void> = [];
	acquire(_kind: "session" | "process", signal?: AbortSignal): Promise<ResourcePermit> {
		if (signal?.aborted) return Promise.reject(signal.reason);
		return new Promise((resolve, reject) => {
			const grant = () => {
				this.held++;
				this.acquired++;
				let released = false;
				resolve(async () => {
					this.releaseCalls++;
					if (released) return;
					released = true;
					this.held--;
					this.waiters.shift()?.();
				});
			};
			if (this.held < 1) return grant();
			this.waiters.push(grant);
			signal?.addEventListener(
				"abort",
				() => {
					const index = this.waiters.indexOf(grant);
					if (index < 0) return;
					this.waiters.splice(index, 1);
					reject(signal.reason);
				},
				{ once: true },
			);
		});
	}
}

function leaderStaysRunningCommand(dir: string): string {
	return [
		`echo $$ > '${dir}/group'`,
		`setsid /bin/sh -c 'echo $$ > "$1"; while [ ! -e "$2" ]; do sleep 0.01; done' sh '${dir}/holder' '${dir}/release' &`,
		`while [ ! -s '${dir}/holder' ]; do sleep 0.01; done`,
		"exec sleep 300",
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

function killIfAlive(pid: number | undefined): void {
	if (pid !== undefined && processExists(pid)) process.kill(pid, "SIGKILL");
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

test.runIf(process.platform === "linux")(
	"a command admission behind failed cleanup of a still-open owner times out naming the failed resource and keeps the permit (#4338)",
	async () => {
		const dir = makeTempDirectory("atomic-failed-admission-");
		const admission = new SinglePermitAdmission();
		const host = new AgentTaskHost({
			scope: { kind: "session", sessionId: randomUUID() },
			authorizeLaunch() {},
			resourceAdmission: admission,
		});
		const { supervisor, owner } = host.ownerBinding;
		const launch = (command: string) =>
			supervisor.startCommandTask(
				owner,
				{ kind: "command", command, terminal: { kind: "pipe" } },
				randomUUID() as OperationId,
				AbortSignal.timeout(BLOCKED_LAUNCH_LIMIT_MS),
			);
		try {
			const first = await launch(leaderStaysRunningCommand(dir));
			assert.ok(first.ok);
			const taskId = supervisor.taskReference(first.value).taskId;
			const group = await waitFor(() => pidFile(dir, "group"), PID_FILE_LIMIT_MS, "the command recorded no group");
			await waitFor(() => pidFile(dir, "holder"), PID_FILE_LIMIT_MS, "the command started no holder");

			const cancelled = await supervisor.cancelTask(first.value, "user");
			assert.ok(cancelled.ok);
			assert.equal(cancelled.value.decision, "cancellation-requested");

			const failures = await waitFor(
				() => {
					const failed = supervisor.failedTaskCleanups(owner);
					return failed.length > 0 ? failed : undefined;
				},
				FAILED_CLEANUP_LIMIT_MS,
				"the stopped command's cleanup never failed",
			);
			assert.deepEqual(
				failures.map((failure) => ({
					taskId: failure.taskId,
					resources: failure.resources.map(({ resource, code }) => ({ resource, code })),
				})),
				[{ taskId, resources: [{ resource: `process-group:${group}`, code: "CleanupFailed" }] }],
			);
			assert.equal(admission.held, 1);

			const error = await settle(launch("echo SECOND"));
			assert.ok(isTaskCleanupAdmissionTimeoutError(error), String(error));
			assert.equal(error.phase, "command-admission");
			assert.equal(error.timeoutMs, QUARANTINED_ADMISSION_WAIT_MS);
			assert.equal(isRetryableTaskError(error), true);
			assert.deepEqual(error.failures, failures);
			assert.equal(admission.held, 1);
			assert.equal(admission.releaseCalls, 0);
			assert.equal(admission.acquired, 1);
		} finally {
			killIfAlive(pidFile(dir, "holder"));
			const group = pidFile(dir, "group");
			if (group !== undefined && processExists(-group)) process.kill(-group, "SIGKILL");
			try {
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
