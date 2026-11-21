import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";
import { prepareAgentDir, prepareInstalledPackage } from "../helpers/event-loop-guard-fixture.js";
import { startPtyProgram } from "../helpers/pty-program.js";
import { makeTempDirectory, moduleDir, sleep } from "../helpers/runtime.js";

const PACKAGE = join(moduleDir(import.meta.url), "../../packages/coding-agent");

async function once(trust: string, disableStages: boolean): Promise<Record<string, unknown>> {
	const root = makeTempDirectory("w7sm-probe-");
	const agentDir = join(root, "agent");
	const project = join(root, "project");
	const installed = join(root, "package");
	mkdirSync(project, { recursive: true });
	prepareAgentDir(agentDir, "http://127.0.0.1:9");
	prepareInstalledPackage(PACKAGE, installed);
	const trace = join(root, "trace.jsonl");
	const t0 = Date.now();
	const program = startPtyProgram({
		executable: process.execPath,
		args: [join(PACKAGE, "dist/cli.js"), "--offline", trust],
		cwd: project,
		env: {
			...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
			HOME: root,
			USERPROFILE: root,
			ATOMIC_CODING_AGENT_DIR: agentDir,
			ATOMIC_PACKAGE_DIR: installed,
			ATOMIC_SKIP_VERSION_CHECK: "1",
			ATOMIC_TELEMETRY: "0",
			ATOMIC_STARTUP_TRACE: trace,
			TERM: "xterm-256color",
			CI: "0",
			...(disableStages ? { NODE_OPTIONS: "--conditions=w7sm-probe-nostages" } : {}),
			...(process.env.W7SM_STDIN ? { NODE_OPTIONS: `--require ${JSON.stringify(join(moduleDir(import.meta.url), "../../tmpprobe/stdin-log.cjs"))}`, W7SM_STDIN_LOG: join(root, "stdin.log") } : {}),
		},
		timeoutMs: 60_000,
		cols: 100,
		rows: 30,
	});
	await program.waitForScreen((s) => s.includes("❯"), 60_000, "prompt");
	const editorAt = Date.now() - t0;
	let typedAt = -1;
	let headerAt = -1;
	let sent = 0;
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline && (typedAt < 0 || headerAt < 0)) {
		if (typedAt < 0 && sent < 1) {
			program.write("x");
			sent++;
		}
		const screen = program.screen();
		if (typedAt < 0 && screen.includes("❯ x")) typedAt = Date.now() - t0;
		if (headerAt < 0 && screen.includes("guard-model")) headerAt = Date.now() - t0;
		await sleep(5);
	}
	program.kill();
	await sleep(300);
	let marks: Record<string, number> = {};
	try {
		const lines = readFileSync(trace, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { label: string; epochMs: number; pid: number });
		const hostPid = lines.find((l) => l.label === "process-entry")?.pid;
		marks = Object.fromEntries(lines.filter((l) => l.pid === hostPid).map((l) => [l.label, Math.round(l.epochMs - t0)]));
	} catch {}
	let stdinLog = "";
	try { stdinLog = readFileSync(join(root, "stdin.log"), "utf8"); } catch {}
	return { trust, disableStages, editorAt, typedAt, headerAt, marks, stdinLog };
}

test("w7sm probe", async () => {
	const reps = process.env.W7SM_STDIN ? 1 : 4;
	for (let i = 0; i < reps; i++)
		for (const trust of ["--approve", "--no-approve"])
			for (const disable of process.env.W7SM_STDIN ? [true] : [false, true]) console.log("W7SM", JSON.stringify(await once(trust, disable)));
}, 900_000);
