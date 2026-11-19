import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";
import { removeTempRootReleasingBroker } from "../helpers/detached-broker.js";
import { prepareAgentDir, prepareInstalledPackage } from "../helpers/event-loop-guard-fixture.js";
import { type PtyProgram, startPtyProgram } from "../helpers/pty-program.js";
import { makeTempDirectory, moduleDir } from "../helpers/runtime.js";

const PACKAGE = join(moduleDir(import.meta.url), "../../packages/coding-agent");
const EXTENSION = join(moduleDir(import.meta.url), "../fixtures/pane-click-order.mjs");

test.each(["local", "engine"])(
	"%s: a click and Left in one input burst open the row and return from its page (#5644)",
	async (host) => {
		const root = makeTempDirectory("pane-click-order-");
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
					TERM: "xterm-256color",
					CI: "0",
				},
				timeoutMs: 90_000,
				cols: 100,
				rows: 24,
			});
			await program.waitForScreen(
				(screen) => screen.includes("Navigation test ready"),
				60_000,
				"navigation command registration",
			);
			program.write("/pane-order\r");
			await program.waitForScreen(
				(screen) => screen.includes("Navigation pane") && screen.includes("Open transcript"),
				60_000,
				"both navigation panes",
			);
			program.write("k");
			await program.waitForScreen(
				(screen) => screen.includes("Navigation ready") && screen.includes("Open transcript"),
				5000,
				"keyboard focus on the other pane",
			);
			const lines = program.screen().split("\n");
			const row = lines.findIndex((line) => line.includes("Open transcript"));
			assert.notEqual(row, -1);
			const cell = `${lines[row]!.indexOf("Open transcript") + 1};${row + 1}`;
			program.write(`\x1b[<0;${cell}M\x1b[<0;${cell}m\x1b[D`);
			await program.waitForScreen(
				(screen) => screen.includes("Returned from transcript"),
				5000,
				"Left on the newly opened page",
			);
		} finally {
			program?.kill();
			await program?.exited;
			await removeTempRootReleasingBroker(root, agentDir);
		}
	},
	100_000,
);
