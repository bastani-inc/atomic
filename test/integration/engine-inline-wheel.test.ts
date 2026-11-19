import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";
import { removeTempRootReleasingBroker } from "../helpers/detached-broker.js";
import { prepareAgentDir, prepareInstalledPackage } from "../helpers/event-loop-guard-fixture.js";
import { type PtyProgram, startPtyProgram } from "../helpers/pty-program.js";
import { makeTempDirectory, moduleDir } from "../helpers/runtime.js";

const PACKAGE = join(moduleDir(import.meta.url), "../../packages/coding-agent");
const STARTUP_MS = 60_000;
const WHEEL_MS = 5_000;
const topLine = (screen: string) => Number(/Transcript line (\d+)/.exec(screen)?.[1]);

test.each(["--approve", "--no-approve"])(
	"an inline row leaves a declined wheel turn to the transcript (%s, #5532)",
	async (hostMode) => {
		const root = makeTempDirectory("engine-inline-wheel-");
		const agentDir = join(root, "agent");
		const extension = join(root, "status-row.mjs");
		const project = join(root, "project");
		let program: PtyProgram | undefined;
		try {
			mkdirSync(project);
			prepareAgentDir(agentDir, "http://127.0.0.1:9");
			prepareInstalledPackage(PACKAGE, join(root, "package"));
			writeFileSync(
				extension,
				`export default pi => pi.on("session_start", (_event, ctx) => {
			if (ctx.isPresentationOnly) return;
			pi.sendMessage({ customType: "scroll-test", display: true,
				content: Array.from({length: 80}, (_, i) => "Transcript line " + i).join("\\n") });
			void ctx.ui.custom(() => {
				let turns = 0;
				return { render: () => ["Status row: " + turns], invalidate() {}, paintedRowKey: () => "status",
					handleMouse(event) {
						if (event.type !== "wheel" || event.wheelDelta < 0) return;
						turns++; return { handled: true };
					} };
			}, {purpose: "navigation"});
		});`,
			);
			program = startPtyProgram({
				executable: process.execPath,
				args: [join(PACKAGE, "dist/cli.js"), "--offline", "--no-session", hostMode, "--extension", extension],
				cwd: project,
				env: {
					ATOMIC_CODING_AGENT_DIR: agentDir,
					ATOMIC_PACKAGE_DIR: join(root, "package"),
					TERM: "xterm-256color",
					CI: "0",
				},
				timeoutMs: STARTUP_MS + 2 * WHEEL_MS,
				cols: 100,
				rows: 24,
			});
			await program.waitForScreen(
				(s) => s.includes("Status row: 0") && topLine(s) > 0,
				STARTUP_MS,
				"the row below a scrolled transcript",
			);
			const before = topLine(program.screen());
			const wheel = (button: number, screen: string) => {
				const lines = screen.split("\n");
				const row = lines.findIndex((line) => line.includes("Status row:"));
				assert.notEqual(row, -1, screen);
				return `\x1b[<${button};${lines[row]!.indexOf("Status row:") + 1};${row + 1}M`;
			};
			program.write(wheel(64, program.screen()));
			await program.waitForScreen(
				(s) => topLine(s) === before - 1,
				WHEEL_MS,
				"one transcript line of wheel fallback",
			);
			program.write(wheel(65, program.screen()));
			await program.waitForScreen(
				(s) => s.includes("Status row: 1"),
				WHEEL_MS,
				"the row handling the other direction",
			);
			assert.equal(topLine(program.screen()), before - 1, "a handled turn must not also scroll the transcript");
		} finally {
			program?.kill();
			await program?.exited;
			await removeTempRootReleasingBroker(root, agentDir);
		}
	},
	STARTUP_MS + 2 * WHEEL_MS + 15_000,
);
