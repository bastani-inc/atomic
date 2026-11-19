import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";
import { removeTempRootReleasingBroker } from "../helpers/detached-broker.js";
import { prepareAgentDir, prepareInstalledPackage } from "../helpers/event-loop-guard-fixture.js";
import { type PtyProgram, startPtyProgram } from "../helpers/pty-program.js";
import { makeTempDirectory, moduleDir } from "../helpers/runtime.js";

const PACKAGE = join(moduleDir(import.meta.url), "../../packages/coding-agent");
const EXTENSION = join(moduleDir(import.meta.url), "../fixtures/wheel-routing.mjs");
const STARTUP_MS = 60_000;
const WHEEL_MS = 5_000;
const topLine = (screen: string) => Number(/Transcript line (\d+)/.exec(screen)?.[1]);

function wheelAt(screen: string, label: string, button: number): string {
	const lines = screen.split("\n");
	const row = lines.findIndex((line) => line.includes(label));
	assert.notEqual(row, -1, screen);
	return `\x1b[<${button};${lines[row]!.indexOf(label) + 1};${row + 1}M`;
}

test.each([
	["local", "inline", "an inline row can decline up and handle down"],
	["engine", "burst", "successive turns over a named row and transcript stay in order"],
	["engine", "alt", "Alt-wheel keeps its five-line transcript step"],
	["engine", "outside", "a wheel outside a focused list scrolls only the transcript"],
	["engine", "slow", "a slow reply to a wheel inside a list scrolls only the transcript"],
])(
	"%s/%s: %s (#5532)",
	async (host, scenario) => {
		const root = makeTempDirectory("engine-inline-wheel-");
		const agentDir = join(root, "agent");
		const project = join(root, "project");
		let program: PtyProgram | undefined;
		try {
			mkdirSync(project);
			prepareAgentDir(agentDir, "http://127.0.0.1:9");
			prepareInstalledPackage(PACKAGE, join(root, "package"));
			program = startPtyProgram({
				executable: process.execPath,
				args: [
					join(PACKAGE, "dist/cli.js"),
					"--offline",
					host === "local" ? "--no-approve" : "--approve",
					"--extension",
					EXTENSION,
				],
				cwd: project,
				env: {
					ATOMIC_CODING_AGENT_DIR: agentDir,
					ATOMIC_PACKAGE_DIR: join(root, "package"),
					WHEEL_SCENARIO: scenario,
					TERM: "xterm-256color",
					CI: "0",
				},
				timeoutMs: STARTUP_MS + 3 * WHEEL_MS,
				cols: 100,
				rows: 24,
			});
			const label = `${host} row:`;
			await program.waitForScreen(
				(s) => s.includes(label) && topLine(s) > 5,
				STARTUP_MS,
				"the row below a scrolled transcript",
			);
			const screen = program.screen();
			const before = topLine(screen);
			const transcript = `Transcript line ${before + 4}`;
			const overlay = scenario === "outside" || scenario === "slow";
			if (overlay) assert.match(screen, /❯ Bravo/);
			if (scenario === "burst") {
				// At the bottom a down followed by an up is not equivalent to an up followed by a down.
				program.write(wheelAt(screen, label, 64) + wheelAt(screen, transcript, 65));
			} else if (scenario === "alt") {
				program.write(wheelAt(screen, label, 72));
			} else if (overlay) {
				program.write(wheelAt(screen, scenario === "outside" ? transcript : "Bravo", 64));
			} else {
				program.write(wheelAt(screen, label, 64));
				await program.waitForScreen((s) => topLine(s) === before - 1, WHEEL_MS, "one line of transcript fallback");
				program.write(wheelAt(program.screen(), label, 65));
			}
			// Wait for a later input's paint, not a screen that already satisfied the expectation before the wheel.
			program.write("k");
			await program.waitForScreen((s) => s.includes("keys: 1"), WHEEL_MS, "the key after the wheel");
			const after = program.screen();
			assert.equal(topLine(after), before - (scenario === "burst" ? 0 : scenario === "alt" ? 5 : 1), after);
			assert.ok(
				after.includes(`${label} ${scenario === "inline" ? 1 : 0} keys: 1 delays: ${scenario === "slow" ? 1 : 0}`),
				after,
			);
			if (overlay) assert.match(after, /❯ Bravo/, after);
		} finally {
			program?.kill();
			await program?.exited;
			await removeTempRootReleasingBroker(root, agentDir);
		}
	},
	STARTUP_MS + 3 * WHEEL_MS + 15_000,
);
