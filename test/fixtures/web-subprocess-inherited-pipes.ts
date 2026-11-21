import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBunSubprocess } from "../../packages/web-access/subprocess.js";
import { isGone, type RecordedProcess, recordProcess, signalRecordedProcess } from "../helpers/recorded-process.js";
import { sleep } from "../helpers/runtime.js";

const DESCENDANT_STARTUP_MS = 5_000;
const EXECUTION_TIMEOUT_MS = DESCENDANT_STARTUP_MS + 1_000;
const PIPE_CLEANUP_BOUND_MS = 5_000;
const PROCESS_EXIT_VISIBILITY_MS = 1_000;

async function bounded<T>(promise: Promise<T>, budgetMs: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => reject(new Error("pipe cleanup exceeded bound")), budgetMs);
		})]);
	} finally { clearTimeout(timer); }
}

export async function inheritedPipes(mode: "abort" | "timeout" | "overflow"): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "atomic-inherited-pipes-"));
	const ready = join(root, "ready.json");
	const controller = new AbortController();
	// The grandchild outlives the direct child and keeps both descriptors open.
	// The ready file appears by rename, never by writeFileSync: that creates the file empty before writing it, so a
	// loaded host could show this test an empty ready file and abort the child before it records the pids.
	const script = `
		const { spawn } = require('node:child_process');
		const { renameSync, writeFileSync } = require('node:fs');
		const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 1, 2] });
		child.on('spawn', () => {
			writeFileSync(${JSON.stringify(`${ready}.partial`)}, JSON.stringify([process.pid, child.pid]));
			renameSync(${JSON.stringify(`${ready}.partial`)}, ${JSON.stringify(ready)});
			${mode === "overflow" ? "process.stdout.write('x'.repeat(2048));" : ""}
		});
		setInterval(() => {}, 1000);
	`;
	const executionDeadline = Date.now() + EXECUTION_TIMEOUT_MS;
	const pending = runBunSubprocess(process.execPath, ["-e", script], {
		timeoutMs: EXECUTION_TIMEOUT_MS,
		maxStdoutBytes: 1024,
		signal: controller.signal,
	});
	const settled = pending.then(() => ({ code: "success" }), (error: Error & { code?: string }) => error);
	// #6125: recorded as soon as they record their pids, so neither the assertion nor the cleanup takes a later
	// process given one of their pids for them.
	let recorded: RecordedProcess[] = [];
	try {
		const start = Date.now();
		while (!existsSync(ready) && Date.now() - start < DESCENDANT_STARTUP_MS) await sleep(10);
		assert.ok(existsSync(ready), "descendant must inherit pipes before cancellation");
		recorded = await Promise.all((JSON.parse(readFileSync(ready, "utf8")) as number[]).map(recordProcess));
		if (mode === "abort") controller.abort();
		const remainingExecutionMs = mode === "timeout" ? Math.max(0, executionDeadline - Date.now()) : 0;
		const result = await bounded(settled, remainingExecutionMs + PIPE_CLEANUP_BOUND_MS);
		assert.equal(result.code, { abort: "ABORT_ERR", timeout: "ETIMEDOUT", overflow: "ENOBUFS" }[mode]);
		const [child] = recorded;
		assert.ok(child !== undefined);
		const exitDeadline = Date.now() + PROCESS_EXIT_VISIBILITY_MS;
		while (!(await isGone(child)) && Date.now() < exitDeadline) await sleep(10);
		assert.equal(await isGone(child), true, "direct child must exit before cleanup completes");
	} finally {
		for (const descendant of recorded) await signalRecordedProcess(descendant);
		controller.abort();
		await bounded(settled, PIPE_CLEANUP_BOUND_MS);
		rmSync(root, { recursive: true, force: true });
	}
}

if (process.argv[2] === "run") {
	for (const mode of ["abort", "timeout", "overflow"] as const) await inheritedPipes(mode);
	console.log("inherited-pipes-ok");
}
