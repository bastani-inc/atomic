import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { vi } from "vitest";

export interface FakeInstalledAtomic {
	/** Parsed `intercom upgrade` invocations the fake `atomic` on PATH received, in order. */
	upgradeCalls(): Array<{ args: string[]; packageDir: string | null }>;
}

/**
 * Put a fake `atomic` first on PATH, so `atomic update` never runs the host's real Atomic. It prints `version` for
 * `--version`, records `intercom upgrade` invocations, and exits `upgradeExitCode` for them.
 */
export function installFakeAtomicOnPath(
	directory: string,
	options: { version?: string; upgradeExitCode?: number } = {},
): FakeInstalledAtomic {
	const binDir = join(directory, "fake-installed-atomic-bin");
	const scriptPath = join(directory, "fake-installed-atomic.cjs");
	const recordPath = join(directory, "fake-installed-atomic-upgrades.jsonl");
	mkdirSync(binDir, { recursive: true });
	writeFileSync(
		scriptPath,
		[
			'const fs = require("node:fs");',
			"const args = process.argv.slice(2);",
			'if (args[0] === "intercom" && args[1] === "upgrade") {',
			`\tfs.appendFileSync(${JSON.stringify(recordPath)}, JSON.stringify({ args, packageDir: process.env.ATOMIC_PACKAGE_DIR ?? null }) + "\\n");`,
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
	};
}
