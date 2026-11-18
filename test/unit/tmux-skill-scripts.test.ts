import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import { moduleDir, spawnSyncCollect } from "../helpers/runtime.js";

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
		stdout: result.stdout.toString(),
		stderr: result.stderr.toString(),
		elapsedMs: performance.now() - started,
	};
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

	test("wait-for-text never counts a failed pane capture as a match", () => {
		const { exitCode } = run("wait-for-text.sh", ["-t", "gone:0.0", "-p", "^$", "-T", "1", "-i", "0.2"], {
			STUB_CAPTURE_FAIL: "1",
		});
		assert.notEqual(exitCode, 0);
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
