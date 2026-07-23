import { test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const serialTest = process.platform === "win32" ? test.serial.skip : test.serial;
const PREFIX = "@@ATOMIC_TEST@@";

interface HarnessReport {
	type?: string;
	editorText?: string;
	prefix?: string;
	items?: Array<{ value?: string; label?: string }> | null;
}

class InteractiveDriver {
	readonly process: ReturnType<typeof Bun.spawn>;
	readonly reports: HarnessReport[] = [];
	private readonly waiters = new Set<() => void>();
	private stderr = "";

	constructor(args: string[], overrides: Record<string, string | undefined>) {
		const inherited: Record<string, string | undefined> = { ...process.env };
		for (const key of Object.keys(inherited)) {
			if (key.startsWith("ATOMIC_INTERACTIVE_ENGINE_")) delete inherited[key];
		}
		const env: Record<string, string> = {};
		for (const [key, value] of Object.entries({ ...inherited, ...overrides })) {
			if (value !== undefined) env[key] = value;
		}
		this.process = Bun.spawn([
			process.execPath,
			join(import.meta.dir, "fixtures", "default-main-interactive-host.ts"),
			...args,
		], {
			cwd: join(import.meta.dir, "../.."),
			env,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		void this.readReports();
		void this.readStderr();
	}

	send(command: { type: "input" | "autocomplete"; data: string }): void {
		const stdin = this.process.stdin;
		if (!stdin || typeof stdin === "number") throw new Error("fixture stdin is unavailable");
		stdin.write(`${JSON.stringify(command)}\n`);
		void stdin.flush();
	}

	async waitFor(predicate: (report: HarnessReport) => boolean, timeoutMs = 10_000): Promise<HarnessReport> {
		const existing = this.reports.find(predicate);
		if (existing) return existing;
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.waiters.delete(inspect);
				reject(new Error(`Timed out waiting for fixture report. last=${JSON.stringify(this.reports.slice(-5))} stderr=${this.stderr.slice(-2000)}`));
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
	}

	private async readReports(): Promise<void> {
		const stdout = this.process.stdout;
		if (!stdout || typeof stdout === "number") return;
		const reader = stdout.pipeThrough(new TextDecoderStream()).getReader();
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
					this.reports.push(JSON.parse(line.slice(marker + PREFIX.length)) as HarnessReport);
					for (const waiter of this.waiters) waiter();
				} catch {}
			}
		}
	}

	private async readStderr(): Promise<void> {
		const stderr = this.process.stderr;
		if (!stderr || typeof stderr === "number") return;
		this.stderr = await new Response(stderr).text();
	}
}

function writeLegacyCommandExtension(home: string): string {
	const extensionDir = join(home, ".pi", "agent", "extensions");
	const logFile = join(home, "legacy-command.log");
	mkdirSync(extensionDir, { recursive: true });
	writeFileSync(join(extensionDir, "legacy-command.ts"), `
import { appendFileSync } from "node:fs";
export default function(pi) {
  pi.registerCommand("legacy-compatible", {
    description: "legacy compatible command",
    handler: async () => appendFileSync(process.env.ATOMIC_LEGACY_COMMAND_LOG, "invoked\\n"),
  });
}
`);
	return logFile;
}

function args(): string[] {
	return [
		"--no-session", "--extension", join(import.meta.dir, "fixtures", "workflow-command-extension.ts"),
		"--no-skills", "--no-prompt-templates", "--no-themes", "--offline", "--approve",
		"--provider", "isolation-fixture", "--model", "blocking-model",
	];
}

async function waitForCommand(driver: InteractiveDriver): Promise<Set<string>> {
	const deadline = performance.now() + 10_000;
	let names = new Set<string>();
	while (performance.now() < deadline) {
		names = await driver.autocomplete("/legacy-compatible");
		if (names.has("legacy-compatible")) return names;
		await Bun.sleep(50);
	}
	return names;
}

serialTest("isolated interactive mode discovers and runs compatible inherited Pi extensions", async () => {
	const temp = mkdtempSync(join(tmpdir(), "atomic-inherited-tui-"));
	const home = join(temp, "home");
	const logFile = writeLegacyCommandExtension(home);
	mkdirSync(join(home, ".atomic", "agent"), { recursive: true });
	writeFileSync(join(home, ".atomic", "agent", "settings.json"), "{}\n");
	const driver = new InteractiveDriver(args(), {
		HOME: home, USERPROFILE: undefined, HOMEDRIVE: undefined, HOMEPATH: undefined,
		ATOMIC_CODING_AGENT_DIR: undefined, PI_CODING_AGENT_DIR: undefined, ATOMIC_LEGACY_COMMAND_LOG: logFile,
	});
	try {
		await driver.waitFor((report) => report.type === "terminal_ready", 15_000);
		assert.ok((await waitForCommand(driver)).has("legacy-compatible"));
		driver.send({ type: "input", data: "/legacy-compatible" });
		await driver.waitFor((report) => report.type === "heartbeat" && report.editorText === "/legacy-compatible");
		driver.send({ type: "input", data: "\r" });
		const deadline = performance.now() + 5_000;
		while (!existsSync(logFile) && performance.now() < deadline) await Bun.sleep(20);
		assert.equal(readFileSync(logFile, "utf8"), "invoked\n");
	} finally {
		await driver.stop();
		rmSync(temp, { recursive: true, force: true });
	}
}, 20_000);

serialTest("isolated interactive mode preserves an explicit Atomic agent directory override", async () => {
	const temp = mkdtempSync(join(tmpdir(), "atomic-explicit-tui-"));
	const home = join(temp, "home");
	writeLegacyCommandExtension(home);
	const driver = new InteractiveDriver(args(), {
		HOME: home, USERPROFILE: undefined, HOMEDRIVE: undefined, HOMEPATH: undefined,
		ATOMIC_CODING_AGENT_DIR: join(temp, "isolated-agent"), PI_CODING_AGENT_DIR: undefined,
	});
	try {
		await driver.waitFor((report) => report.type === "terminal_ready", 15_000);
		await Bun.sleep(500);
		assert.equal((await driver.autocomplete("/legacy-compatible")).has("legacy-compatible"), false);
	} finally {
		await driver.stop();
		rmSync(temp, { recursive: true, force: true });
	}
}, 20_000);
