import assert from "node:assert/strict";
import { type ChildProcess, fork } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { SqlResourceAdmission } from "../../packages/workflows/src/workers/resource-admission.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const RESTART_PROCESS_TIMEOUT_MS = 120_000;
test.skipIf(process.platform === "win32")(
	"restart retires dead owners and FIFO waiters but retains live paused owners (#3869)",
	async () => {
		const directory = makeTempDirectory("admission-restart-");
		const path = join(directory, "journal.sqlite");
		const children: ChildProcess[] = [];
		let groupId: number | undefined;
		const journal = await resolveRunJournal({ journal: { path } });
		const database = await openNodeSqliteDatabase(path);
		const launch = async (holder: string) => {
			const child = fork(
				fileURLToPath(new URL("../fixtures/admission-owner.mjs", import.meta.url)),
				[path, holder],
				{ stdio: ["ignore", "ignore", "inherit", "ipc"], execArgv: [] },
			);
			children.push(child);
			const [message] = await once(child, "message", { signal: AbortSignal.timeout(30_000) });
			if (holder === "coordinator") {
				groupId = (message as { groupId: number }).groupId;
				assert.ok(Number.isSafeInteger(groupId) && groupId > 0);
				process.kill(-groupId, "SIGSTOP");
			}
			return child;
		};
		const stop = async (child: ChildProcess) => {
			if (child.exitCode !== null || child.signalCode !== null) return;
			const exited = once(child, "exit");
			child.kill("SIGKILL");
			await exited;
		};
		const stopGroup = () => {
			if (!groupId) return;
			try {
				process.kill(-groupId, "SIGKILL");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
			}
		};
		try {
			const worker = await launch("worker");
			worker.kill("SIGSTOP");
			const coordinator = await launch("coordinator");
			await stop(coordinator);
			const replacement = await SqlResourceAdmission.open(journal, {
				root: "root",
				holder: "replacement",
				limits: { session: 2, process: 1 },
			});
			const rows = await replacement.inspect();
			assert.equal(
				rows.filter((row) => row.holder === "coordinator" && row.kind === "session" && row.state !== "released")
					.length,
				0,
			);
			assert.equal(rows.filter((row) => row.holder === "worker" && row.state === "granted").length, 1);
			assert.deepEqual(JSON.parse(rows.find((row) => row.kind === "process")!.process_identity!), {
				kind: "unix-process-group",
				id: groupId,
			});
			assert.equal(
				rows.find((row) => row.holder === "coordinator" && row.kind === "process")?.reason,
				"cleanup unconfirmed",
			);
			const release = await replacement.acquire("session", AbortSignal.timeout(5000));
			await database.run("UPDATE wf_runs_resource_owners SET expires_at = 0");
			await replacement.reconcile();
			assert.equal(
				(await replacement.inspect()).filter((row) => row.state === "granted" && row.kind === "session").length,
				2,
			);
			assert.equal(
				(await replacement.inspect()).filter((row) => row.kind === "process" && row.state === "granted").length,
				1,
			);
			process.kill(-groupId!, "SIGKILL");
			const cleanupSignal = AbortSignal.timeout(5000);
			while ((await replacement.inspect()).some((row) => row.kind === "process" && row.state === "granted")) {
				cleanupSignal.throwIfAborted();
				await replacement.reconcile();
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			groupId = undefined;
			const releaseProcess = await replacement.acquire("process", cleanupSignal);
			await releaseProcess();
			await stop(worker);
			await replacement.reconcile();
			assert.equal(
				(await replacement.inspect()).filter((row) => row.holder === "worker" && row.state === "granted").length,
				0,
			);
			await release();
			await replacement.reconcile();
			assert.equal(
				(await replacement.inspect()).filter((row) => row.kind === "session" && row.state !== "released").length,
				0,
			);
		} finally {
			stopGroup();
			await Promise.all(children.map(stop));
			await journal.close();
			await database.close();
			removeTempDirectory(directory);
		}
	},
	RESTART_PROCESS_TIMEOUT_MS,
);
