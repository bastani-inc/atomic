import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import {
	bunExecutable,
	decodeStream,
	moduleDir,
	readStreamText,
	type SpawnedProcess,
	sleep,
	spawnProcess,
} from "../helpers/runtime.js";

const serialTest = process.platform === "win32" ? test.sequential.skip : test.sequential;
const PREFIX = "@@ATOMIC_TEST@@";
const INHERITED_DISCOVERY_TIMEOUT_MS = 60_000;
const INHERITED_REPORT_TIMEOUT_MS = 30_000;

/**
 * Kill a detached engine child and everything it spawned.
 *
 * The interactive engine is launched detached, so it leads its own process
 * group and survives a SIGKILL to the fixture host until its parent guardian
 * notices (~50 ms poll). Targeting the negative pid reaps the whole group at
 * once so nothing outlives the test to keep writing into the temporary home.
 */
function killEngineProcessGroup(pid: number): void {
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		try {
			process.kill(pid, "SIGKILL");
		} catch {}
	}
}

/**
 * Remove a test's temporary directory without racing a dying engine.
 *
 * An engine killed moments ago can still have a cache write in flight inside
 * the temporary home, which makes `rmSync` fail with ENOTEMPTY between listing
 * a directory and removing it. Retrying briefly absorbs those writes; anything
 * else is a real failure and is rethrown.
 */
async function removeTempDirectory(path: string): Promise<void> {
	const codes = new Set(["ENOTEMPTY", "EBUSY", "EPERM"]);
	for (let attempt = 0; attempt < 20; attempt++) {
		try {
			rmSync(path, { recursive: true, force: true });
			return;
		} catch (error) {
			if (!codes.has((error as NodeJS.ErrnoException).code ?? "")) throw error;
			await sleep(50);
		}
	}
	rmSync(path, { recursive: true, force: true });
}

interface HarnessReport {
	type?: string;
	editorText?: string;
	prefix?: string;
	enginePid?: number;
	items?: Array<{ value?: string; label?: string }> | null;
}

class InteractiveDriver {
	readonly process: SpawnedProcess;
	readonly reports: HarnessReport[] = [];
	private readonly waiters = new Set<() => void>();
	private stderr = "";
	private readonly enginePids = new Set<number>();

