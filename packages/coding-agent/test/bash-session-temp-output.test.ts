/**
 * The bash overflow log, the bash tool's `Full output:` path, and the async bash
 * spill log all land inside the session temp directory instead of the bare
 * system temp directory.
 */
import assert from "node:assert/strict";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";
import { executeBashWithOperations } from "../src/core/bash-executor.ts";
import type { BashOperations } from "../src/core/tools/bash.ts";
import { createBashToolDefinition } from "../src/core/tools/bash.ts";
import { createAsyncOutputAppender } from "../src/core/tools/bash-async-output.ts";
import { OutputAccumulator } from "../src/core/tools/output-accumulator.ts";
import {
	getTempRootDir,
	resetSessionTempDirStateForTesting,
	resolveSessionTempDirPath,
} from "../src/core/tools/session-temp-dir.ts";
import { DEFAULT_MAX_BYTES } from "../src/core/tools/truncate.ts";

/** Captured before the sandbox override below, so tests can reach the real temp directory. */
const realTmpdir = tmpdir();

const envKeys = ["TMPDIR", "TEMP", "TMP"] as const;
const savedEnv = new Map<string, string | undefined>();
let sandbox: string;

const SESSION_ID = "bash-output-session";
const LINE = `${"x".repeat(99)}\n`;
const OVERSIZED_OUTPUT = LINE.repeat(Math.ceil((DEFAULT_MAX_BYTES * 2) / LINE.length));

beforeAll(() => {
	sandbox = realpathSync(mkdtempSync(join(tmpdir(), "atomic-bash-session-temp-")));
	for (const key of envKeys) {
		savedEnv.set(key, process.env[key]);
		process.env[key] = sandbox;
	}
	resetSessionTempDirStateForTesting();
});

afterAll(() => {
	for (const key of envKeys) {
		const saved = savedEnv.get(key);
		if (saved === undefined) delete process.env[key];
		else process.env[key] = saved;
	}
	resetSessionTempDirStateForTesting();
	rmSync(sandbox, { recursive: true, force: true });
});
function isInside(parent: string, child: string): boolean {
	const rel = relative(parent, child);
	return rel.length > 0 && !rel.startsWith("..") && !rel.startsWith(`${sep}..`);
}

/** The overflow log is flushed asynchronously after `end()`; wait for it to land. */
async function waitForFile(path: string): Promise<boolean> {
	for (let attempt = 0; attempt < 50 && !existsSync(path); attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	return existsSync(path);
}

/** Bash backend that streams a fixed payload without spawning a shell. */
function fakeOperations(payload: string): BashOperations {
	return {
		exec: async (_command, _cwd, { onData }) => {
			onData(Buffer.from(payload, "utf8"), "stdout");
			return { exitCode: 0 };
		},
	};
}

describe("bash overflow logs live in the session temp directory", () => {
	it("writes the executor's full-output log under the session temp directory", async () => {
		const sessionTempDir = resolveSessionTempDirPath(SESSION_ID);
		const result = await executeBashWithOperations("echo big", process.cwd(), fakeOperations(OVERSIZED_OUTPUT), {
			sessionTempDir,
		});

		assert.equal(result.truncated, true);
		assert.ok(result.fullOutputPath, "expected an overflow log path");
		assert.ok(
			isInside(sessionTempDir, result.fullOutputPath),
			`${result.fullOutputPath} is not inside ${sessionTempDir}`,
		);
		assert.equal(await waitForFile(result.fullOutputPath), true);
	});

	it("recreates a session temp directory that was deleted underneath a live session", async () => {
		const sessionId = "reaped-session";
		const sessionTempDir = resolveSessionTempDirPath(sessionId);

		const first = await executeBashWithOperations("echo big", process.cwd(), fakeOperations(OVERSIZED_OUTPUT), {
			sessionTempDir,
		});
		assert.ok(first.fullOutputPath);
		assert.equal(existsSync(first.fullOutputPath), true);

		// A system temp reaper (or another process's sweep) removes the tree while
		// the session is still running; the memoized path must be revalidated.
		rmSync(sessionTempDir, { recursive: true, force: true });
		assert.equal(existsSync(sessionTempDir), false);

		const second = await executeBashWithOperations("echo big", process.cwd(), fakeOperations(OVERSIZED_OUTPUT), {
			sessionTempDir,
		});
		assert.ok(second.fullOutputPath, "the overflow log path must survive a reaped session directory");
		assert.ok(isInside(sessionTempDir, second.fullOutputPath));
		assert.equal(existsSync(second.fullOutputPath), true, "the spill file must actually be written");
		assert.equal(readFileSync(second.fullOutputPath, "utf8").length > 0, true);
	});

	it("points the bash tool's 'Full output:' path inside the session temp directory", async () => {
		const sessionTempDir = resolveSessionTempDirPath(SESSION_ID);
		const definition = createBashToolDefinition(process.cwd(), {
			operations: fakeOperations(OVERSIZED_OUTPUT),
			sessionTempDir: () => sessionTempDir,
		});

		const result = await definition.execute("call-1", { command: "echo big" });
		const text = result.content.map((block) => (block.type === "text" ? block.text : "")).join("");
		const savedPath = text.match(/Full output: (.+?)]/)?.[1];
		assert.ok(savedPath, `expected a 'Full output:' path in:\n${text.slice(-500)}`);
		assert.ok(isInside(sessionTempDir, savedPath), `${savedPath} is not inside ${sessionTempDir}`);
		assert.equal(result.details?.fullOutputPath, savedPath);
		assert.equal(await waitForFile(savedPath), true);
	});

	it("writes async bash spill logs under the session temp directory", async () => {
		const sessionTempDir = resolveSessionTempDirPath(SESSION_ID);
		const job = { output: "" };
		const appender = createAsyncOutputAppender(job, { persistAfterBytes: 16, sessionTempDir });
		appender.append(Buffer.from(OVERSIZED_OUTPUT, "utf8"));
		await appender.close();

		const path = (job as { fullOutputPath?: string }).fullOutputPath;
		assert.ok(path, "expected an async spill log path");
		assert.ok(isInside(sessionTempDir, path), `${path} is not inside ${sessionTempDir}`);
		assert.equal(readFileSync(path, "utf8").length, OVERSIZED_OUTPUT.length);
	});

	it("defaults an accumulator without an explicit directory to the active session tree", async () => {
		const accumulator = new OutputAccumulator({ tempFilePrefix: "atomic-test" });
		accumulator.append(Buffer.from(OVERSIZED_OUTPUT, "utf8"));
		accumulator.finish();
		const snapshot = accumulator.snapshot({ persistIfTruncated: true });
		await accumulator.closeTempFile();

		assert.ok(snapshot.fullOutputPath);
		assert.ok(isInside(resolveSessionTempDirPath(), snapshot.fullOutputPath));
	});

	it.skipIf(process.platform === "win32")(
		"runs without an overflow log when the owner root is refused, instead of writing outside it",
		async () => {
			const outside = join(sandbox, "attacker-root-target");
			mkdirSync(outside, { recursive: true });
			const root = getTempRootDir();
			rmSync(root, { recursive: true, force: true });
			resetSessionTempDirStateForTesting();
			symlinkSync(outside, root, "dir");

			try {
				const result = await executeBashWithOperations(
					"echo big",
					process.cwd(),
					fakeOperations(OVERSIZED_OUTPUT),
					{ sessionTempDir: resolveSessionTempDirPath("refused-session") },
				);

				assert.equal(result.truncated, true, "output is still truncated for the model");
				assert.equal(result.fullOutputPath, undefined, "no path is advertised when the root is refused");
				assert.deepEqual(readdirSync(outside), [], "nothing is written through the planted link");
				assert.equal(lstatSync(root).isSymbolicLink(), true, "the link itself is untouched");
			} finally {
				rmSync(root, { force: true });
				resetSessionTempDirStateForTesting();
			}
		},
	);
});

