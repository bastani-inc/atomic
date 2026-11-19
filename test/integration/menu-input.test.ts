import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "vitest";
import { removeTempRootReleasingBroker } from "../helpers/detached-broker.js";
import { prepareAgentDir, prepareInstalledPackage, writeLargeSession } from "../helpers/event-loop-guard-fixture.js";
import { type PtyProgram, startPtyProgram } from "../helpers/pty-program.js";
import { makeTempDirectory, moduleDir } from "../helpers/runtime.js";

const PACKAGE = join(moduleDir(import.meta.url), "../../packages/coding-agent");
const fixtures = join(moduleDir(import.meta.url), "../fixtures");
const startup = 60_000;
const input = 15_000;

async function runCli(
	host: string,
	bindings: Record<string, string[]>,
	drive: (pty: PtyProgram, changes: string) => Promise<void>,
	seedSession = false,
) {
	const root = makeTempDirectory("menu-input-");
	const agentDir = join(root, "agent");
	const changes = join(root, "changes");
	let pty: PtyProgram | undefined;
	try {
		const project = join(root, "project");
		mkdirSync(project);
		prepareAgentDir(agentDir, "http://127.0.0.1:9");
		prepareInstalledPackage(PACKAGE, join(root, "package"));
		writeFileSync(join(agentDir, "keybindings.json"), JSON.stringify(bindings));
		writeFileSync(changes, "");
		const sessions = join(root, "sessions");
		const id = "01900000-0000-7000-8000-000000000001";
		if (seedSession) {
			writeLargeSession(sessions, project, id, 1);
			// An explicit CLI or environment store forces the engine on even with --no-approve.
			const file = join(agentDir, "settings.json");
			writeFileSync(
				file,
				JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), sessions: { storage: { dir: sessions } } }),
			);
		}
		pty = startPtyProgram({
			executable: process.execPath,
			args: [
				...(Object.keys(bindings).length
					? ["--import", pathToFileURL(join(fixtures, "menu-input-observer.mjs")).href]
					: []),
				join(PACKAGE, "dist/cli.js"),
				"--offline",
				host === "local" ? "--no-approve" : "--approve",
				"--extension",
				join(fixtures, "menu-input.mjs"),
				...(seedSession ? ["--session", id] : []),
			],
			cwd: project,
			env: {
				ATOMIC_CODING_AGENT_DIR: agentDir,
				ATOMIC_PACKAGE_DIR: join(root, "package"),
				DRAFT_CHANGES: changes,
				TERM: "xterm-256color",
				CI: "0",
			},
			timeoutMs: startup + 45_000,
			cols: 110,
			rows: 40,
		});
		await pty.waitForScreen(
			(s) => s.includes(`Transcript line 139 (${host})`) && s.includes("1 shell"),
			startup,
			"numbered transcript and task footer",
		);
		await drive(pty, changes);
	} finally {
		pty?.kill();
		await pty?.exited;
		await removeTempRootReleasingBroker(root, agentDir);
	}
}

const wheelCases = [
	["/tree", "user: Turn", 0],
	["/resume", " messages", 0],
	["/tasks", "Single shell row", 0],
	["/agents", "codebase-analyzer", 0],
	["/sample-menu empty", "No workflows in this session", 0],
	["/sample-menu runs", "Bravo objective", 0],
	["/sample-menu intercom", "Bravo (", 0],
	["/sample-menu resources", "Bravo", 0],
	["/sample-menu mcp", "Bravo", 0],
	["/sample-menu llama", "Bravo", 0],
	["/sample-menu search", "models/Bravo", 0],
	["/sample-menu settings", "Alpha", -2],
	["/sample-menu settings", "Alpha", -1],
] as const;

for (const host of ["local", "engine"]) {
	for (const [command, label, offset] of wheelCases) {
		const native = command === "/tree" || command === "/resume";
		if (host === "engine" && !native) continue;
		test(
			`${host}: Alt-wheel over ${command} at ${label} (${offset}) scrolls the transcript without changing the selection (#5532)`,
			async () => {
				await runCli(
					host,
					{},
					async (pty) => {
						pty.write(`${command}\r`);
						if (command.endsWith(" search")) {
							await pty.waitForScreen((s) => s.includes("Download model"), input, "search field");
							pty.write("models");
						}
						await pty.waitForScreen((s) => s.includes(label), input, label);
						if (/ (llama|mcp|search)$/.test(command)) {
							pty.write("\x1b[B");
							await pty.waitForScreen((s) => /❯\s+(?:models\/)?Bravo/.test(s), input, "Bravo selected");
						}
						const before = pty.screen();
						// Use a fixed interior row: the scroll indicator can replace an edge label on repaint.
						const row = before.split("\n").findIndex((line, i) => i >= 3 && /Transcript line \d+/.test(line));
						assert.notEqual(row, -1, before);
						const visible = (s: string) => Number(/Transcript line (\d+)/.exec(s.split("\n")[row]!)?.[1]);
						const selected = (s: string) =>
							s.split("\n").flatMap((line) => {
								// Ignore the transcript behind floating menus and live elapsed times after task names.
								const match = /[❯›] *([^│]{0,40})/.exec(line);
								return match ? [match[1]!.trim()] : [];
							});
						pty.write(`\x1b[<72;${point(before, label, offset)}M`);
						await pty.waitForScreen(
							(s) => visible(s) === visible(before) - 5,
							input,
							"five lines of transcript scroll",
						);
						assert.deepEqual(selected(pty.screen()), selected(before));
					},
					native,
				);
			},
			startup + 60_000,
		);
	}
}

function point(screen: string, label: string, offset = 0): string {
	const lines = screen.split("\n");
	const i = lines.findLastIndex((line) => line.includes(label));
	assert.notEqual(i, -1, screen);
	return `${lines[i]!.indexOf(label) + 1};${i + offset + 1}`;
}

for (const host of ["local", "engine"]) {
	for (const binding of ["newline", "F6"]) {
		test(
			`${host}: a clicked slash completion ${binding === "newline" ? "does not replay the newline binding" : "publishes the completed draft with only F6 bound"} (#5532)`,
			async () => {
				const bindings: Record<string, string[]> =
					binding === "newline"
						? {
								"tui.input.newLine": ["enter"],
								"tui.input.submit": ["shift+enter"],
								"tui.select.confirm": ["enter", "shift+enter"],
							}
						: { "tui.input.submit": ["f6"], "tui.select.confirm": ["f6"] };
				await runCli(host, bindings, async (pty, changes) => {
					// The initial transcript can paint before the engine's command catalog reaches the host.
					// Finish a command round trip before opening the suggestion to be clicked.
					pty.write(`/sample-menu ready${binding === "F6" ? "\x1b[17~" : "\x1b[13;2u"}`);
					await pty.waitForScreen((s) => s.includes("Menu commands ready"), input, "command round trip");
					pty.write("/se");
					const label = "Open settings menu";
					await pty.waitForScreen((s) => s.includes(label), input, "settings suggestion");
					const cell = point(pty.screen(), label);
					pty.write(`\x1b[<0;${cell}M\x1b[<0;${cell}m`);
					await pty.waitForScreen(
						(s) => !s.includes(label) && s.includes("/settings"),
						input,
						"completed command",
					);
					pty.write("PROBE");
					await pty.waitForScreen((s) => s.includes("PROBE"), input, "typed suffix");
					assert.match(pty.screen(), /\/settings PROBE/);
					assert.equal(readFileSync(changes, "utf8"), '"/settings "\n');
				});
			},
			startup + 60_000,
		);
	}
}
