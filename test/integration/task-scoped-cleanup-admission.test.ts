import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "vitest";
import { withResourceAdmission } from "../../packages/coding-agent/src/core/resource-admission-scope.js";
import type { ResourceAdmission, ResourcePermit } from "../../packages/coding-agent/src/core/sdk-types.js";
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
const PID_FILE_LIMIT_MS = STRUCTURAL_HEADROOM_MS;
const QUARANTINE_EVENT_LIMIT_MS = TERM_AND_DRAIN_GRACE_MS + STRUCTURAL_HEADROOM_MS;
const PENDING_PROBE_MS = QUARANTINED_ADMISSION_WAIT_MS + 1_000;
const LIVE_LAUNCH_LIMIT_MS = STRUCTURAL_HEADROOM_MS;
const SCOPED_LAUNCH_LIMIT_MS = PENDING_PROBE_MS + STRUCTURAL_HEADROOM_MS;
const CLOSE_LIMIT_MS = QUARANTINE_EVENT_LIMIT_MS;
const TEST_TIMEOUT_MS =
	PID_FILE_LIMIT_MS +
	QUARANTINE_EVENT_LIMIT_MS +
	LIVE_LAUNCH_LIMIT_MS +
	SCOPED_LAUNCH_LIMIT_MS +
	CLOSE_LIMIT_MS +
	STRUCTURAL_HEADROOM_MS;
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

test.runIf(process.platform === "linux")(
	"quarantined cleanup under one admission never bounds a wait for live capacity under another the owner also uses (#4338)",
	async () => {
		const dir = makeTempDirectory("atomic-scoped-admission-");
		const quarantinedPool = new SinglePermitAdmission();
		const livePool = new SinglePermitAdmission();
		let reportQuarantine!: (taskId: TaskId) => void;
		const quarantined = within(
			new Promise<TaskId>((resolve) => {
				reportQuarantine = resolve;
			}),
			PID_FILE_LIMIT_MS + QUARANTINE_EVENT_LIMIT_MS,
			"the first command's cleanup was never quarantined",
		);
		quarantined.catch(() => undefined);
		const host = new AgentTaskHost({
			scope: { kind: "session", sessionId: randomUUID() },
			authorizeLaunch() {},
			onTaskCleanupQuarantined: (ref) => reportQuarantine(ref.taskId),
		});
		const { supervisor, owner } = host.ownerBinding;
		const launchUnder = (pool: ResourceAdmission, command: string, limitMs: number) =>
			withResourceAdmission(pool, () =>
				supervisor.startCommandTask(
					owner,
					{ kind: "command", command, terminal: { kind: "pipe" } },
					randomUUID() as OperationId,
					AbortSignal.timeout(limitMs),
				),
			);
		const pending: Array<Promise<unknown>> = [];
		try {
			const holder = await launchUnder(quarantinedPool, escapedHolderCommand(dir), LIVE_LAUNCH_LIMIT_MS);
			assert.ok(holder.ok);
			await waitFor(() => pidFile(dir, "holder"), PID_FILE_LIMIT_MS, "the command started no holder");
			await quarantined;
			assert.equal(quarantinedPool.held, 1);

			const live = await launchUnder(
				livePool,
				`while [ ! -e '${dir}/finish' ]; do sleep 0.05; done; echo LIVE`,
				LIVE_LAUNCH_LIMIT_MS,
			);
			assert.ok(live.ok);
			assert.equal(livePool.held, 1);

			const second = settle(launchUnder(livePool, "echo SECOND", SCOPED_LAUNCH_LIMIT_MS));
			pending.push(second);
			const probe = await Promise.race([second, sleep(PENDING_PROBE_MS).then(() => "still waiting")]);
			assert.equal(probe, "still waiting", "live capacity of another admission is waited for without a timeout");
			assert.equal(quarantinedPool.held, 1);
			assert.equal(quarantinedPool.releaseCalls, 0);

			writeTextSync(`${dir}/finish`, "");
			assert.equal(await second, undefined, "the second command was admitted once the live one finished");
			assert.equal(livePool.acquired, 2);
			assert.equal(quarantinedPool.held, 1);
			assert.equal(quarantinedPool.releaseCalls, 0);
			assert.equal(quarantinedPool.acquired, 1);
		} finally {
			writeTextSync(`${dir}/release`, "");
			writeTextSync(`${dir}/finish`, "");
			const holderPid = pidFile(dir, "holder");
			if (holderPid !== undefined && processExists(holderPid)) process.kill(holderPid, "SIGKILL");
			try {
				await within(Promise.all(pending), SCOPED_LAUNCH_LIMIT_MS, "a launch outlived its outer guard");
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
