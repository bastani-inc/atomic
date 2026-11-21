import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";
import { prepareAgentDir, prepareInstalledPackage } from "../helpers/event-loop-guard-fixture.js";
import { startPtyProgram } from "../helpers/pty-program.js";
import { makeTempDirectory, moduleDir, sleep } from "../helpers/runtime.js";

const PACKAGE = join(moduleDir(import.meta.url), "../../packages/coding-agent");
const KEYS = "abcdefghijklmnopqrstuvwxyz";

async function once(trust: string): Promise<Record<string, unknown>> {
	const root = makeTempDirectory("w7sm-probe-");
	const agentDir = join(root, "agent");
	const project = join(root, "project");
	const installed = join(root, "package");
	mkdirSync(project, { recursive: true });
	prepareAgentDir(agentDir, "http://127.0.0.1:9");
	prepareInstalledPackage(PACKAGE, installed);
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
			TERM: "xterm-256color",
			CI: "0",
		},
		timeoutMs: 60_000,
		cols: 100,
		rows: 30,
	});
	await program.waitForScreen((s) => s.includes("❯"), 60_000, "prompt");
	const editorAt = Date.now() - t0;
	const sentAt: number[] = [];
	const seenAt: number[] = [];
	let headerAt = -1;
	let next = 0;
	let lastSend = 0;
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline && (seenAt.length < KEYS.length || headerAt < 0)) {
		const now = Date.now();
		if (next < KEYS.length && now - lastSend >= 50) {
			program.write(KEYS[next]!);
			sentAt.push(now - t0);
			next++;
			lastSend = now;
		}
		const screen = program.screen();
		const line = screen.split("\n").find((l) => l.trimStart().startsWith("❯")) ?? "";
		const typed = line.replace(/^\s*❯\s?/, "").trim();
		while (seenAt.length < typed.length && seenAt.length < sentAt.length) seenAt.push(Date.now() - t0);
		if (headerAt < 0 && screen.includes("guard-model")) headerAt = Date.now() - t0;
		await sleep(3);
	}
	program.kill();
	const lat = seenAt.map((s, i) => s - sentAt[i]!);
	const beforeHeader = lat.filter((_, i) => sentAt[i]! < headerAt);
	return { trust, editorAt, headerAt, firstEcho: seenAt[0], maxLatBeforeHeader: Math.max(...beforeHeader), medLatBeforeHeader: beforeHeader.sort((a, b) => a - b)[Math.floor(beforeHeader.length / 2)], n: beforeHeader.length };
}

test("w7sm probe", async () => {
	for (const kb of ["512", "192", "96"]) {
		execFileSync(process.execPath, [join(PACKAGE, "scripts/write-startup-stages.mjs")], { env: { ...process.env, W7SM_STAGE_KB: kb }, stdio: "inherit" });
		for (let i = 0; i < 3; i++)
			for (const trust of ["--approve", "--no-approve"]) console.log("W7SM", kb, JSON.stringify(await once(trust)));
	}
}, 1_500_000);
