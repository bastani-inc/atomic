import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import { moduleDir, readStreamText, sleep, spawnProcess, spawnSyncCollect } from "../helpers/runtime.js";

const scripts = resolve(moduleDir(import.meta.url), "../../packages/subagents/skills/tmux/scripts");
/** The wait an invalid pattern must not sit out; failing at once has to take well under half of it. */
const INVALID_PATTERN_TIMEOUT_S = 10;
const INVALID_PATTERN_FAIL_FAST_MS = (INVALID_PATTERN_TIMEOUT_S * 1000) / 2;

// A stand-in for tmux that answers only what the skill's helper scripts call. `list-sessions -F` expands the three
// format variables the way tmux does (an unknown variable becomes empty, `\t` stays literal) for each
// `name|attached|created` row of STUB_SESSIONS; `capture-pane` prints STUB_PANE, or fails when STUB_CAPTURE_FAIL is set.
const STUB_TMUX = `#!/usr/bin/env bash
mode=""
format=""
socket=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    list-sessions) mode=list ;;
    capture-pane) mode=capture ;;
    -F) format="$2"; shift ;;
    -S) socket="$2"; shift ;;
  esac
  shift
done
if [[ "$mode" == capture ]]; then
  [[ -n "\${STUB_CAPTURE_FAIL:-}" ]] && exit 1
  printf '%s\\n' "\${STUB_PANE:-}"
  exit 0
fi
if [[ "$mode" == list ]]; then
  while IFS='|' read -r name attached created; do
    [[ -z "$name" ]] && continue
    [[ -n "$socket" ]] && name="$name@\${socket##*/}"
    line="$format"
    line="\${line//'#{session_name}'/$name}"
    line="\${line//'#{session_attached}'/$attached}"
    line="\${line//'#{t:session_created}'/$created}"
    line="\${line//'#{session_created_string}'/}"
    printf '%s\\n' "$line"
  done <<< "\${STUB_SESSIONS:-}"
  exit 0
fi
exit 1
`;

let dir: string;
let stubBin: string;
const servers: Server[] = [];
const socketDirs: string[] = [];

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "atomic-tmux-skill-"));
	stubBin = join(dir, "bin");
	mkdirSync(stubBin);
	writeFileSync(join(stubBin, "tmux"), STUB_TMUX);
	chmodSync(join(stubBin, "tmux"), 0o755);
});

afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
	rmSync(dir, { recursive: true, force: true });
	for (const socketDir of socketDirs.splice(0)) rmSync(socketDir, { recursive: true, force: true });
});

function run(script: string, args: readonly string[], env: Record<string, string> = {}) {
	const started = performance.now();
	const result = spawnSyncCollect(["bash", join(scripts, script), ...args], {
		env: { PATH: `${stubBin}:${process.env.PATH ?? ""}`, HOME: dir, TMPDIR: dir, ...env },
		timeout: 20_000,
	});
	return {
		exitCode: result.exitCode,
		signalCode: result.signalCode,
		stdout: result.stdout.toString(),
		stderr: result.stderr.toString(),
		elapsedMs: performance.now() - started,
	};
}

/** Start a script without waiting for it; `detached` gives it its own process group, as a terminal or runner does. */
function start(argv: readonly string[], env: Record<string, string> = {}, detached = false) {
	const child = spawnProcess(argv, {
		env: { PATH: `${stubBin}:${process.env.PATH ?? ""}`, HOME: dir, TMPDIR: dir, ...env },
		stdout: "pipe",
		stderr: "pipe",
		detached,
	});
	// Resolves when every process holding the script's output has let go of it.
	const output = Promise.all([readStreamText(child.stdout), readStreamText(child.stderr)]);
	return { child, output };
}

/** Replace the stand-in tmux with one that also counts its pane captures in $HOME/captures. */
function countCaptures(): () => number {
	const log = join(dir, "captures");
	writeFileSync(
		join(stubBin, "tmux"),
		`#!/usr/bin/env bash\necho capture >>"$HOME/captures"\nprintf '%s\\n' "\${STUB_PANE:-}"\n`,
	);
	return () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).length : 0);
}

async function until(condition: () => boolean): Promise<void> {
	const deadline = performance.now() + 10_000;
	while (!condition()) {
		if (performance.now() > deadline) throw new Error("timed out waiting for the condition");
		await sleep(20);
	}
}

