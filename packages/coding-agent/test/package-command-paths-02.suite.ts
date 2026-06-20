import {
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    return typeof encodingOrCallback === "function"
      ? encodingOrCallback
      : callback;
  }

  async function waitForDrainMarker(
    getCallback: () => WriteCallback | undefined,
  ): Promise<WriteCallback> {
    for (let attempt = 0; attempt < 10; attempt++) {
      const callback = getCallback();
      if (callback) {
        return callback;
      }
      await Promise.resolve();
    }
    throw new Error("stdio drain marker was not written");
  }

  function createWriteMock(
    onEmptyWrite: (callback: WriteCallback | undefined) => void,
  ): typeof process.stdout.write {
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
    tempDir = join(
      tmpdir(),
      `pi-package-commands-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
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
    const selfPackageDir = join(
      globalPrefix,
      "lib",
      "node_modules",
      "@bastani",
      "atomic",
    );
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
    const activePackageName =
      PACKAGE_NAME === "@new-scope/pi" ? "@newer-scope/pi" : "@new-scope/pi";
    vi.spyOn(globalThis, "fetch").mockImplementation(
      vi.fn(async () =>
        Response.json({ name: activePackageName, version: "0.73.0" }),
      ),
    );

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(main(["update", "--self"])).resolves.toBeUndefined();

      expectSuccessfulExitCode();
      expect(errorSpy).not.toHaveBeenCalled();
      const recordedCalls = JSON.parse(
        readFileSync(recordPath, "utf-8"),
      ) as string[][];
      expect(recordedCalls).toEqual([
        expect.arrayContaining(["uninstall", "-g", PACKAGE_NAME]),
        expect.arrayContaining(["install", "-g", activePackageName]),
      ]);
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
  it("fails self-update when renamed npm package installation fails", async () => {
    const globalPrefix = join(tempDir, "global-prefix");
    const selfPackageDir = join(
      globalPrefix,
      "lib",
      "node_modules",
      "@bastani",
      "atomic",
    );
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
    const activePackageName =
      PACKAGE_NAME === "@new-scope/pi" ? "@newer-scope/pi" : "@new-scope/pi";
    vi.spyOn(globalThis, "fetch").mockImplementation(
      vi.fn(async () =>
        Response.json({ name: activePackageName, version: "0.73.0" }),
      ),
    );

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(main(["update", "--self"])).resolves.toBeUndefined();

      expect(process.exitCode).toBe(1);
      const stdout = logSpy.mock.calls
        .map(([message]) => String(message))
        .join("\n");
      const stderr = errorSpy.mock.calls
        .map(([message]) => String(message))
        .join("\n");
      expect(stdout).not.toContain(`Updated pi`);
      expect(stderr).toContain("exited with code 23");
      const recordedCalls = JSON.parse(
        readFileSync(recordPath, "utf-8"),
      ) as string[][];
      expect(recordedCalls).toEqual([
        expect.arrayContaining(["uninstall", "-g", PACKAGE_NAME]),
        expect.arrayContaining(["install", "-g", activePackageName]),
      ]);
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
  it("suggests the configured source when update input omits the npm prefix", async () => {
    const settingsPath = join(agentDir, "settings.json");
    writeFileSync(
      settingsPath,
      JSON.stringify({ packages: ["npm:pi-formatter"] }, null, 2),
    );

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      await expect(main(["update", "pi-formatter"])).resolves.toBeUndefined();

      const stderr = errorSpy.mock.calls
        .map(([message]) => String(message))
        .join("\n");
      const stdout = logSpy.mock.calls
        .map(([message]) => String(message))
        .join("\n");
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
});
