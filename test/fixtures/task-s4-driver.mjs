import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as poll } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

// RFC #2884: capture the actual tmux pane, not a redirected substitute transcript.
const { values } = parseArgs({ options: { "evidence-dir": { type: "string" }, columns: { type: "string", default: "80" }, rows: { type: "string", default: "24" } }, strict: true });
assert.ok(values["evidence-dir"], "--evidence-dir <fresh-directory> is required");
const directory = resolve(values["evidence-dir"]);
mkdirSync(dirname(directory), { recursive: true });
mkdirSync(directory);
const cwd = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const session = `task-s4-${randomUUID()}`;
const tmux = (...args) => execFileSync("tmux", args, { encoding: "utf8", timeout: 10000 });
const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`;
let started = false;
try {
	tmux("-V");
	tmux("new-session", "-d", "-s", session, "-c", cwd, "-x", values.columns, "-y", values.rows);
	started = true;
	tmux("set-option", "-t", session, "history-limit", "5000");
	tmux("set-option", "-t", session, "remain-on-exit", "on");
	const command = `exec env -u PI_CODING_AGENT_DIR -u ATOMIC_CODING_AGENT_DIR NO_COLOR=1 ATOMIC_REDUCED_MOTION=1 bun ${quote(join(cwd, "test/fixtures/task-s4-demo.ts"))} 2>${quote(join(directory, "stderr.log"))}`;
	tmux("send-keys", "-t", session, "-l", "--", command);
	tmux("send-keys", "-t", session, "Enter");
	const deadline = Date.now() + 45000;
	let capture = "";
	while (Date.now() < deadline) {
		capture = tmux("capture-pane", "-t", session, "-p", "-S", "-");
		writeFileSync(join(directory, "capture.txt"), capture);
		if (/^DEMO COMPLETE\s*$/m.test(capture)) break;
		if (tmux("display-message", "-p", "-t", session, "#{pane_dead}").trim() === "1") {
			capture = tmux("capture-pane", "-t", session, "-p", "-S", "-");
			writeFileSync(join(directory, "capture.txt"), capture);
			assert.match(capture, /^DEMO COMPLETE\s*$/m, "Demo exited before completion; inspect stderr.log");
			break;
		}
		await poll(20);
	}
	writeFileSync(join(directory, "capture.txt"), capture);
	assert.match(capture, /^DEMO COMPLETE\s*$/m);
	assert.match(capture, /PASS LIVE: MAIN anchors=1/);
	assert.match(capture, /PASS SETTLED: MAIN anchors=1/);
	assert.match(capture, /HIDDEN delta=0/);
	assert.match(capture, /tool_execution_end.*agent_end.*live background output.*settlement/);
	assert.match(capture, /background activity after agent end/);
	assert.match(capture, /Genuine peer message/);
	assert.ok(capture.includes(`PASS viewport ${values.columns}x${values.rows}: bounded host allocation`));
	for (const phase of ["LIVE", "SETTLED"]) {
			const section = capture.split(`PHASE ${phase} MAIN\n`)[1]?.split(/PHASE |PASS /)[0];
			assert.ok(section, `${phase} MAIN pane section`);
			assert.equal((section.match(/worker: S4 shared projection/g) ?? []).length, 1, `${phase} MAIN has one real anchor`);
		assert.doesNotMatch(section, /nonvisual completion/);
	}
	console.log(`PASS real ${values.columns}x${values.rows} task projection capture: ${join(directory, "capture.txt")}`);
} finally {
	if (started) tmux("kill-session", "-t", session);
}