async function listen(path: string): Promise<void> {
	const server = createServer();
	servers.push(server);
	await new Promise<void>((done) => server.listen(path, done));
}

describe.skipIf(process.platform === "win32")("bundled tmux skill helper scripts", () => {
	test("find-sessions reports each session's state and start time from tab-separated fields", () => {
		const { exitCode, stdout } = run("find-sessions.sh", [], {
			STUB_SESSIONS: "build1|0|Wed Nov 18 10:00:00 2026\nreview|2|Wed Nov 18 11:00:00 2026",
		});
		assert.equal(exitCode, 0);
		assert.match(stdout, /^ {2}- build1 \(detached, started Wed Nov 18 10:00:00 2026\)$/mu);
		// Two clients attached is still attached.
		assert.match(stdout, /^ {2}- review \(attached, started Wed Nov 18 11:00:00 2026\)$/mu);
	});

	test("find-sessions matches a query literally against session names only", () => {
		const { exitCode, stdout } = run("find-sessions.sh", ["-q", "BUILD[1]"], {
			STUB_SESSIONS: "build1|0|t1\nbuild[1]-ci|0|t2",
		});
		assert.equal(exitCode, 0);
		assert.match(stdout, /- build\[1\]-ci /u);
		assert.doesNotMatch(stdout, /- build1 /u);
	});

	test("find-sessions --all scans hidden sockets too", async () => {
		// Socket paths are limited to about 100 bytes, so keep this directory short whatever TMPDIR is.
		const socketDir = mkdtempSync("/tmp/ats-");
		socketDirs.push(socketDir);
		await listen(join(socketDir, "visible"));
		await listen(join(socketDir, ".hidden"));
		const { exitCode, stdout } = run("find-sessions.sh", ["-A"], {
			ATOMIC_TMUX_SOCKET_DIR: socketDir,
			STUB_SESSIONS: "work|0|t",
		});
		assert.equal(exitCode, 0);
		assert.match(stdout, /- work@visible /u);
		assert.match(stdout, /- work@\.hidden /u);
	});

	test("wait-for-text accepts a zero-padded decimal timeout", () => {
		const { exitCode, stderr } = run("wait-for-text.sh", ["-t", "s:0.0", "-p", "ready", "-T", "08"], {
			STUB_PANE: "server ready",
		});
		assert.equal(exitCode, 0, stderr);
		// The old script matched here too, after bash had already rejected `08` as an octal number.
		assert.doesNotMatch(stderr, /value too great|unbound variable/u);
		// A pane that never matches must time out normally, not fail on the timeout's arithmetic.
		const late = run("wait-for-text.sh", ["-t", "s:0.0", "-p", "ready", "-T", "01", "-i", "0.2"], {
			STUB_PANE: "still starting",
		});
		assert.equal(late.exitCode, 1);
		assert.match(late.stderr, /^Timed out after 01s waiting for pattern: ready$/mu);
		assert.doesNotMatch(late.stderr, /unbound variable|value too great/u);
	});

	test("wait-for-text times out when a pending capture delivers a late marker (#5566)", () => {
		const socketDir = mkdtempSync("/tmp/ats-");
		socketDirs.push(socketDir);
		const socket = join(socketDir, "server");
		const realTmux = spawnSyncCollect(["bash", "-c", "command -v tmux"]).stdout.toString().trim();
		const tmux = (...args: string[]) => spawnSyncCollect([realTmux, "-S", socket, ...args]);
		try {
			if (realTmux) {
				const pane = tmux(
					"-f",
					"/dev/null",
					"new-session",
					"-d",
					"-s",
					"probe",
					"tmux wait-for release; printf 'late-marker\\n'; tmux wait-for -S printed; exec cat",
				);
				assert.equal(pane.exitCode, 0, pane.stderr.toString());
			}
			// The producer cannot print until two seconds into the first capture. On hosts without
			// tmux the stand-in delivers the same marker, still through the real wait script.
			writeFileSync(
				join(stubBin, "tmux"),
				`#!/usr/bin/env bash
sleep 2
if [[ -z "$REAL_TMUX" ]]; then echo late-marker; exit 0; fi
"$REAL_TMUX" -S "$SOCKET" wait-for -S release
"$REAL_TMUX" -S "$SOCKET" wait-for printed
exec "$REAL_TMUX" -S "$SOCKET" "$@"
`,
			);
			const result = run("wait-for-text.sh", ["-t", "probe:0.0", "-p", "late-marker", "-T", "1"], {
				REAL_TMUX: realTmux,
				SOCKET: socket,
			});
			assert.equal(result.exitCode, 1, result.stderr);
			assert.match(result.stderr, /^Timed out after 1s waiting for pattern: late-marker$/mu);
		} finally {
			if (realTmux) tmux("kill-server");
		}
	});

	test("wait-for-text returns at the deadline when a capture's child holds its output open (#5566)", () => {
		writeFileSync(join(stubBin, "tmux"), '#!/bin/sh\n: >"$HOME/capturing"\nsleep 4\necho OK\n');
		const result = run("wait-for-text.sh", ["-t", "s", "-F", "-p", "OK", "-T", "1"]);
		assert.ok(existsSync(join(dir, "capturing")));
		assert.equal(result.exitCode, 1, result.stderr);
		assert.match(result.stderr, /Timed out after 1s/u);
		assert.equal(result.stdout, "");
		assert.ok(result.elapsedMs < 3_000, `output stayed open for ${Math.round(result.elapsedMs)} ms`);
	});

	test.each(["SIGTERM", "SIGHUP"] as const)(
		"wait-for-text can be reaped after %s while a capture's child holds the pipe (#5566)",
		async (signal) => {
			writeFileSync(join(stubBin, "tmux"), '#!/bin/sh\n: >"$HOME/capturing"\nsleep 4\necho OK\n');
			const child = spawn("bash", [join(scripts, "wait-for-text.sh"), "-t", "s", "-F", "-p", "OK", "-T", "8"], {
				env: { ...process.env, PATH: `${stubBin}:${process.env.PATH}`, HOME: dir },
			});
			// 'exit' observes waitpid; 'close' also waits for inherited output pipes.
			const exited = once(child, "exit");
			const closed = once(child, "close");
			await until(() => existsSync(join(dir, "capturing")));
			const sent = performance.now();
			child.kill(signal);
			const [code, reason] = await exited;
			const exitMs = performance.now() - sent;
			await closed;
			assert.equal(code, null);
			assert.equal(reason, signal);
			assert.ok(exitMs < 2_500, `could not reap the helper for ${Math.round(exitMs)} ms`);
		},
	);

	test("wait-for-text includes a stalled pattern check in its timeout (#5566)", () => {
		const grepPath = join(stubBin, "grep");
		writeFileSync(
			grepPath,
			'#!/bin/sh\nif [ ! -f "$HOME/checked" ]; then touch "$HOME/checked"; sleep 6; fi\nexec /usr/bin/grep "$@"\n',
		);
		chmodSync(grepPath, 0o755);
		const result = run("wait-for-text.sh", ["-t", "s", "-F", "-p", "ready", "-T", "1"], { STUB_PANE: "ready" });
		assert.equal(result.exitCode, 1, result.stderr);
		assert.match(result.stderr, /Timed out after 1s/u);
		assert.ok(result.elapsedMs < 5_000, `took ${Math.round(result.elapsedMs)} ms`);
	});

	test("wait-for-text does not restart its timeout after a slow timer check (#5566)", () => {
		const sleepPath = join(stubBin, "sleep");
		writeFileSync(sleepPath, '#!/bin/sh\nif [ "$1" = 0.0 ]; then /bin/sleep 6; fi\nexec /bin/sleep "$@"\n');
		chmodSync(sleepPath, 0o755);
		const result = run("wait-for-text.sh", ["-t", "s", "-F", "-p", "ready", "-T", "1"], { STUB_PANE: "ready" });
		assert.equal(result.exitCode, 1, result.stderr);
		assert.match(result.stderr, /Timed out after 1s/u);
		assert.ok(result.elapsedMs < 5_000, `took ${Math.round(result.elapsedMs)} ms`);
	});

	test("wait-for-text refuses to poll without a fractional sleep timer (#5566)", () => {
		const sleepPath = join(stubBin, "sleep");
		writeFileSync(sleepPath, '#!/bin/sh\ncase "$1" in *.*) exit 1 ;; esac\nexec /bin/sleep "$@"\n');
		chmodSync(sleepPath, 0o755);
		const result = run("wait-for-text.sh", ["-t", "s", "-p", "ready"], { STUB_PANE: "ready" });
		assert.notEqual(result.exitCode, 0);
		assert.match(result.stderr, /sleep.*fractional seconds/u);
	});

	test("wait-for-text does not wrap a long decimal timeout into an expired deadline (#5566)", () => {
		const result = run("wait-for-text.sh", ["-t", "s", "-p", "ready", "-T", "18446744073709551616"], {
			STUB_PANE: "ready",
		});
		assert.equal(result.exitCode, 0, result.stderr);
	});

	test("wait-for-text does not capture even a matching pane with a zero timeout (#5566)", () => {
		writeFileSync(join(stubBin, "tmux"), '#!/usr/bin/env bash\ntouch "$HOME/probed"\necho ready\n');
		const result = run("wait-for-text.sh", ["-t", "s", "-p", "ready", "-T", "0"]);
		assert.equal(result.exitCode, 1);
		assert.match(result.stderr, /Timed out after 0s/u);
		assert.equal(existsSync(join(dir, "probed")), false);
	});

	test("wait-for-text times out with the last capture when the next one stalls (#5566)", () => {
		writeFileSync(
			join(stubBin, "tmux"),
			`#!/usr/bin/env bash
if [[ -f "$HOME/probed" ]]; then exec sleep 60; fi
touch "$HOME/probed"
echo working
`,
		);
		const result = run("wait-for-text.sh", ["-t", "s", "-p", "ready", "-T", "1", "-i", "0.01"]);
		assert.equal(result.exitCode, 1);
		assert.match(result.stderr, /Timed out after 1s[\s\S]*Last 1000 lines from s:\nworking/u);
	});

	test("wait-for-text keeps the last complete snapshot when a replacement is interrupted (#5566)", () => {
		// The replacement prints part of the pane, then stalls until the deadline cuts it off.
		writeFileSync(
			join(stubBin, "tmux"),
			'#!/bin/sh\nif [ -f "$HOME/probed" ]; then yes incomplete | head -n 600; exec sleep 60; fi\ntouch "$HOME/probed"; echo working\n',
		);
		const result = run("wait-for-text.sh", ["-t", "s", "-p", "ready", "-T", "1", "-i", "0.01"]);
		assert.equal(result.exitCode, 1);
		assert.match(result.stderr, /Last 1000 lines from s:\nworking\n$/u);
	});

	test("wait-for-text leaves nothing behind when interrupted as it starts (#5566)", () => {
		const bashEnv = join(dir, "interrupt-start");
		const tmp = join(dir, "tmp");
		mkdirSync(tmp);
		writeFileSync(
			bashEnv,
			`trap 'if [[ $BASH_COMMAND == "exec 3< <(watch_pane)" && ! -f $HOME/interrupted ]]; then touch "$HOME/interrupted"; builtin kill -TERM "$$"; fi' DEBUG\n`,
		);
		const result = run("wait-for-text.sh", ["-t", "s", "-p", "ready", "-T", "8"], { BASH_ENV: bashEnv, TMPDIR: tmp });
		assert.ok(existsSync(join(dir, "interrupted")));
		assert.equal(result.signalCode, "SIGTERM");
		assert.ok(result.elapsedMs < 6_000, `took ${Math.round(result.elapsedMs)} ms`);
		assert.deepEqual(readdirSync(tmp), []);
	});

	test("wait-for-text cancels its worker even if interrupted during launch (#5566)", () => {
		const bashEnv = join(dir, "interrupt-launch");
		// Interrupt this shell once its worker exists but before it records the PID, and again
		// when it asks the worker to stop.
		writeFileSync(
			bashEnv,
			`
interrupt() { if [[ $BASH_COMMAND == 'worker=$!' && ! -f "$HOME/interrupted" ]]; then touch "$HOME/interrupted"; builtin kill -TERM "$$"; fi; }
kill() {
  if [[ $1 == -TERM && -n \${worker:-} && ! -f "$HOME/interrupted-again" ]]; then touch "$HOME/interrupted-again"; builtin kill -HUP "$$"; fi
  builtin kill "$@"
}
trap interrupt DEBUG
`,
		);
		const result = run("wait-for-text.sh", ["-t", "s", "-p", "missing", "-T", "8"], { BASH_ENV: bashEnv });
		assert.ok(existsSync(join(dir, "interrupted")));
		assert.ok(existsSync(join(dir, "interrupted-again")));
		assert.notEqual(result.exitCode, 0);
		assert.ok(result.elapsedMs < 6_000, `worker still held the pipes for ${Math.round(result.elapsedMs)} ms`);
	});

	test("wait-for-text stops a running capture when interrupted during it (#5566)", () => {
		const bashEnv = join(dir, "interrupt-capture");
		writeFileSync(bashEnv, `tmux() { builtin kill -TERM "$$"; exec /bin/sleep 8; }\n`);
		const result = run("wait-for-text.sh", ["-t", "s", "-p", "missing", "-T", "8"], { BASH_ENV: bashEnv });
		assert.notEqual(result.exitCode, 0);
		assert.ok(result.elapsedMs < 6_000, `capture still held the pipes for ${Math.round(result.elapsedMs)} ms`);
	});

	test("wait-for-text does not poll after cancellation races worker startup (#5566)", () => {
		const bashEnv = join(dir, "interrupt-launch");
		// Hold the worker at startup until it has been asked to stop: it must not poll after that.
		writeFileSync(
			bashEnv,
			`
interrupt() {
  if [[ $BASH_COMMAND == 'worker=$!' && ! -f "$HOME/interrupted" ]]; then
    touch "$HOME/interrupted"; builtin kill -TERM "$$"
  elif [[ $BASH_COMMAND == 'timer=$!' ]]; then
    while [[ ! -f "$HOME/delivered" ]]; do /bin/sleep .01; done
  fi
}
kill() { if [[ $1 == -TERM && -n \${worker:-} ]]; then touch "$HOME/delivered"; fi; builtin kill "$@"; }
set -T
trap interrupt DEBUG
`,
		);
		writeFileSync(join(stubBin, "tmux"), '#!/bin/sh\ntouch "$HOME/probed"\n');
		const result = run("wait-for-text.sh", ["-t", "s", "-p", "missing", "-T", "8"], { BASH_ENV: bashEnv });
		assert.ok(existsSync(join(dir, "interrupted")));
		assert.ok(existsSync(join(dir, "delivered")));
		assert.equal(existsSync(join(dir, "probed")), false);
		assert.notEqual(result.exitCode, 0);
		assert.ok(result.elapsedMs < 6_000, `worker still held the pipes for ${Math.round(result.elapsedMs)} ms`);
	});

	test("wait-for-text finds a marker on screen when TMPDIR is missing or full (#5566)", () => {
		const missing = run("wait-for-text.sh", ["-t", "s", "-F", "-p", "DONE", "-T", "3"], {
			STUB_PANE: "build DONE",
			TMPDIR: join(dir, "missing"),
		});
		assert.equal(missing.exitCode, 0, missing.stderr);
		// No file can grow, as on a full disk.
		const bashEnv = join(dir, "no-space");
		writeFileSync(bashEnv, "ulimit -f 0\n");
		const full = run("wait-for-text.sh", ["-t", "s", "-F", "-p", "DONE", "-T", "3"], {
			STUB_PANE: "build DONE",
			BASH_ENV: bashEnv,
		});
		assert.equal(full.exitCode, 0, full.stderr);
	});

	test("wait-for-text interrupted by Ctrl-C stops the script that called it (#5566)", async () => {
		const captures = countCaptures();
		const caller = join(dir, "caller.sh");
		writeFileSync(
			caller,
			'for i in 1 2 3; do bash "$1" -t s -F -p never -T 3 -i 0.1; echo "continued after wait $i"; done\n',
		);
		const { child, output } = start(
			["bash", caller, join(scripts, "wait-for-text.sh")],
			{ STUB_PANE: "working" },
			true,
		);
		await until(() => captures() > 0);
		// A terminal sends Ctrl-C to its whole foreground process group.
		process.kill(-(child.pid as number), "SIGINT");
		const [stdout] = await output;
		await child.exited;
		assert.equal(child.signalCode, "SIGINT");
		assert.doesNotMatch(stdout, /continued/u);
	});

	test("wait-for-text leaves nothing running or behind when its process group is killed (#5566)", async () => {
		const captures = countCaptures();
		const tmp = join(dir, "tmp");
		mkdirSync(tmp);
		const { child, output } = start(
			["bash", join(scripts, "wait-for-text.sh"), "-t", "s", "-F", "-p", "never", "-T", "8", "-i", "0.1"],
			{ STUB_PANE: "working", TMPDIR: tmp },
			true,
		);
		await until(() => captures() > 0);
		const killedAt = performance.now();
		process.kill(-(child.pid as number), "SIGKILL");
		await output;
		const openFor = performance.now() - killedAt;
		await child.exited;
		const capturesAtClose = captures();
		await sleep(1_000);
		assert.ok(openFor < 3_000, `its output stayed open ${Math.round(openFor)} ms after the kill`);
		assert.equal(captures(), capturesAtClose, "it kept capturing the pane after the kill");
		assert.deepEqual(readdirSync(tmp), []);
	});

	test("wait-for-text stops polling soon after the helper alone is killed (#5566)", async () => {
		const captures = countCaptures();
		const { child, output } = start(
			["bash", join(scripts, "wait-for-text.sh"), "-t", "s", "-F", "-p", "never", "-T", "8", "-i", "0.1"],
			{ STUB_PANE: "working" },
		);
		await until(() => captures() > 0);
		const killedAt = performance.now();
		child.kill("SIGKILL");
		await output;
		const openFor = performance.now() - killedAt;
		await child.exited;
		const capturesAtClose = captures();
		await sleep(1_000);
		assert.ok(openFor < 3_000, `its output stayed open ${Math.round(openFor)} ms after the kill`);
		assert.equal(captures(), capturesAtClose, "it kept capturing the pane after the kill");
	});

	test("wait-for-text ends by the signal that stopped it (#5566)", async () => {
		for (const signal of ["SIGTERM", "SIGHUP"] as const) {
			rmSync(join(dir, "captures"), { force: true });
			const captures = countCaptures();
			const { child, output } = start(
				["bash", join(scripts, "wait-for-text.sh"), "-t", "s", "-F", "-p", "never", "-T", "8", "-i", "0.1"],
				{ STUB_PANE: "working" },
			);
			await until(() => captures() > 0);
			child.kill(signal);
			await output;
			await child.exited;
			assert.equal(child.signalCode, signal);
		}
	});

	test("wait-for-text never counts a failed pane capture as a match", () => {
		const { exitCode } = run("wait-for-text.sh", ["-t", "gone:0.0", "-p", "^$", "-T", "1", "-i", "0.2"], {
			STUB_CAPTURE_FAIL: "1",
		});
		assert.notEqual(exitCode, 0);
	});

	test("wait-for-text preserves grep's error status even without tmux (#5566)", () => {
		rmSync(join(stubBin, "tmux"));
		for (const name of ["bash", "grep", "awk", "sleep", "perl"]) {
			const path = spawnSyncCollect(["bash", "-c", `command -v ${name}`])
				.stdout.toString()
				.trim();
			if (path) symlinkSync(path, join(stubBin, name));
		}
		const args = ["-t", "s", "-p", "[", "-T", "3"];
		const invalid = run("wait-for-text.sh", args, { PATH: stubBin });
		assert.equal(invalid.exitCode, 2, invalid.stderr);
		assert.match(invalid.stderr, /grep/u);
		// These are also valid command exit statuses, not necessarily a timeout or timer failure.
		for (const code of [124, 125]) {
			rmSync(join(stubBin, "grep"));
			writeFileSync(join(stubBin, "grep"), `#!/bin/sh\nexit ${code}\n`, { mode: 0o755 });
			assert.equal(run("wait-for-text.sh", args, { PATH: stubBin }).exitCode, code);
		}
	});

	test("wait-for-text rejects an invalid pattern at once instead of waiting out the timeout", () => {
		const { exitCode, elapsedMs } = run(
			"wait-for-text.sh",
			["-t", "s:0.0", "-p", "[", "-T", String(INVALID_PATTERN_TIMEOUT_S)],
			{ STUB_PANE: "anything" },
		);
		assert.notEqual(exitCode, 0);
		assert.ok(elapsedMs < INVALID_PATTERN_FAIL_FAST_MS, `took ${Math.round(elapsedMs)} ms`);
	});
});
