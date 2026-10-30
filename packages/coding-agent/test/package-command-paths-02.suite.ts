import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR, PACKAGE_NAME, VERSION } from "../src/config.ts";
import { main } from "../src/main.ts";

describe("package commands", () => {
	let tempDir: string;
	let agentDir: string;
	let projectDir: string;
	let packageDir: string;
	let originalCwd: string;
	let originalAgentDir: string | undefined;
	let originalAtomicPackageDir: string | undefined;
	let originalExitCode: typeof process.exitCode;
	let originalExecPath: string;

	type WriteCallback = (error?: Error | null) => void;
	type WriteEncodingOrCallback = BufferEncoding | WriteCallback;

	function getWriteCallback(
		encodingOrCallback?: WriteEncodingOrCallback,
		callback?: WriteCallback,
	): WriteCallback | undefined {
		return typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
	}

	async function _waitForDrainMarker(getCallback: () => WriteCallback | undefined): Promise<WriteCallback> {
		for (let attempt = 0; attempt < 10; attempt++) {
			const callback = getCallback();
			if (callback) {
				return callback;
			}
			await Promise.resolve();
		}
		throw new Error("stdio drain marker was not written");
	}

	function _createWriteMock(onEmptyWrite: (callback: WriteCallback | undefined) => void): typeof process.stdout.write {
		return ((
			chunk: string | Uint8Array,
			encodingOrCallback?: WriteEncodingOrCallback,
			callback?: WriteCallback,
		): boolean => {
			const writeCallback = getWriteCallback(encodingOrCallback, callback);
			if (chunk === "") {
				onEmptyWrite(writeCallback);
				return true;
			}
			writeCallback?.();
			return true;
		}) as typeof process.stdout.write;
	}

	function expectSuccessfulExitCode(): void {
		expect(process.exitCode ?? 0).toBe(0);
	}

	function getNewerPatchVersion(): string {
		const [major = "0", minor = "0", patch = "0"] = VERSION.split(".");
		return `${major}.${minor}.${Number.parseInt(patch, 10) + 1}`;
	}

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-package-commands-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		projectDir = join(tempDir, "project");
		packageDir = join(tempDir, "local-package");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		mkdirSync(packageDir, { recursive: true });

		originalCwd = process.cwd();
		originalAgentDir = process.env[ENV_AGENT_DIR];
		originalAtomicPackageDir = process.env.ATOMIC_PACKAGE_DIR;
		originalExitCode = process.exitCode;
		originalExecPath = process.execPath;
		process.exitCode = 0;
		vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
			if (code === undefined || code === null || Number(code) === 0) {
				process.exitCode = 0;
			} else {
				process.exitCode = code;
			}
			return undefined as never;
		}) as typeof process.exit);
		process.env[ENV_AGENT_DIR] = agentDir;
		process.chdir(projectDir);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		process.chdir(originalCwd);
		process.exitCode = originalExitCode ?? 0;
		if (originalAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = originalAgentDir;
		}
		if (originalAtomicPackageDir === undefined) {
			delete process.env.ATOMIC_PACKAGE_DIR;
		} else {
			process.env.ATOMIC_PACKAGE_DIR = originalAtomicPackageDir;
		}
		Object.defineProperty(process, "execPath", {
			value: originalExecPath,
			configurable: true,
		});
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("installs the active package name from the update check during self-update", async () => {
		const globalPrefix = join(tempDir, "global-prefix");
		const selfPackageDir = join(globalPrefix, "lib", "node_modules", "@bastani", "atomic");
		const fakeNpmPath = join(tempDir, "fake-npm.cjs");
		const recordPath = join(tempDir, "self-update.json");
		mkdirSync(selfPackageDir, { recursive: true });
		writeFileSync(
			fakeNpmPath,
			`const fs=require("node:fs"),path=require("node:path"),args=process.argv.slice(2),prefix=args[args.indexOf("--prefix")+1];
if(args.includes("root")) console.log(path.join(prefix,"lib","node_modules"));
else {
	const records=fs.existsSync(${JSON.stringify(recordPath)})?JSON.parse(fs.readFileSync(${JSON.stringify(recordPath)},"utf-8")):[];
	records.push(args);
	fs.writeFileSync(${JSON.stringify(recordPath)},JSON.stringify(records));
}
`,
		);
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify(
				{
					npmCommand: [originalExecPath, fakeNpmPath, "--prefix", globalPrefix],
				},
				null,
				2,
			),
		);
		process.env.ATOMIC_PACKAGE_DIR = selfPackageDir;
		Object.defineProperty(process, "execPath", {
			value: join(selfPackageDir, "dist", "cli.js"),
			configurable: true,
		});
		const activePackageName = PACKAGE_NAME === "@new-scope/pi" ? "@newer-scope/pi" : "@new-scope/pi";
		vi.spyOn(globalThis, "fetch").mockImplementation(
			vi.fn(async () => Response.json({ name: activePackageName, version: "0.73.0" })),
		);

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(main(["update", "--self"])).resolves.toBeUndefined();

			expectSuccessfulExitCode();
			expect(errorSpy).not.toHaveBeenCalled();
			const recordedCalls = JSON.parse(readFileSync(recordPath, "utf-8")) as string[][];
			expect(recordedCalls).toEqual([
				expect.arrayContaining(["uninstall", "-g", PACKAGE_NAME]),
				expect.arrayContaining(["install", "-g", `${activePackageName}@0.73.0`]),
			]);
		} finally {
			logSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});
	it("fails self-update when renamed npm package installation fails", async () => {
		const globalPrefix = join(tempDir, "global-prefix");
		const selfPackageDir = join(globalPrefix, "lib", "node_modules", "@bastani", "atomic");
		const fakeNpmPath = join(tempDir, "fake-npm-fail.cjs");
		const recordPath = join(tempDir, "self-update-fail.json");
		mkdirSync(selfPackageDir, { recursive: true });
		writeFileSync(
			fakeNpmPath,
			`const fs=require("node:fs"),path=require("node:path"),args=process.argv.slice(2),prefix=args[args.indexOf("--prefix")+1];
if(args.includes("root")) {
	console.log(path.join(prefix,"lib","node_modules"));
	process.exit(0);
}
const records=fs.existsSync(${JSON.stringify(recordPath)})?JSON.parse(fs.readFileSync(${JSON.stringify(recordPath)},"utf-8")):[];
records.push(args);
fs.writeFileSync(${JSON.stringify(recordPath)},JSON.stringify(records));
if(args.includes("install")) process.exit(23);
`,
		);
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify(
				{
					npmCommand: [originalExecPath, fakeNpmPath, "--prefix", globalPrefix],
				},
				null,
				2,
			),
		);
		process.env.ATOMIC_PACKAGE_DIR = selfPackageDir;
		Object.defineProperty(process, "execPath", {
			value: join(selfPackageDir, "dist", "cli.js"),
			configurable: true,
		});
		const activePackageName = PACKAGE_NAME === "@new-scope/pi" ? "@newer-scope/pi" : "@new-scope/pi";
		vi.spyOn(globalThis, "fetch").mockImplementation(
			vi.fn(async () => Response.json({ name: activePackageName, version: "0.73.0" })),
		);

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(main(["update", "--self"])).resolves.toBeUndefined();

			expect(process.exitCode).toBe(1);
			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			const stderr = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stdout).not.toContain(`Updated pi`);
			expect(stderr).toContain("exited with code 23");
			const recordedCalls = JSON.parse(readFileSync(recordPath, "utf-8")) as string[][];
			expect(recordedCalls).toEqual([
				expect.arrayContaining(["uninstall", "-g", PACKAGE_NAME]),
				expect.arrayContaining(["install", "-g", `${activePackageName}@0.73.0`]),
			]);
		} finally {
			logSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});
	function writeNodeShim(binDir: string, name: string, scriptPath: string): void {
		const shimPath = join(binDir, process.platform === "win32" ? `${name}.cmd` : name);
		writeFileSync(
			shimPath,
			process.platform === "win32"
				? `@echo off\r\n"${originalExecPath}" "${scriptPath}" %*\r\n`
				: `#!/bin/sh\nexec "${originalExecPath}" "${scriptPath}" "$@"\n`,
		);
		chmodSync(shimPath, 0o755);
	}

	/** Put an `atomic-wrapper` update command that records its arguments and exits `exitCode`, and an `atomic` that prints `atomicVersion`, first on PATH. */
	function prepareSelfUpdateCommand(atomicVersion: string, exitCode = 0): { scriptPath: string; recordPath: string } {
		const binDir = join(tempDir, "self-update-bin");
		const scriptPath = join(tempDir, "self-update.cjs");
		const atomicScriptPath = join(tempDir, "fake-atomic.cjs");
		const recordPath = join(tempDir, "self-update-record.json");
		mkdirSync(binDir, { recursive: true });
		writeFileSync(
			scriptPath,
			`require("node:fs").writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify(process.argv.slice(2)));\nprocess.exit(${exitCode});\n`,
		);
		writeFileSync(atomicScriptPath, `console.log(${JSON.stringify(atomicVersion)});\n`);
		writeNodeShim(binDir, "atomic-wrapper", scriptPath);
		writeNodeShim(binDir, "atomic", atomicScriptPath);
		vi.stubEnv("PATH", `${binDir}${delimiter}${process.env.PATH ?? ""}`);
		return { scriptPath, recordPath };
	}

	it("runs ATOMIC_SELF_UPDATE_COMMAND instead of the selfUpdateCommand setting and the detected install method", async () => {
		const targetVersion = getNewerPatchVersion();
		const { scriptPath, recordPath } = prepareSelfUpdateCommand(targetVersion);
		const settingRecordPath = join(tempDir, "setting-record.json");
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ selfUpdateCommand: [originalExecPath, scriptPath, settingRecordPath] }),
		);
		vi.stubEnv("ATOMIC_SELF_UPDATE_COMMAND", "atomic-wrapper upgrade {installSpec} {version}");
		vi.spyOn(globalThis, "fetch").mockImplementation(
			vi.fn(async () => Response.json({ name: "@new-scope/pi", version: targetVersion, note: "Read me" })),
		);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(main(["update", "--self"])).resolves.toBeUndefined();

			expect(JSON.parse(readFileSync(recordPath, "utf8")) as string[]).toEqual([
				"upgrade",
				`@new-scope/pi@${targetVersion}`,
				targetVersion,
			]);
			expect(existsSync(settingRecordPath)).toBe(false);
			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stdout).toContain("Read me");
			// A wrapper leaves this installation untouched; the atomic on PATH reports the new version.
			expect(stdout).toContain(`Updated atomic from ${VERSION} to ${targetVersion}`);
			expect(errorSpy).not.toHaveBeenCalled();
			expectSuccessfulExitCode();
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("also reads the legacy PI_SELF_UPDATE_COMMAND alias", async () => {
		const targetVersion = getNewerPatchVersion();
		const { recordPath } = prepareSelfUpdateCommand(targetVersion);
		vi.stubEnv("PI_SELF_UPDATE_COMMAND", "atomic-wrapper upgrade {packageName}");
		vi.spyOn(globalThis, "fetch").mockImplementation(vi.fn(async () => Response.json({ version: targetVersion })));
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(main(["update", "--self"])).resolves.toBeUndefined();

			expect(JSON.parse(readFileSync(recordPath, "utf8")) as string[]).toEqual(["upgrade", PACKAGE_NAME]);
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("runs the global selfUpdateCommand setting, never the project's, and only when a newer release exists", async () => {
		const targetVersion = getNewerPatchVersion();
		const { scriptPath, recordPath } = prepareSelfUpdateCommand(targetVersion);
		const projectRecordPath = join(tempDir, "project-record.json");
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ selfUpdateCommand: [originalExecPath, scriptPath, "{packageName}"] }),
		);
		mkdirSync(join(projectDir, ".atomic"), { recursive: true });
		writeFileSync(
			join(projectDir, ".atomic", "settings.json"),
			JSON.stringify({ selfUpdateCommand: [originalExecPath, scriptPath, projectRecordPath] }),
		);
		vi.stubEnv("ATOMIC_SELF_UPDATE_COMMAND", "");
		vi.stubEnv("PI_SELF_UPDATE_COMMAND", "");
		const fetchMock = vi.fn(async () => Response.json({ version: VERSION }));
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(main(["update", "--self"])).resolves.toBeUndefined();
			expect(existsSync(recordPath)).toBe(false);
			expect(logSpy.mock.calls.map(([message]) => String(message)).join("\n")).toContain(
				`atomic is already up to date (v${VERSION})`,
			);

			fetchMock.mockImplementation(async () => Response.json({ version: targetVersion }));
			await expect(main(["update", "--self"])).resolves.toBeUndefined();
			expect(JSON.parse(readFileSync(recordPath, "utf8")) as string[]).toEqual([PACKAGE_NAME]);
			expect(existsSync(projectRecordPath)).toBe(false);
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("warns when the atomic on PATH does not report the new version", async () => {
		const targetVersion = getNewerPatchVersion();
		prepareSelfUpdateCommand(VERSION);
		vi.stubEnv("ATOMIC_SELF_UPDATE_COMMAND", "atomic-wrapper upgrade");
		vi.spyOn(globalThis, "fetch").mockImplementation(vi.fn(async () => Response.json({ version: targetVersion })));
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(main(["update", "--self"])).resolves.toBeUndefined();

			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stdout).toContain(
				`Ran atomic-wrapper upgrade, but \`atomic --version\` reports ${VERSION}, not ${targetVersion}.`,
			);
			expect(stdout).not.toContain("Updated atomic from");
			expectSuccessfulExitCode();
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("fails when the configured self-update command fails", async () => {
		prepareSelfUpdateCommand(VERSION, 23);
		vi.stubEnv("ATOMIC_SELF_UPDATE_COMMAND", "atomic-wrapper upgrade");
		vi.spyOn(globalThis, "fetch").mockImplementation(
			vi.fn(async () => Response.json({ version: getNewerPatchVersion() })),
		);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(main(["update", "--self"])).resolves.toBeUndefined();

			expect(errorSpy.mock.calls.map(([message]) => String(message)).join("\n")).toContain(
				"atomic-wrapper upgrade exited with code 23",
			);
			expect(logSpy.mock.calls.map(([message]) => String(message)).join("\n")).not.toContain("Ran atomic-wrapper");
			expect(process.exitCode).toBe(1);
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("suggests the configured source when update input omits the npm prefix", async () => {
		const settingsPath = join(agentDir, "settings.json");
		writeFileSync(settingsPath, JSON.stringify({ packages: ["npm:pi-formatter"] }, null, 2));

		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(main(["update", "pi-formatter"])).resolves.toBeUndefined();

			const stderr = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stderr).toContain("Did you mean npm:pi-formatter?");
			expect(stdout).not.toContain("Updated pi-formatter");
			expect(process.exitCode).toBe(1);

			const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
				packages?: string[];
			};
			expect(settings.packages).toContain("npm:pi-formatter");
		} finally {
			errorSpy.mockRestore();
			logSpy.mockRestore();
		}
	});
	it("uses the current package name when the update check omits packageName", async () => {
		const targetVersion = getNewerPatchVersion();
		const globalPrefix = join(tempDir, "global-prefix");
		const selfPackageDir = join(globalPrefix, "lib", "node_modules", "@bastani", "atomic");
		const fakeNpmPath = join(tempDir, "fake-npm.cjs");
		const recordPath = join(tempDir, "self-update.json");
		mkdirSync(selfPackageDir, { recursive: true });
		writeFileSync(
			fakeNpmPath,
			`const fs=require("node:fs"),path=require("node:path"),args=process.argv.slice(2),prefix=args[args.indexOf("--prefix")+1];
if(args.includes("root")) console.log(path.join(prefix,"lib","node_modules"));
else fs.writeFileSync(${JSON.stringify(recordPath)},JSON.stringify(args));
`,
		);
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ npmCommand: [originalExecPath, fakeNpmPath, "--prefix", globalPrefix] }, null, 2),
		);
		process.env.ATOMIC_PACKAGE_DIR = selfPackageDir;
		Object.defineProperty(process, "execPath", {
			value: join(selfPackageDir, "dist", "cli.js"),
			configurable: true,
		});
		const fetchMock = vi.fn(async () => Response.json({ version: targetVersion }));
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(main(["update", "--self"])).resolves.toBeUndefined();
			expectSuccessfulExitCode();
			expect(errorSpy).not.toHaveBeenCalled();
			expect(fetchMock).toHaveBeenCalledOnce();
			const recordedArgs = JSON.parse(readFileSync(recordPath, "utf-8")) as string[];
			expect(recordedArgs).toContain(`${PACKAGE_NAME}@${targetVersion}`);
			expect(recordedArgs).not.toContain(PACKAGE_NAME);
			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stdout).toContain(`Updated atomic from ${VERSION} to ${targetVersion}`);
		} finally {
			logSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});
});
