import { fstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR, PACKAGE_NAME, VERSION } from "../src/config.ts";
import { main } from "../src/main.ts";
import { type FakeInstalledAtomic, installFakeAtomicOnPath } from "./helpers/fake-installed-atomic.ts";

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
	let fakeAtomic: FakeInstalledAtomic;

	type WriteCallback = (error?: Error | null) => void;
	type WriteEncodingOrCallback = BufferEncoding | WriteCallback;

	function getWriteCallback(
		encodingOrCallback?: WriteEncodingOrCallback,
		callback?: WriteCallback,
	): WriteCallback | undefined {
		return typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
	}

	async function waitForDrainMarker(getCallback: () => WriteCallback | undefined): Promise<WriteCallback> {
		for (let attempt = 0; attempt < 10; attempt++) {
			const callback = getCallback();
			if (callback) {
				return callback;
			}
			await Promise.resolve();
		}
		throw new Error("stdio drain marker was not written");
	}

	function createWriteMock(onEmptyWrite: (callback: WriteCallback | undefined) => void): typeof process.stdout.write {
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
		// `atomic update` runs the installed `atomic intercom upgrade`; never let a test reach the host's real Atomic.
		fakeAtomic = installFakeAtomicOnPath(tempDir);
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
		vi.unstubAllEnvs();
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

	it("should persist global relative local package paths relative to settings.json", async () => {
		const relativePkgDir = join(projectDir, "packages", "local-package");
		mkdirSync(relativePkgDir, { recursive: true });

		await main(["install", "./packages/local-package"]);

		const settingsPath = join(agentDir, "settings.json");
		const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
			packages?: string[];
		};
		expect(settings.packages?.length).toBe(1);
		const stored = settings.packages?.[0] ?? "";
		const resolvedFromSettings = realpathSync(join(agentDir, stored));
		expect(resolvedFromSettings).toBe(realpathSync(relativePkgDir));
	});
	it("should remove local packages using a path with a trailing slash", async () => {
		await main(["install", `${packageDir}/`]);

		const settingsPath = join(agentDir, "settings.json");
		const installedSettings = JSON.parse(readFileSync(settingsPath, "utf-8")) as { packages?: string[] };
		expect(installedSettings.packages?.length).toBe(1);

		await main(["remove", `${packageDir}/`]);

		const removedSettings = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
			packages?: string[];
		};
		expect(removedSettings.packages ?? []).toHaveLength(0);
	});
	it("does not list project packages when project trust is denied", async () => {
		mkdirSync(join(projectDir, ".atomic"), { recursive: true });
		writeFileSync(
			join(projectDir, ".atomic", "settings.json"),
			JSON.stringify({ packages: ["npm:pi-formatter"] }, null, 2),
		);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(main(["list", "--no-approve"])).resolves.toBeUndefined();

			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stdout).not.toContain("Project packages:");
			expect(stdout).not.toContain("npm:pi-formatter");
			expect(stdout).toContain("No packages installed.");
		} finally {
			logSpy.mockRestore();
		}
	});
	it("lists project packages when project trust is approved", async () => {
		mkdirSync(join(projectDir, ".atomic"), { recursive: true });
		writeFileSync(
			join(projectDir, ".atomic", "settings.json"),
			JSON.stringify({ packages: ["npm:pi-formatter"] }, null, 2),
		);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(main(["list", "--approve"])).resolves.toBeUndefined();

			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stdout).toContain("Project packages:");
			expect(stdout).toContain("npm:pi-formatter");
		} finally {
			logSpy.mockRestore();
		}
	});
	it("refuses local package writes when project trust is denied", async () => {
		mkdirSync(join(projectDir, ".atomic"), { recursive: true });
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(main(["install", packageDir, "--local", "--no-approve"])).resolves.toBeUndefined();

			const stderr = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stderr).toContain("Project is not trusted");
			expect(process.exitCode).toBe(1);
			const settingsPath = join(projectDir, ".atomic", "settings.json");
			expect(() => readFileSync(settingsPath, "utf-8")).toThrow();
		} finally {
			errorSpy.mockRestore();
		}
	});
	it("shows install subcommand help", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(main(["install", "--help"])).resolves.toBeUndefined();

			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stdout).toContain("Usage:");
			expect(stdout).toContain("atomic install <source> [-l]");
			expect(errorSpy).not.toHaveBeenCalled();
			expectSuccessfulExitCode();
		} finally {
			logSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});
	it("drains stdout before forcing package-command help exit", async () => {
		let stdoutDrainCallback: WriteCallback | undefined;
		let stdoutDrainReleased = false;
		let runPromise: Promise<void> | undefined;
		const stdoutWriteSpy = vi.spyOn(process.stdout, "write").mockImplementation(
			createWriteMock((callback) => {
				stdoutDrainCallback = callback;
			}),
		);
		const stderrWriteSpy = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(createWriteMock((callback) => callback?.()));
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			runPromise = main(["install", "--help"]);
			const releaseStdoutDrain = await waitForDrainMarker(() => stdoutDrainCallback);

			expect(process.exit).not.toHaveBeenCalled();
			expect(stdoutWriteSpy).toHaveBeenCalledWith("", expect.any(Function));
			expect(stderrWriteSpy).toHaveBeenCalledWith("", expect.any(Function));

			stdoutDrainReleased = true;
			releaseStdoutDrain();
			await expect(runPromise).resolves.toBeUndefined();

			expect(process.exit).toHaveBeenCalledWith(0);
			expect(errorSpy).not.toHaveBeenCalled();
			expectSuccessfulExitCode();
		} finally {
			if (!stdoutDrainReleased) {
				stdoutDrainCallback?.();
			}
			if (runPromise) {
				await runPromise.catch(() => undefined);
			}
			logSpy.mockRestore();
			errorSpy.mockRestore();
			stdoutWriteSpy.mockRestore();
			stderrWriteSpy.mockRestore();
		}
	});
	it("shows a friendly error for unknown install options", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(main(["install", "--unknown"])).resolves.toBeUndefined();

			const stderr = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stderr).toContain('Unknown option --unknown for "install".');
			expect(stderr).toContain('Use "atomic --help" or "atomic install <source> [-l] [--approve|--no-approve]".');
			expect(process.exitCode).toBe(1);
		} finally {
			errorSpy.mockRestore();
		}
	});
	it("drains stderr before forcing package-command error exit", async () => {
		let stderrDrainCallback: WriteCallback | undefined;
		let stderrDrainReleased = false;
		let runPromise: Promise<void> | undefined;
		const stdoutWriteSpy = vi
			.spyOn(process.stdout, "write")
			.mockImplementation(createWriteMock((callback) => callback?.()));
		const stderrWriteSpy = vi.spyOn(process.stderr, "write").mockImplementation(
			createWriteMock((callback) => {
				stderrDrainCallback = callback;
			}),
		);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			runPromise = main(["install", "--unknown"]);
			const releaseStderrDrain = await waitForDrainMarker(() => stderrDrainCallback);

			expect(process.exit).not.toHaveBeenCalled();
			expect(stdoutWriteSpy).toHaveBeenCalledWith("", expect.any(Function));
			expect(stderrWriteSpy).toHaveBeenCalledWith("", expect.any(Function));

			stderrDrainReleased = true;
			releaseStderrDrain();
			await expect(runPromise).resolves.toBeUndefined();

			expect(process.exit).toHaveBeenCalledWith(1);
			expect(logSpy).not.toHaveBeenCalled();
			expect(process.exitCode).toBe(1);
		} finally {
			if (!stderrDrainReleased) {
				stderrDrainCallback?.();
			}
			if (runPromise) {
				await runPromise.catch(() => undefined);
			}
			logSpy.mockRestore();
			errorSpy.mockRestore();
			stdoutWriteSpy.mockRestore();
			stderrWriteSpy.mockRestore();
		}
	});
	it("shows a friendly error for missing install source", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(main(["install"])).resolves.toBeUndefined();

			const stderr = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stderr).toContain("Missing install source.");
			expect(stderr).toContain("Usage: atomic install <source> [-l]");
			expect(stderr).not.toContain("at ");
			expect(process.exitCode).toBe(1);
		} finally {
			errorSpy.mockRestore();
		}
	});
	it("uses the update check version for forced self updates even when current", async () => {
		const globalPrefix = join(tempDir, "global-prefix");
		const projectPrefix = join(tempDir, "project-prefix");
		const selfPackageDir = join(globalPrefix, "lib", "node_modules", "@bastani", "atomic");
		const fakeNpmPath = join(tempDir, "fake-npm.cjs");
		const recordPath = join(tempDir, "self-update.json");
		mkdirSync(selfPackageDir, { recursive: true });
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
		writeFileSync(
			fakeNpmPath,
			`const fs=require("node:fs"),path=require("node:path"),args=process.argv.slice(2),prefix=args[args.indexOf("--prefix")+1];
if(args.includes("root")) console.log(path.join(prefix,"lib","node_modules"));
else fs.writeFileSync(${JSON.stringify(recordPath)},JSON.stringify(args));
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
		writeFileSync(
			join(projectDir, ".pi", "settings.json"),
			JSON.stringify(
				{
					npmCommand: [originalExecPath, fakeNpmPath, "--prefix", projectPrefix],
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
		const fetchMock = vi.fn(async () => Response.json({ version: VERSION }));
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(main(["update", "--self", "--force"])).resolves.toBeUndefined();

			expectSuccessfulExitCode();
			expect(errorSpy).not.toHaveBeenCalled();
			expect(fetchMock).toHaveBeenCalledOnce();
			const recordedArgs = JSON.parse(readFileSync(recordPath, "utf-8")) as string[];
			expect(recordedArgs).toContain(globalPrefix);
			expect(recordedArgs).toContain(`${PACKAGE_NAME}@${VERSION}`);
			expect(recordedArgs).not.toContain(PACKAGE_NAME);
			expect(recordedArgs).not.toContain(projectPrefix);
			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stdout).toContain(`Updated atomic from ${VERSION} to ${VERSION}`);
			// The new Atomic is asked to retire an older Intercom broker, without this installation's package override.
			expect(fakeAtomic.upgradeCalls()).toEqual([{ args: ["intercom", "upgrade"], packageDir: null }]);
			// Its output reaches the user's terminal: the upgrade writes to this process's own standard output.
			const ownStdout = fstatSync(1);
			expect(fakeAtomic.upgradeStdout()).toEqual([{ dev: ownStdout.dev, ino: ownStdout.ino }]);
			// It is asked whether it has the command first, and neither call reads this process's input.
			const intercomCalls = fakeAtomic.intercomCalls();
			expect(intercomCalls.map(({ call }) => call)).toEqual(["help", "upgrade"]);
			if (process.platform !== "win32") expect(intercomCalls.every(({ stdinIsNull }) => stdinIsNull)).toBe(true);
		} finally {
			logSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});

	/** A global npm install that succeeds, with `ATOMIC_PACKAGE_DIR` set the way a real npm install sets it. */
	function prepareSuccessfulNpmSelfUpdate(): void {
		const globalPrefix = join(tempDir, "global-prefix");
		const selfPackageDir = join(globalPrefix, "lib", "node_modules", "@bastani", "atomic");
		const fakeNpmPath = join(tempDir, "fake-npm.cjs");
		mkdirSync(selfPackageDir, { recursive: true });
		writeFileSync(
			fakeNpmPath,
			`const path=require("node:path"),args=process.argv.slice(2),prefix=args[args.indexOf("--prefix")+1];
if(args.includes("root")) console.log(path.join(prefix,"lib","node_modules"));
`,
		);
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ npmCommand: [originalExecPath, fakeNpmPath, "--prefix", globalPrefix] }),
		);
		process.env.ATOMIC_PACKAGE_DIR = selfPackageDir;
		Object.defineProperty(process, "execPath", {
			value: join(selfPackageDir, "dist", "cli.js"),
			configurable: true,
		});
		vi.spyOn(globalThis, "fetch").mockImplementation(vi.fn(async () => Response.json({ version: VERSION })));
	}

	it("only warns when the post-update 'intercom upgrade' fails, keeping the exit code (#4538)", async () => {
		fakeAtomic = installFakeAtomicOnPath(tempDir, { upgradeExitCode: 2 });
		prepareSuccessfulNpmSelfUpdate();
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(main(["update", "--self", "--force"])).resolves.toBeUndefined();

		expectSuccessfulExitCode();
		expect(fakeAtomic.upgradeCalls()).toHaveLength(1);
		expect(logSpy.mock.calls.map(([message]) => String(message)).join("\n")).toContain(
			`Updated atomic from ${VERSION} to ${VERSION}`,
		);
		const warnings = errorSpy.mock.calls.map(([message]) => String(message));
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("atomic intercom upgrade exited with code 2");
	});

	for (const [label, pathVersion] of [
		["is missing from PATH", undefined],
		["on PATH reports another version", "9.9.9"],
	] as const) {
		it(`leaves the Intercom broker alone with a note when \`atomic\` ${label} after the update (#4538)`, async () => {
			if (pathVersion === undefined) {
				const emptyBinDir = join(tempDir, "empty-bin");
				mkdirSync(emptyBinDir);
				vi.stubEnv("PATH", emptyBinDir);
			} else fakeAtomic = installFakeAtomicOnPath(tempDir, { version: pathVersion });
			prepareSuccessfulNpmSelfUpdate();
			const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

			await expect(main(["update", "--self", "--force"])).resolves.toBeUndefined();

			expectSuccessfulExitCode();
			expect(errorSpy).not.toHaveBeenCalled();
			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stdout).toContain(`Updated atomic from ${VERSION} to ${VERSION}`);
			expect(stdout).toContain(
				`\`atomic --version\` on PATH reports ${pathVersion ?? "no version"}, not ${VERSION}, so the Intercom broker was left as it is; run \`atomic intercom upgrade\` with the new version.`,
			);
			expect(fakeAtomic.intercomCalls()).toEqual([]);
		});
	}

	for (const [release, intercom] of [
		["0.9.42 to 0.9.71", "without-upgrade"],
		["0.9.41 and older", "prompt"],
		["a release whose help fails", "failing-help"],
	] as const) {
		it(`asks an installed Atomic of ${release} only for its help, never runs 'intercom upgrade' on it, and does not warn (#4538)`, async () => {
			fakeAtomic = installFakeAtomicOnPath(tempDir, { intercom });
			prepareSuccessfulNpmSelfUpdate();
			vi.spyOn(console, "log").mockImplementation(() => {});
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

			await expect(main(["update", "--self", "--force"])).resolves.toBeUndefined();

			expectSuccessfulExitCode();
			expect(errorSpy).not.toHaveBeenCalled();
			expect(fakeAtomic.intercomCalls().map(({ call }) => call)).toEqual(["help"]);
			expect(fakeAtomic.upgradeCalls()).toEqual([]);
		});
	}

	it.skipIf(process.platform === "win32")(
		"only warns when the post-update 'intercom upgrade' is terminated by a signal, keeping the exit code (#4538)",
		async () => {
			fakeAtomic = installFakeAtomicOnPath(tempDir, { upgradeSignal: "SIGKILL" });
			prepareSuccessfulNpmSelfUpdate();
			vi.spyOn(console, "log").mockImplementation(() => {});
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

			await expect(main(["update", "--self", "--force"])).resolves.toBeUndefined();

			expectSuccessfulExitCode();
			expect(fakeAtomic.upgradeCalls()).toHaveLength(1);
			const warnings = errorSpy.mock.calls.map(([message]) => String(message));
			expect(warnings).toHaveLength(1);
			expect(warnings[0]).toContain("atomic intercom upgrade terminated by signal SIGKILL");
		},
	);

	it("does not run 'intercom upgrade' when the self update fails (#4538)", async () => {
		prepareSuccessfulNpmSelfUpdate();
		writeFileSync(
			join(tempDir, "fake-npm.cjs"),
			`const path=require("node:path"),args=process.argv.slice(2),prefix=args[args.indexOf("--prefix")+1];
if(args.includes("root")) { console.log(path.join(prefix,"lib","node_modules")); process.exit(0); }
process.exit(23);
`,
		);
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(main(["update", "--self", "--force"])).resolves.toBeUndefined();

		expect(process.exitCode).toBe(1);
		expect(fakeAtomic.upgradeCalls()).toEqual([]);
	});
});
