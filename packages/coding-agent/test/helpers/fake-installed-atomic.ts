import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { vi } from "vitest";

export interface FakeInstalledAtomic {
	/** Parsed `intercom upgrade` invocations the fake `atomic` on PATH received, in order. */
	upgradeCalls(): Array<{ args: string[]; packageDir: string | null }>;
	/** The device and inode of each `intercom upgrade` invocation's standard output, to tell an inherited one apart. */
	upgradeStdout(): Array<{ dev: number; ino: number }>;
	/** Each `intercom` invocation in order: `help`, `upgrade` or `prompt`, and whether its standard input was the null device. */
	intercomCalls(): Array<{ call: "help" | "upgrade" | "prompt"; stdinIsNull: boolean }>;
}

/**
 * How the fake answers `intercom`: `with-upgrade` as this version does; `without-upgrade` as 0.9.42 to 0.9.71, whose
 * help has no `upgrade` and which reject it; `prompt` as 0.9.41 and older, which print their global help for
 * `--help` and read `intercom upgrade` as a prompt for the model.
 */
export type FakeIntercomCommand = "with-upgrade" | "without-upgrade" | "prompt";

/**
 * Put a fake `atomic` first on PATH, so `atomic update` never runs the host's real Atomic. It prints `version` for
 * `--version`, records `intercom upgrade` invocations, and exits `upgradeExitCode` for them.
 */
export function installFakeAtomicOnPath(
	directory: string,
	options: {
		version?: string;
		upgradeExitCode?: number;
		upgradeSignal?: NodeJS.Signals;
		intercom?: FakeIntercomCommand;
	} = {},
): FakeInstalledAtomic {
	const binDir = join(directory, "fake-installed-atomic-bin");
	const scriptPath = join(directory, "fake-installed-atomic.cjs");
	const recordPath = join(directory, "fake-installed-atomic-upgrades.jsonl");
	const stdoutRecordPath = join(directory, "fake-installed-atomic-upgrade-stdout.jsonl");
	const intercomRecordPath = join(directory, "fake-installed-atomic-intercom.jsonl");
	const intercom = options.intercom ?? "with-upgrade";
	mkdirSync(binDir, { recursive: true });
	writeFileSync(
		scriptPath,
		[
			'const fs = require("node:fs");',
			'const os = require("node:os");',
			"const args = process.argv.slice(2);",
			"function stdinIsNull() {",
			"\ttry {",
			"\t\tconst stdin = fs.fstatSync(0);",
			"\t\tconst devNull = fs.statSync(os.devNull);",
			"\t\treturn stdin.dev === devNull.dev && stdin.ino === devNull.ino;",
			"\t} catch {",
			"\t\treturn true;",
			"\t}",
			"}",
			"function recordIntercom(call) {",
			`\tfs.appendFileSync(${JSON.stringify(intercomRecordPath)}, JSON.stringify({ call, stdinIsNull: stdinIsNull() }) + "\\n");`,
			"}",
			'if (args[0] === "intercom" && args[1] === "--help") {',
			'\trecordIntercom("help");',
			...(intercom === "prompt"
				? ['\tconsole.log("Usage: atomic [options] [@files...] [messages...]");']
				: [
						'\tconsole.log("Usage:\\n  atomic intercom status\\n  atomic intercom restart");',
						...(intercom === "with-upgrade" ? ['\tconsole.log("  atomic intercom upgrade");'] : []),
					]),
			"\tprocess.exit(0);",
			"}",
			'if (args[0] === "intercom" && args[1] === "upgrade") {',
			...(intercom === "prompt"
				? [
						'\trecordIntercom("prompt");',
						'\tconsole.error("No API key found for the selected model.");',
						"\tprocess.exit(1);",
					]
				: ['\trecordIntercom("upgrade");']),
			...(intercom === "without-upgrade"
				? ["\tconsole.error('Unknown intercom command \"upgrade\".');", "\tprocess.exit(1);"]
				: []),
			`\tfs.appendFileSync(${JSON.stringify(recordPath)}, JSON.stringify({ args, packageDir: process.env.ATOMIC_PACKAGE_DIR ?? null }) + "\\n");`,
			"\tconst stdout = fs.fstatSync(1);",
			`\tfs.appendFileSync(${JSON.stringify(stdoutRecordPath)}, JSON.stringify({ dev: stdout.dev, ino: stdout.ino }) + "\\n");`,
			...(options.upgradeSignal === undefined
				? []
				: [`\tprocess.kill(process.pid, ${JSON.stringify(options.upgradeSignal)});`]),
			`\tprocess.exit(${options.upgradeExitCode ?? 0});`,
			"}",
			`console.log(${JSON.stringify(options.version ?? "0.0.0")});`,
			"",
		].join("\n"),
	);
	const shimPath = join(binDir, process.platform === "win32" ? "atomic.cmd" : "atomic");
	writeFileSync(
		shimPath,
		process.platform === "win32"
			? `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`
			: `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`,
	);
	chmodSync(shimPath, 0o755);
	vi.stubEnv("PATH", `${binDir}${delimiter}${process.env.PATH ?? ""}`);
	return {
		upgradeCalls: () =>
			existsSync(recordPath)
				? readFileSync(recordPath, "utf8")
						.split("\n")
						.filter(Boolean)
						.map((line) => JSON.parse(line) as { args: string[]; packageDir: string | null })
				: [],
		intercomCalls: () =>
			existsSync(intercomRecordPath)
				? readFileSync(intercomRecordPath, "utf8")
						.split("\n")
						.filter(Boolean)
						.map((line) => JSON.parse(line) as { call: "help" | "upgrade" | "prompt"; stdinIsNull: boolean })
				: [],
		upgradeStdout: () =>
			existsSync(stdoutRecordPath)
				? readFileSync(stdoutRecordPath, "utf8")
						.split("\n")
						.filter(Boolean)
						.map((line) => JSON.parse(line) as { dev: number; ino: number })
				: [],
	};
}
