// Runs shell commands under the native task supervisor, one task owner (a session) after another, and reports the
// process's memory after each owner closes. Run with `node --expose-gc`; prints one JSON line per closed owner.
//   OWNERS    owners to run, one after another (default 5)
//   COMMANDS  pipe commands each owner runs (default 20)
//   BYTES     bytes each command prints (default 500000)
//   OPEN=1    runs every batch under one owner that stays open, as a long-lived session does, and reports after each
//   PTY=1     runs the commands on a terminal (PTY), which keeps its output in memory only: no spool
// Each line: { owner, rss, heapUsed, readBack }, where `readBack` says whether the batch's first command still reads
// back its exact output after its owner closed (or, with OPEN=1, after it settled); null for terminal commands, whose
// output a terminal reformats.
import * as native from "@bastani/atomic-natives";

const OWNERS = Number(process.env.OWNERS ?? 5);
const COMMANDS = Number(process.env.COMMANDS ?? 20);
const BYTES = Number(process.env.BYTES ?? 500_000);
const OPEN = process.env.OPEN === "1";
const PTY = process.env.PTY === "1";
const supervisor = new native.TaskSupervisor();

function openOwner() {
	const scope = { kind: "session", sessionId: crypto.randomUUID() };
	const opened = supervisor.openTaskOwner(supervisor.bindHostSession(scope), scope);
	if (!opened.ok) throw new Error(JSON.stringify(opened));
	return opened.value;
}

async function closeOwner(owner) {
	const closed = await supervisor.closeTaskOwner(owner, "session-close");
	if (!closed.ok) throw new Error(JSON.stringify(closed));
}

function expected(owner, command) {
	const line = `owner-${owner}-command-${command}\n`;
	return line.repeat(Math.ceil(BYTES / line.length)).slice(0, BYTES);
}

async function readAll(task) {
	const chunks = [];
	let start = "0";
	for (;;) {
		const page = await supervisor.readTaskOutput(task, { start, maximumBytes: 1_048_576 });
		if (!page.ok) throw new Error(JSON.stringify(page));
		for (const chunk of page.value.chunks) chunks.push(chunk.bytes);
		if (page.value.omittedRanges.length > 0) return undefined;
		if (page.value.nextOffset === undefined || page.value.nextOffset === null) break;
		start = page.value.nextOffset;
	}
	return Buffer.concat(chunks).toString("utf8");
}

const shared = OPEN ? openOwner() : undefined;
for (let owner = 0; owner < OWNERS; owner++) {
	const opened = shared ?? openOwner();
	const tasks = [];
	for (let command = 0; command < COMMANDS; command++) {
		const started = await supervisor.startCommandTask(
			opened,
			{
				kind: "command",
				command: `yes 'owner-${owner}-command-${command}' | head -c ${BYTES}`,
				terminal: PTY ? { kind: "pty", columns: 120, rows: 40 } : { kind: "pipe" },
			},
			`command-${owner}-${command}`,
		);
		if (!started.ok) throw new Error(JSON.stringify(started));
		const wait = supervisor.waitForTask(started.value, 60_000);
		if (!wait.ok) throw new Error(JSON.stringify(wait));
		const outcome = await supervisor.observeTaskWait(wait.value);
		if (!outcome.ok || outcome.value.kind !== "settled") throw new Error(JSON.stringify(outcome));
		tasks.push(started.value);
	}
	if (!OPEN) await closeOwner(opened);
	const readBack = PTY ? null : (await readAll(tasks[0])) === expected(owner, 0);
	globalThis.gc();
	globalThis.gc();
	await new Promise((resolve) => setTimeout(resolve, 100));
	const { rss, heapUsed } = process.memoryUsage();
	process.stdout.write(`${JSON.stringify({ owner, rss, heapUsed, readBack })}\n`);
}
if (shared !== undefined) await closeOwner(shared);