	constructor(args: string[], overrides: Record<string, string | undefined>) {
		const inherited: Record<string, string | undefined> = { ...process.env };
		for (const key of Object.keys(inherited)) {
			if (key.startsWith("ATOMIC_INTERACTIVE_ENGINE_")) delete inherited[key];
		}
		const env: Record<string, string> = {};
		for (const [key, value] of Object.entries({ ...inherited, ...overrides })) {
			if (value !== undefined) env[key] = value;
		}
		this.process = spawnProcess(
			[bunExecutable(), join(moduleDir(import.meta.url), "fixtures", "default-main-interactive-host.ts"), ...args],
			{
				cwd: join(moduleDir(import.meta.url), "../.."),
				env,
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		void this.readReports();
		void this.readStderr();
	}

	send(command: { type: "input" | "autocomplete"; data: string }): void {
		const stdin = this.process.stdin;
		if (!stdin || typeof stdin === "number") throw new Error("fixture stdin is unavailable");
		stdin.write(`${JSON.stringify(command)}\n`);
		void stdin.flush();
	}

	async waitFor(
		predicate: (report: HarnessReport) => boolean,
		timeoutMs = INHERITED_REPORT_TIMEOUT_MS,
	): Promise<HarnessReport> {
		const existing = this.reports.find(predicate);
		if (existing) return existing;
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.waiters.delete(inspect);
				reject(
					new Error(
						`Timed out waiting for fixture report. last=${JSON.stringify(this.reports.slice(-5))} stderr=${this.stderr.slice(-2000)}`,
					),
				);
			}, timeoutMs);
			const inspect = (): void => {
				const found = this.reports.find(predicate);
				if (!found) return;
				clearTimeout(timeout);
				this.waiters.delete(inspect);
				resolve(found);
			};
			this.waiters.add(inspect);
		});
	}

	async autocomplete(prefix: string): Promise<Set<string>> {
		const start = this.reports.length;
		this.send({ type: "autocomplete", data: prefix });
		const report = await this.waitFor((candidate) => {
			const index = this.reports.indexOf(candidate);
			return index >= start && candidate.type === "autocomplete" && candidate.prefix === prefix;
		});
		return new Set((report.items ?? []).map((item) => (item.label ?? item.value ?? "").replace(/^\//, "").trim()));
	}

	async stop(): Promise<void> {
		if (this.process.exitCode === null) this.process.kill("SIGKILL");
		await this.process.exited;
		// Killing the host skips the teardown that reaps the detached engine
		// child, so reap every engine group this session reported directly.
		for (const pid of this.enginePids) killEngineProcessGroup(pid);
	}

	private async readReports(): Promise<void> {
		const stdout = this.process.stdout;
		if (!stdout || typeof stdout === "number") return;
		const reader = decodeStream(stdout).getReader();
		let buffer = "";
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += value;
			for (;;) {
				const newline = buffer.indexOf("\n");
				if (newline === -1) break;
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				const marker = line.indexOf(PREFIX);
				if (marker === -1) continue;
				try {
					const report = JSON.parse(line.slice(marker + PREFIX.length)) as HarnessReport;
					if (typeof report.enginePid === "number") this.enginePids.add(report.enginePid);
					this.reports.push(report);
					for (const waiter of this.waiters) waiter();
				} catch {}
			}
		}
	}

	private async readStderr(): Promise<void> {
		const stderr = this.process.stderr;
		if (!stderr || typeof stderr === "number") return;
		this.stderr = await readStreamText(stderr);
	}
}

function writeLegacyCommandExtension(home: string): string {
	const extensionDir = join(home, ".pi", "agent", "extensions");
	const logFile = join(home, "legacy-command.log");
	mkdirSync(extensionDir, { recursive: true });
	writeFileSync(
		join(extensionDir, "legacy-command.ts"),
		`
import { appendFileSync, writeFileSync } from "node:fs";
export default function(pi) {
  pi.registerCommand("legacy-compatible", {
    description: "legacy compatible command",
    handler: async () => {
      writeFileSync(process.env.ATOMIC_LEGACY_COMMAND_LOG, "");
      await new Promise((resolve) => setTimeout(resolve, 50));
      appendFileSync(process.env.ATOMIC_LEGACY_COMMAND_LOG, "invoked\\n");
    },
  });
}
`,
	);
	return logFile;
}

function args(): string[] {
	return [
		"--no-session",
		"--extension",
		join(moduleDir(import.meta.url), "fixtures", "workflow-command-extension.ts"),
		"--no-skills",
		"--no-prompt-templates",
		"--no-themes",
		"--offline",
		"--approve",
		"--provider",
		"isolation-fixture",
		"--model",
		"blocking-model",
	];
}

async function waitForCommand(driver: InteractiveDriver): Promise<Set<string>> {
	const deadline = performance.now() + INHERITED_DISCOVERY_TIMEOUT_MS;
	let names = new Set<string>();
	while (performance.now() < deadline) {
		names = await driver.autocomplete("/legacy-compatible");
		if (names.has("legacy-compatible")) return names;
		await sleep(50);
	}
	return names;
}

serialTest(
	"isolated interactive mode discovers and runs compatible inherited Pi extensions",
	async () => {
		const temp = mkdtempSync(join(tmpdir(), "atomic-inherited-tui-"));
		const home = join(temp, "home");
		const logFile = writeLegacyCommandExtension(home);
		mkdirSync(join(home, ".atomic", "agent"), { recursive: true });
		writeFileSync(join(home, ".atomic", "agent", "settings.json"), "{}\n");
		const driver = new InteractiveDriver(args(), {
			HOME: home,
			USERPROFILE: undefined,
			HOMEDRIVE: undefined,
			HOMEPATH: undefined,
			ATOMIC_CODING_AGENT_DIR: undefined,
			PI_CODING_AGENT_DIR: undefined,
			ATOMIC_LEGACY_COMMAND_LOG: logFile,
		});
		try {
			await driver.waitFor((report) => report.type === "terminal_ready", INHERITED_REPORT_TIMEOUT_MS);
			assert.ok((await waitForCommand(driver)).has("legacy-compatible"));
			driver.send({ type: "input", data: "/legacy-compatible" });
			await driver.waitFor((report) => report.type === "heartbeat" && report.editorText === "/legacy-compatible");
			driver.send({ type: "input", data: "\r" });
			const deadline = performance.now() + INHERITED_REPORT_TIMEOUT_MS;
			let commandLog = "";
			while (performance.now() < deadline) {
				if (existsSync(logFile)) commandLog = readFileSync(logFile, "utf8");
				if (commandLog === "invoked\n") break;
				await sleep(20);
			}
			assert.equal(commandLog, "invoked\n");
		} finally {
			await driver.stop();
			await removeTempDirectory(temp);
		}
	},
	INHERITED_DISCOVERY_TIMEOUT_MS,
);

serialTest(
	"isolated interactive mode preserves an explicit Atomic agent directory override",
	async () => {
		const temp = mkdtempSync(join(tmpdir(), "atomic-explicit-tui-"));
		const home = join(temp, "home");
		writeLegacyCommandExtension(home);
		const driver = new InteractiveDriver(args(), {
			HOME: home,
			USERPROFILE: undefined,
			HOMEDRIVE: undefined,
			HOMEPATH: undefined,
			ATOMIC_CODING_AGENT_DIR: join(temp, "isolated-agent"),
			PI_CODING_AGENT_DIR: undefined,
		});
		try {
			await driver.waitFor((report) => report.type === "terminal_ready", INHERITED_REPORT_TIMEOUT_MS);
			await sleep(500);
			assert.equal((await driver.autocomplete("/legacy-compatible")).has("legacy-compatible"), false);
		} finally {
			await driver.stop();
			await removeTempDirectory(temp);
		}
	},
	INHERITED_DISCOVERY_TIMEOUT_MS,
);
