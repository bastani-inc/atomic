import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "vitest";
import {
	fileExists,
	moduleDir,
	readJson,
	readText,
	sleep,
	spawnSyncCollect,
	writeFileEnsuringDir,
} from "../helpers/runtime.js";

const repoRoot = join(moduleDir(import.meta.url), "../..");
const TMUX_AVAILABLE = (() => {
	try {
		return spawnSyncCollect(["tmux", "-V"]).exitCode === 0;
	} catch {
		return false;
	}
})();
const REAL_INTERACTIVE_STARTUP_TIMEOUT_MS = 120_000;
const SLOW_EXTENSION_SHUTDOWN_MS = 1_000;

interface StartupSnapshot {
	pid: number;
	active: string[];
	commands: string[];
}

test.skipIf(!TMUX_AVAILABLE)(
	"built interactive CLI waits for startup before testing --no-mcp and pending /mcp shutdown (#10249) (#3470)",
	async () => {
		const temp = mkdtempSync(join(tmpdir(), "atomic-no-mcp-startup-"));
		const socket = join(temp, "tmux.sock");
		const observer = join(temp, "observe.mjs");
		const server = join(temp, "server.mjs");
		const fixtureServer = join(repoRoot, "packages/coding-agent/test/mcp-client/fixtures/stdio-server.mjs");
		await writeFileEnsuringDir(
			server,
			`import { writeFileSync } from "node:fs";
writeFileSync(process.argv[2], String(process.pid));
if (process.argv[3] === "pending") {
	process.on("SIGTERM", () => process.exit(0));
	process.stdin.resume();
	setInterval(() => {}, 1000);
} else {
await import(${JSON.stringify(pathToFileURL(fixtureServer).href)});
}
`,
		);
		await writeFileEnsuringDir(
			observer,
			`import { writeFileSync } from "node:fs";
export default function(pi) {
	pi.on("session_shutdown", async () => {
		await new Promise(resolve => setTimeout(resolve, ${SLOW_EXTENSION_SHUTDOWN_MS}));
		writeFileSync(process.env.STARTUP_SNAPSHOT + ".closed", "closed");
	});
	pi.registerCommand("startup-ready", {
		handler: async (_args, ctx) => {
			if (ctx.isPresentationOnly) return;
			writeFileSync(process.env.STARTUP_SNAPSHOT + ".ready", String(process.pid));
		},
	});
	pi.on("session_start", (_event, ctx) => {
		if (ctx.isPresentationOnly) return;
		// Let later session_start handlers start their background MCP connections.
		setTimeout(async () => {
			const commands = pi.getCommands().map(command => command.name);
			if (commands.includes("mcp") && !process.env.PENDING_MCP) {
				const deadline = Date.now() + 15000;
				while (!pi.getActiveTools().includes("mcp__startup__echo") && Date.now() < deadline)
					await new Promise(resolve => setTimeout(resolve, 50));
			}
			writeFileSync(process.env.STARTUP_SNAPSHOT, JSON.stringify({
				pid: process.pid, active: pi.getActiveTools(), commands
			}));
		}, 0);
	});
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.isPresentationOnly) return;
		if (process.env.STARTUP_DELAY) await new Promise(resolve => setTimeout(resolve, 1000));
	});
}
`,
		);
		const tmux = (...args: string[]) => {
			const result = spawnSyncCollect(["tmux", "-S", socket, ...args]);
			assert.equal(result.exitCode, 0, result.stderr.toString());
			return result.stdout.toString().trim();
		};
		try {
			for (const name of ["normal", "disabled", "pending"]) {
				const disabled = name === "disabled";
				const pending = name === "pending";
				const agentDir = join(temp, name, "agent");
				const snapshotPath = join(temp, name, "snapshot.json");
				const serverMarker = join(temp, name, "server-started");
				mkdirSync(agentDir, { recursive: true });
				await writeFileEnsuringDir(
					join(agentDir, "mcp.json"),
					JSON.stringify({
						mcpServers: {
							startup: { command: process.execPath, args: [server, serverMarker, name], exposure: "direct" },
						},
					}),
				);
				tmux(
					"new-session",
					"-d",
					"-s",
					name,
					"-x",
					"120",
					"-y",
					"40",
					"-c",
					repoRoot,
					"-e",
					`ATOMIC_CODING_AGENT_DIR=${agentDir}`,
					"-e",
					`STARTUP_SNAPSHOT=${snapshotPath}`,
					"-e",
					`PENDING_MCP=${pending ? "1" : ""}`,
					"-e",
					`STARTUP_DELAY=${disabled ? "1" : ""}`,
					process.execPath,
					join(repoRoot, "packages/coding-agent/dist/cli.js"),
					"--no-session",
					"--offline",
					"--approve",
					"--no-skills",
					"--no-prompt-templates",
					"--no-context-files",
					"--provider",
					"anthropic",
					"--model",
					"claude-opus-4-8",
					"--extension",
					observer,
					...(disabled ? ["--no-mcp"] : []),
				);
				let serverPid: number | undefined;
				try {
					const deadline = Date.now() + 45000;
					while (!(await fileExists(snapshotPath)) && Date.now() < deadline) await sleep(50);
					assert.ok(await fileExists(snapshotPath), tmux("capture-pane", "-p", "-t", name));
					const snapshot = await readJson<StartupSnapshot>(snapshotPath);
					tmux("send-keys", "-t", name, "-l", "/startup-ready");
					while (!/^❯ \/startup-ready\s*$/m.test(tmux("capture-pane", "-p", "-t", name)) && Date.now() < deadline)
						await sleep(50);
					assert.match(tmux("capture-pane", "-p", "-t", name), /^❯ \/startup-ready\s*$/m);
					tmux("send-keys", "-t", name, "Enter");
					while (!(await fileExists(`${snapshotPath}.ready`)) && Date.now() < deadline) await sleep(50);
					assert.ok(
						await fileExists(`${snapshotPath}.ready`),
						`${name}: engine startup-ready command must complete before exit (#10249)`,
					);
					assert.equal(Number(await readText(`${snapshotPath}.ready`)), snapshot.pid);
					const hostPid = Number(tmux("display-message", "-p", "-t", name, "#{pane_pid}"));
					assert.notEqual(snapshot.pid, hostPid, "snapshot must come from the isolated engine child");
					assert.equal(snapshot.commands.includes("mcp"), !disabled, JSON.stringify(snapshot));
					assert.equal(
						snapshot.active.includes("mcp__startup__echo"),
						!disabled && !pending,
						JSON.stringify(snapshot),
					);
					while (!disabled && !(await fileExists(serverMarker)) && Date.now() < deadline) await sleep(50);
					assert.equal(await fileExists(serverMarker), !disabled, "--no-mcp must not start the server");
					if (!disabled) serverPid = Number(await readText(serverMarker));
					if (pending) {
						tmux("send-keys", "-t", name, "-l", "/mcp");
						while (!/^❯ \/mcp\s*$/m.test(tmux("capture-pane", "-p", "-t", name)) && Date.now() < deadline)
							await sleep(50);
						assert.match(tmux("capture-pane", "-p", "-t", name), /^❯ \/mcp\s*$/m);
						tmux("send-keys", "-t", name, "Enter");
						const managerDeadline = Date.now() + 5000;
						const managerTitle = /^\s*MCP servers\s*$/m;
						const serverRow = /^\s*→ startup\s+.+$/m;
						let pane = tmux("capture-pane", "-p", "-t", name);
						while ((!managerTitle.test(pane) || !serverRow.test(pane)) && Date.now() < managerDeadline) {
							await sleep(50);
							pane = tmux("capture-pane", "-p", "-t", name);
						}
						assert.match(pane, managerTitle);
						assert.match(pane, serverRow);
						assert.ok(pane.includes("connecting"), pane);
						tmux("send-keys", "-t", name, "Escape");
						while ((managerTitle.test(pane) || !/^❯\s*$/m.test(pane)) && Date.now() < managerDeadline) {
							await sleep(50);
							pane = tmux("capture-pane", "-p", "-t", name);
						}
						assert.ok(!managerTitle.test(pane), pane);
						assert.match(pane, /^❯\s*$/m);
					}
				} finally {
					try {
						tmux("send-keys", "-t", name, "C-d");
						const exitDeadline = Date.now() + 10000;
						while (
							spawnSyncCollect(["tmux", "-S", socket, "has-session", "-t", name]).exitCode === 0 &&
							Date.now() < exitDeadline
						)
							await sleep(50);
						assert.notEqual(spawnSyncCollect(["tmux", "-S", socket, "has-session", "-t", name]).exitCode, 0);
						if (serverPid) {
							const pid = serverPid;
							assert.throws(() => process.kill(pid, 0), `${name}: MCP server ${pid} must not survive CLI exit`);
						}
						assert.ok(
							await fileExists(`${snapshotPath}.closed`),
							`${name}: engine must run extension shutdown before exiting`,
						);
					} finally {
						if (serverPid) {
							try {
								process.kill(serverPid, "SIGTERM");
							} catch {}
						}
					}
				}
			}
		} finally {
			spawnSyncCollect(["tmux", "-S", socket, "kill-server"]);
			rmSync(temp, { recursive: true, force: true });
		}
	},
	REAL_INTERACTIVE_STARTUP_TIMEOUT_MS,
);