describe("the bash tool never advertises a path it could not write", () => {
	/**
	 * Run the real tool definition against a session temp directory that cannot be
	 * created, and assert the model-facing result on every refusal mode.
	 */
	async function expectNoAdvertisedPath(sessionTempDir: string): Promise<void> {
		const definition = createBashToolDefinition(process.cwd(), {
			operations: fakeOperations(OVERSIZED_OUTPUT),
			sessionTempDir: () => sessionTempDir,
		});

		const result = await definition.execute("call-refused", { command: "echo big" });
		const text = result.content.map((block) => (block.type === "text" ? block.text : "")).join("");

		assert.ok(text.includes("[Showing lines"), `truncation must survive, got:\n${text.slice(-300)}`);
		assert.equal(
			text.includes("undefined"),
			false,
			`the model must never be handed "undefined":\n${text.slice(-300)}`,
		);
		assert.equal(text.includes("Full output:"), false, "no path clause when there is no path");
		assert.equal(result.details?.fullOutputPath, undefined);
		assert.equal(result.details?.truncation?.truncated, true);
	}

	it.skipIf(process.platform === "win32")("when the owner root is a symlink", async () => {
		const outside = join(sandbox, "tool-symlink-target");
		mkdirSync(outside, { recursive: true });
		const root = getTempRootDir();
		rmSync(root, { recursive: true, force: true });
		resetSessionTempDirStateForTesting();
		symlinkSync(outside, root, "dir");

		try {
			await expectNoAdvertisedPath(resolveSessionTempDirPath("symlink-refused"));
			assert.deepEqual(readdirSync(outside), [], "nothing is written through the planted link");
		} finally {
			rmSync(root, { force: true });
			resetSessionTempDirStateForTesting();
		}
	});

	it.skipIf(process.platform === "win32")("when creating the session directory is denied", async () => {
		// Outside the owner-scoped tree, where the component walk does not apply, so
		// the write permission is genuinely missing rather than tightened back. This
		// is the shape a locked-down volume or an exhausted quota produces.
		const lockedRoot = realpathSync(mkdtempSync(join(realTmpdir, "atomic-locked-")));
		const locked = join(lockedRoot, "locked");
		mkdirSync(locked, { recursive: true });
		chmodSync(locked, 0o500);
		resetSessionTempDirStateForTesting();

		try {
			await expectNoAdvertisedPath(join(locked, "denied-session"));
		} finally {
			chmodSync(locked, 0o700);
			rmSync(lockedRoot, { recursive: true, force: true });
			resetSessionTempDirStateForTesting();
		}
	});

	it("when the session directory's parent is not a directory", async () => {
		const notADirectory = join(sandbox, "occupied-parent");
		writeFileSync(notADirectory, "this is a file");
		resetSessionTempDirStateForTesting();

		try {
			await expectNoAdvertisedPath(join(notADirectory, "child-session"));
		} finally {
			resetSessionTempDirStateForTesting();
		}
	});
});
