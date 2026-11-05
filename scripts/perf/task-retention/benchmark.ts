#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";

interface Binding {
	readonly label: string;
	readonly path: string;
}

interface Options {
	readonly bindings: readonly Binding[];
	readonly tasks: number;
	readonly checkpoints: number;
}

interface Checkpoint {
	readonly finished: number;
	readonly records: number;
	readonly snapshotBytes: number;
}

type Door<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } };
interface NativeSupervisor {
	bindHostSession(scope: object): object;
	openTaskOwner(host: object, scope: object): Door<object>;
	startAgentTask(owner: object, intent: object, operation: string): Door<object>;
	claimTaskRunner(task: object): Door<object>;
	reportRunnerOutcome(runner: object, result: object): Door<object>;
	acknowledgeTaskCleanup(runner: object, cleanup: object): Door<object>;
	watchOwnerTasks(owner: object, callback: () => void): Door<{ lease: object; snapshot: { tasks: unknown[] } }>;
	disposeSubscription(lease: object): void;
}

const DEFAULT_BINDING = resolve(import.meta.dir, "../../../packages/natives/native/index.js");

function parseOptions(argv: readonly string[]): Options {
	const values = (name: string): string[] =>
		argv.flatMap((argument, index) =>
			argument === `--${name}` && argv[index + 1] ? [argv[index + 1] as string] : [],
		);
	const bindings = values("binding").map((pair) => {
		const separator = pair.indexOf("=");
		if (separator < 1) throw new Error(`--binding expects label=path, got ${pair}`);
		return { label: pair.slice(0, separator), path: resolve(pair.slice(separator + 1)) };
	});
	return {
		bindings: bindings.length > 0 ? bindings : [{ label: "current", path: DEFAULT_BINDING }],
		tasks: Number(values("tasks")[0] ?? 5000),
		checkpoints: Number(values("checkpoints")[0] ?? 5),
	};
}

function value<T>(door: Door<T>): T {
	if (!door.ok) throw new Error(`${door.error.code}: ${door.error.message}`);
	return door.value;
}

/** Admits and fully finishes `tasks` agent tasks on one owner, counting the records its snapshot keeps. */
function measure(path: string, tasks: number, checkpoints: number): Checkpoint[] {
	const binding = createRequire(import.meta.url)(path) as { TaskSupervisor: new () => NativeSupervisor };
	const actor = new binding.TaskSupervisor();
	const scope = { kind: "session", sessionId: "task-retention-benchmark" };
	const owner = value(actor.openTaskOwner(actor.bindHostSession(scope), scope));
	const intent = { kind: "agent", agent: "worker", task: "work" };
	const every = Math.max(1, Math.floor(tasks / checkpoints));
	const results: Checkpoint[] = [];
	for (let index = 1; index <= tasks; index++) {
		const task = value(actor.startAgentTask(owner, intent, `operation-${index}`));
		const runner = value(actor.claimTaskRunner(task));
		value(actor.reportRunnerOutcome(runner, { kind: "failed", code: "Done", message: "done" }));
		value(actor.acknowledgeTaskCleanup(runner, { kind: "reaped" }));
		if (index % every !== 0 && index !== tasks) continue;
		const watch = value(actor.watchOwnerTasks(owner, () => {}));
		actor.disposeSubscription(watch.lease);
		results.push({
			finished: index,
			records: watch.snapshot.tasks.length,
			snapshotBytes: Buffer.byteLength(JSON.stringify(watch.snapshot)),
		});
	}
	return results;
}

const child = process.argv.indexOf("--child");
if (child !== -1) {
	const options = parseOptions(process.argv);
	process.stdout.write(JSON.stringify(measure(process.argv[child + 1] as string, options.tasks, options.checkpoints)));
} else {
	const options = parseOptions(process.argv);
	const rows: string[] = ["| binding | finished tasks | records kept | snapshot bytes |", "|---|---:|---:|---:|"];
	for (const binding of options.bindings) {
		// Each binding loads in its own process: two builds of one native module must not share an address space.
		const run = spawnSync(
			process.execPath,
			[
				import.meta.path,
				"--child",
				binding.path,
				"--tasks",
				String(options.tasks),
				"--checkpoints",
				String(options.checkpoints),
			],
			{ encoding: "utf8" },
		);
		if (run.status !== 0) throw new Error(`${binding.label} failed: ${run.stderr}`);
		for (const checkpoint of JSON.parse(run.stdout) as Checkpoint[])
			rows.push(
				`| ${binding.label} | ${checkpoint.finished} | ${checkpoint.records} | ${checkpoint.snapshotBytes} |`,
			);
	}
	console.log(rows.join("\n"));
}
