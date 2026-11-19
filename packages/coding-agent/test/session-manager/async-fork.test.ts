import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fsPromises from "node:fs/promises";
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as fs from "fs";
import { test, vi } from "vitest";
import { SessionManager } from "../../src/core/session-manager.js";
import { SessionConflictError, StorageUnavailableError } from "../../src/core/storage/session/errors.js";
import { JsonlSessionStore } from "../../src/core/storage/session/jsonl-session-store.js";
import { MemorySessionStore } from "../../src/core/storage/session/memory-session-store.js";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual }; // Expose the synchronous entry points to the guard below.
});
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		open: vi.fn(actual.open),
		readFile: vi.fn(actual.readFile),
		writeFile: vi.fn(actual.writeFile),
		stat: vi.fn(actual.stat),
	};
});

test("streamed forks retain history and can append without replacing it (#3577)", async () => {
	const dir = await mkdtemp(join(tmpdir(), "session-stream-fork-"));
	try {
		const source = join(dir, "source.jsonl");
		const header = { type: "session", version: 4, id: "source", createdAt: new Date().toISOString(), cwd: dir };
		const entry = {
			type: "message",
			id: "history",
			parentId: null,
			timestamp: header.createdAt,
			message: { role: "user", content: "日本語".repeat(100_000), timestamp: 1 },
		};
		const content = `${JSON.stringify(header)}\n${JSON.stringify(entry)}`;
		await writeFile(source, content);
		const workflow = { runId: "run", stageId: "stage", stageName: "build" };
		const syncCalls = [
			"existsSync",
			"statSync",
			"readSync",
			"readFileSync",
			"writeFileSync",
			"appendFileSync",
			"mkdirSync",
		] as const;
		const spies = syncCalls.map((name) =>
			vi.spyOn(fs, name).mockImplementation(() => {
				throw new Error(`Unexpected synchronous filesystem call: ${name}`);
			}),
		);
		const opens = vi.mocked(fsPromises.open).mockClear();
		const wholeReads = vi.mocked(fsPromises.readFile).mockClear();
		const writes = vi.mocked(fsPromises.writeFile).mockClear();
		let fork: SessionManager;
		try {
			fork = await SessionManager.forkFrom(source, dir, join(dir, "forks"), { internal: true, workflow });
			assert.equal(opens.mock.calls.filter(([path]) => path === source).length, 1, "one pinned source file");
			assert.ok(!wholeReads.mock.calls.some(([path]) => path === source), "do not load the whole source file");
			assert.equal(writes.mock.calls.length, 1);
			assert.equal(String(writes.mock.calls[0][0]).startsWith(`${fork.getSessionFile()}.`), true);
			assert.equal(String(writes.mock.calls[0][0]).endsWith(".tmp"), true);
		} finally {
			for (const spy of spies) spy.mockRestore();
		}
		assert.equal(fork.getLeafId(), "history");
		assert.deepEqual(fork.getEntries(), [entry]);
		assert.deepEqual(fork.getHeader()?.workflow, workflow);
		assert.equal(fork.getHeader()?.parentSessionId, "source");
		await fork.appendCustomEntry("after-fork", { saved: true });
		const reopened = await SessionManager.open(fork.getSessionFile()!);
		assert.deepEqual(reopened.getEntries(), fork.getEntries());
		assert.equal(await readFile(source, "utf8"), content);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("forking an exported file leaves retired messages in the source file (#5594)", async () => {
	const dir = await mkdtemp(join(tmpdir(), "session-windowed-fork-"));
	try {
		const file = join(dir, "export.jsonl");
		const timestamp = new Date().toISOString();
		const branch = [
			{ type: "session", version: 4, id: "source", cwd: dir, createdAt: timestamp },
			{
				type: "message",
				id: "old",
				parentId: null,
				timestamp,
				message: { role: "user", content: "retired private data", timestamp: 1 },
			},
			{
				type: "compaction",
				id: "boundary",
				parentId: "old",
				timestamp,
				firstKeptEntryId: null,
				summary: "cleared",
				tokensBefore: 100,
				details: { strategy: "verbatim-lines" },
			},
			{
				type: "message",
				id: "now",
				parentId: "boundary",
				timestamp,
				message: { role: "user", content: "current", timestamp: 2 },
			},
		];
		await writeFile(file, branch.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
		const child = await SessionManager.forkFrom(file, dir, join(dir, "dest"));
		assert.equal(await child.findEntrySeq("old"), undefined);
		assert.deepEqual(
			child.getBranch().map((entry) => entry.id),
			["boundary", "now"],
		);
		assert.equal(child.getHeader()?.parentInOtherStore, true);
		await child.getSessionStore().close();
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a fork reads a named historical blob only from the selected export and does not index neighbouring files (#5594)", async () => {
	const dir = await mkdtemp(join(tmpdir(), "session-file-receipt-"));
	const dest = new MemorySessionStore();
	try {
		const time = "2025-01-01T00:00:00.000Z";
		const header = { type: "session", version: 4, id: "source", createdAt: time, cwd: dir };
		const payload = Buffer.from("selected file");
		const hash = createHash("sha256").update(payload).digest("hex");
		const receipt = {
			type: "custom",
			customType: "atomic.tool-output",
			id: "receipt",
			parentId: null,
			timestamp: time,
			data: { hash, bytes: payload.byteLength, toolCallId: "call", base64: payload.toString("base64") },
		};
		const boundary = {
			type: "compaction",
			id: "clear",
			parentId: "receipt",
			timestamp: time,
			firstKeptEntryId: null,
			summary: "clear",
			tokensBefore: 100,
			details: { strategy: "verbatim-lines" },
		};
		const tail = {
			type: "message",
			id: "now",
			parentId: "clear",
			timestamp: time,
			message: { role: "user", content: `Read tool-output://${hash}`, timestamp: 2 },
		};
		const selected = join(dir, "selected.jsonl");
		const other = `${time.replaceAll(":", "-")}_${createHash("sha256").update(header.id).digest("hex")}.jsonl`;
		await writeFile(selected, [header, receipt, boundary, tail].map((r) => JSON.stringify(r)).join("\n") + "\n");
		await writeFile(join(dir, other), JSON.stringify(header) + "\n");
		const child = await SessionManager.forkFrom(selected, dir, dest);
		assert.deepEqual(Buffer.from((await dest.getBlob(child.getSessionId(), hash)) ?? []), payload);
		assert.deepEqual((await fsPromises.readdir(dir)).sort(), [other, "selected.jsonl"].sort());
	} finally {
		await dest.close();
		await rm(dir, { recursive: true, force: true });
	}
});

const savedAt = "2025-01-01T00:00:00.000Z";
const said = (id: string, parentId: string | null, content: string) => ({
	type: "message",
	id,
	parentId,
	timestamp: savedAt,
	message: { role: "user", content, timestamp: 1 },
});
const cleared = (id: string, parentId: string) => ({
	type: "compaction",
	id,
	parentId,
	timestamp: savedAt,
	firstKeptEntryId: null,
	summary: "cleared",
	tokensBefore: 100,
	details: { strategy: "verbatim-lines" },
});
const inlineOutput = (id: string, parentId: string, payload: Buffer) => ({
	type: "custom",
	customType: "atomic.tool-output",
	id,
	parentId,
	timestamp: savedAt,
	data: {
		toolCallId: `call-${id}`,
		hash: createHash("sha256").update(payload).digest("hex"),
		bytes: payload.byteLength,
		base64: payload.toString("base64"),
	},
});
const savedLines = (rows: readonly object[]) => rows.map((row) => `${JSON.stringify(row)}\n`).join("");
const savedHeader = (cwd: string) => ({ type: "session", version: 4, id: "source", createdAt: savedAt, cwd });
async function savedBody(file: string): Promise<string> {
	const text = await readFile(file, "utf8");
	return text.slice(text.indexOf("\n") + 1);
}

test("a file forked into its own directory keeps every branch byte for byte; another directory gets the window (#5594)", async () => {
	const dir = await mkdtemp(join(tmpdir(), "session-file-clone-"));
	try {
		const file = join(dir, "source.jsonl");
		const body = savedLines([
			said("root", null, "start"),
			said("abandoned", "root", "a sibling branch"),
			{
				type: "label",
				id: "mark",
				parentId: "abandoned",
				timestamp: savedAt,
				targetId: "root",
				label: "checkpoint",
			},
			said("large", "root", "x".repeat(1_100_000)),
			cleared("clear", "large"),
			said("now", "clear", "current"),
		]);
		await writeFile(file, `${JSON.stringify(savedHeader(dir))}\n${body}`);

		const clone = await SessionManager.forkFrom(file, dir, dir);
		try {
			assert.equal(await savedBody(clone.getSessionFile()!), body);
			assert.equal(clone.getHeader()?.parentSessionId, "source");
			assert.equal(clone.getHeader()?.parentInOtherStore, undefined);
			assert.equal(clone.getLeafId(), "now");
		} finally {
			await clone.getSessionStore().close();
		}

		const windowed = await SessionManager.forkFrom(file, dir, join(dir, "elsewhere"));
		try {
			assert.equal(windowed.getHeader()?.parentSessionId, "source");
			assert.equal(windowed.getHeader()?.parentInOtherStore, true);
			for (const id of ["abandoned", "mark", "large"]) assert.equal(await windowed.findEntrySeq(id), undefined);
			assert.equal(windowed.getLeafId(), "now");
		} finally {
			await windowed.getSessionStore().close();
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a destination created as an alias of the source before opening keeps every branch (#5594)", async () => {
	const root = await mkdtemp(join(tmpdir(), "fork-dir-created-"));
	const src = join(root, "source"),
		target = join(root, "target");
	const original = JsonlSessionStore.open.bind(JsonlSessionStore);
	try {
		await mkdir(src);
		const file = join(src, "parent.jsonl");
		const body = savedLines([
			said("first", null, "root"),
			said("sibling", "first", "abandoned"),
			cleared("clear", "first"),
			said("now", "clear", "current"),
		]);
		await writeFile(file, `${JSON.stringify(savedHeader(root))}\n${body}`);
		const open = vi.spyOn(JsonlSessionStore, "open").mockImplementation(async (dir, options) => {
			if (dir === target) await fsPromises.symlink(src, target, process.platform === "win32" ? "junction" : "dir");
			return original(dir, options);
		});
		try {
			const child = await SessionManager.forkFrom(file, root, target);
			try {
				assert.equal(await savedBody(child.getSessionFile()!), body);
				assert.equal(child.getHeader()?.parentInOtherStore, undefined);
			} finally {
				await child.getSessionStore().close();
			}
		} finally {
			open.mockRestore();
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("a published file clone still succeeds if its temporary link was already removed (#5594)", async () => {
	const dir = await mkdtemp(join(tmpdir(), "fork-temp-link-"));
	const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
	try {
		const file = join(dir, "source.jsonl"),
			body = savedLines([said("first", null, "source")]);
		await writeFile(file, `${JSON.stringify(savedHeader(dir))}\n${body}`);
		const publish = vi.spyOn(fsPromises, "link").mockImplementation(async (temp, path) => {
			await actual.link(temp, path);
			if (String(temp).endsWith(".tmp")) await actual.unlink(temp);
		});
		try {
			const child = await SessionManager.forkFrom(file, dir, dir);
			try {
				assert.equal(await savedBody(child.getSessionFile()!), body);
			} finally {
				await child.getSessionStore().close();
			}
		} finally {
			publish.mockRestore();
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("without inode identities, only disjoint directories prove a fork's destination another collection (#5594)", async () => {
	const dir = await fsPromises.realpath(await mkdtemp(join(tmpdir(), "session-file-no-identity-")));
	const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
	try {
		const nested = join(dir, "forks"),
			sibling = join(dir, "source", "..", "sibling");
		await mkdir(nested);
		await mkdir(join(dir, "source"));
		await mkdir(sibling);
		const body = savedLines([
			said("root", null, "start"),
			said("abandoned", "root", "sibling"),
			said("now", "root", "c"),
		]);
		const header = `${JSON.stringify(savedHeader(dir))}\n`;
		await writeFile(join(dir, "own.jsonl"), header + body);
		await writeFile(join(dir, "source", "own.jsonl"), header + body);
		// As on a network filesystem: these directories report no inode.
		const unidentified = new Set([dir, nested, join(dir, "source"), join(dir, "sibling")]);
		vi.mocked(fsPromises.stat).mockImplementation((async (path: string, options?: { bigint?: boolean }) => {
			const stats = await actual.stat(path, options);
			return unidentified.has(String(path)) ? Object.assign(stats, { ino: options?.bigint ? 0n : 0 }) : stats;
		}) as unknown as typeof fsPromises.stat);
		const intoNested = await SessionManager.forkFrom(join(dir, "own.jsonl"), dir, nested);
		assert.equal(await savedBody(intoNested.getSessionFile()!), body);
		assert.equal(intoNested.getHeader()?.parentInOtherStore, undefined);
		await intoNested.getSessionStore().close();
		const intoSibling = await SessionManager.forkFrom(join(dir, "source", "own.jsonl"), dir, sibling);
		assert.equal(intoSibling.getHeader()?.parentInOtherStore, true);
		assert.equal(await intoSibling.findEntrySeq("abandoned"), undefined);
		await intoSibling.getSessionStore().close();
	} finally {
		vi.mocked(fsPromises.stat).mockImplementation(actual.stat);
		await rm(dir, { recursive: true, force: true });
	}
});

test("an unproven destination gets the whole saved file, and the outputs it carries inline as blobs (#5594)", async () => {
	const dir = await mkdtemp(join(tmpdir(), "session-file-unproven-"));
	const root = await JsonlSessionStore.open(dir);
	const backing = new MemorySessionStore();
	// A third-party store: nothing proves its backing is not the file's collection.
	const unproven = new Proxy(backing, {});
	try {
		const project = join(dir, "--project--");
		await mkdir(project);
		const header = `${JSON.stringify(savedHeader(dir))}\n`;
		const branches = [said("root", null, "start"), said("abandoned", "root", "a sibling branch")];
		const plain = savedLines([...branches, said("now", "root", "current")]);
		await writeFile(join(project, "plain.jsonl"), header + plain);
		// A project-root store above the file's directory cannot prove that the file is outside it.
		const intoRoot = await SessionManager.forkFrom(join(project, "plain.jsonl"), dir, root);
		assert.equal(await savedBody(intoRoot.getSessionFile()!), plain);
		assert.equal(intoRoot.getHeader()?.parentInOtherStore, undefined);

		const payload = Buffer.from("kept output");
		const receipt = inlineOutput("receipt", "abandoned", payload);
		const rows = [...branches, receipt, said("now", "root", `Read tool-output://${receipt.data.hash}`)];
		await writeFile(join(project, "exported.jsonl"), header + savedLines(rows));
		const intoUnproven = await SessionManager.forkFrom(join(project, "exported.jsonl"), dir, unproven);
		const { base64: _inline, ...kept } = receipt.data;
		assert.deepEqual(
			(await backing.load(intoUnproven.getSessionId())).entries.map((entry) => JSON.stringify(entry)),
			rows.map((row) => JSON.stringify(row === receipt ? { ...receipt, data: kept } : row)),
		);
		assert.deepEqual(Buffer.from((await backing.getBlob(intoUnproven.getSessionId(), kept.hash)) ?? []), payload);
		assert.equal(intoUnproven.getHeader()?.parentSessionId, "source");
		assert.equal(intoUnproven.getHeader()?.parentInOtherStore, undefined);
	} finally {
		await root.close();
		await backing.close();
		await rm(dir, { recursive: true, force: true });
	}
});

test("a file that grows while a fork copies it forks the rows it held; one rewritten in place forks nothing (#5594)", async () => {
	const dir = await mkdtemp(join(tmpdir(), "session-file-live-"));
	const backing = new MemorySessionStore();
	try {
		const file = join(dir, "live.jsonl");
		await writeFile(
			file,
			savedLines([savedHeader(dir), said("root", null, "start"), said("now", "root", "current")]),
		);
		let meanwhile: () => Promise<void> = async () => {};
		// Change the file after the fork indexed it and before it copies the first row.
		const unproven = new Proxy(backing, {
			get(target, key, receiver) {
				const value = Reflect.get(target, key, receiver);
				if (key !== "createFork") return value;
				return async (...args: Parameters<MemorySessionStore["createFork"]>) => {
					await meanwhile();
					return value.apply(receiver, args);
				};
			},
		});
		const saved = async () => {
			const ids: string[] = [];
			for await (const summary of backing.list({})) ids.push(summary.id);
			return ids;
		};

		meanwhile = () => appendFile(file, savedLines([said("later", "now", "appended meanwhile")]));
		const grown = await SessionManager.forkFrom(file, dir, unproven);
		assert.deepEqual(
			(await backing.load(grown.getSessionId())).entries.map((entry) => entry.id),
			["root", "now"],
		);

		meanwhile = async () => {
			await writeFile(file, (await readFile(file, "utf8")).replace("current", "CURRENT"));
			await fsPromises.utimes(file, new Date(), new Date(Date.now() + 60_000));
		};
		await assert.rejects(SessionManager.forkFrom(file, dir, unproven), SessionConflictError);
		assert.deepEqual(await saved(), [grown.getSessionId()]);
	} finally {
		await backing.close();
		await rm(dir, { recursive: true, force: true });
	}
});

// Atomic's sources import `.js` specifiers that name `.ts` files; Bun resolves them, and so does this hook for Node.
const RESOLVE_TS_SOURCES = `import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, nextResolve) {
	try { return nextResolve(specifier, context); }
	catch (error) { if (/^\\.\\.?\\//.test(specifier) && specifier.endsWith(".js")) return nextResolve(specifier.slice(0, -3) + ".ts", context); throw error; }
} });`;
const sourceModule = (path: string) =>
	pathToFileURL(fileURLToPath(new URL(`../../src/core/${path}`, import.meta.url))).href;

/** A Node child that loads the session manager from source, so a heap limit or a kill applies to the fork alone. */
function forkProcess(script: string, env: Record<string, string>, heapMb?: number) {
	return spawn(
		process.execPath,
		[
			...(heapMb === undefined ? [] : [`--max-old-space-size=${heapMb}`]),
			"--import",
			`data:text/javascript,${encodeURIComponent(RESOLVE_TS_SOURCES)}`,
			"--input-type=module",
			"--eval",
			`import { SessionManager } from ${JSON.stringify(sourceModule("session-manager.ts"))};
			import { MemorySessionStore } from ${JSON.stringify(sourceModule("storage/session/memory-session-store.ts"))};
			${script}`,
		],
		{ env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] },
	);
}

/** Large outputs, all retired behind a clear and named again by the current message. */
const MEMORY_OUTPUTS = 24;
const MEMORY_OUTPUT_BYTES = 3 * 1024 * 1024;

test.each([
	["an unproven store gets the whole file", "new Proxy(new MemorySessionStore(), {})"],
	["another store gets the window", "new MemorySessionStore()"],
])(
	"forking a file with large inline outputs holds one output at a time: %s (#5594)",
	async (_name, destination) => {
		const dir = await mkdtemp(join(tmpdir(), "session-file-inline-memory-"));
		try {
			const file = join(dir, "exported.jsonl");
			await writeFile(file, savedLines([savedHeader(dir), said("root", null, "start")]));
			const hashes: string[] = [];
			let parent = "root";
			for (let i = 0; i < MEMORY_OUTPUTS; i++) {
				const receipt = inlineOutput(`output-${i}`, parent, Buffer.alloc(MEMORY_OUTPUT_BYTES, i + 1));
				hashes.push(receipt.data.hash);
				await appendFile(file, savedLines([receipt]));
				parent = receipt.id;
			}
			const named = hashes.map((hash) => `tool-output://${hash}`).join("\n");
			await appendFile(file, savedLines([cleared("clear", parent), said("now", "clear", named)]));
			const child = forkProcess(
				`const store = ${destination};
				const fork = await SessionManager.forkFrom(process.env.FORK_SOURCE, process.env.FORK_CWD, store);
				const kept = [];
				for (const hash of JSON.parse(process.env.FORK_HASHES))
					kept.push((await store.getBlob(fork.getSessionId(), hash))?.byteLength);
				process.stdout.write(JSON.stringify({ leaf: fork.getLeafId(), kept }));`,
				{ FORK_SOURCE: file, FORK_CWD: dir, FORK_HASHES: JSON.stringify(hashes) },
				72,
			);
			let stdout = "",
				stderr = "";
			child.stdout.on("data", (data) => {
				stdout += data;
			});
			child.stderr.on("data", (data) => {
				stderr += data;
			});
			const code = await new Promise((resolve) => child.on("close", resolve));
			assert.equal(code, 0, stderr.slice(-2000));
			assert.deepEqual(JSON.parse(stdout), {
				leaf: "now",
				kept: hashes.map(() => MEMORY_OUTPUT_BYTES),
			});
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	},
	120_000,
);

test("a fork killed while it copies a file leaves no child session behind (#5594)", async () => {
	const dir = await mkdtemp(join(tmpdir(), "session-file-clone-crash-"));
	try {
		const file = join(dir, "source.jsonl");
		const rows = [said("root", null, "start"), said("abandoned", "root", "a sibling branch")];
		// Several MiB of rows, so the copy writes some of them before it reaches the last.
		for (let i = 0; i < 4; i++) rows.push(said(`large-${i}`, rows.at(-1)!.id, "x".repeat(1_200_000)));
		await writeFile(file, savedLines([savedHeader(dir), ...rows, said("now", "root", "current")]));
		// Stop the copy for good once part of it is written, as a crash would.
		const child = forkProcess(
			`import { open } from "node:fs/promises";
			const probe = await open(process.env.FORK_SOURCE, "r");
			const handles = Object.getPrototypeOf(probe);
			await probe.close();
			const write = handles.writeFile;
			let writes = 0;
			handles.writeFile = function (...args) {
				if (++writes === 2) {
					process.stdout.write("copying\\n");
					return new Promise(() => {});
				}
				return write.apply(this, args);
			};
			await SessionManager.forkFrom(process.env.FORK_SOURCE, process.env.FORK_CWD, process.env.FORK_CWD);
			process.stdout.write("published\\n");`,
			{ FORK_SOURCE: file, FORK_CWD: dir },
		);
		const exited = new Promise((resolve) => child.on("close", resolve));
		const progress = await new Promise<string>((resolve) => {
			let stdout = "";
			child.stdout.on("data", (data) => {
				stdout += data;
				if (stdout.includes("\n")) resolve(stdout);
			});
			child.on("close", () => resolve(stdout));
		});
		assert.equal(progress, "copying\n");
		const partial = (await readdir(dir)).filter((name) => name.endsWith(".tmp"));
		assert.equal(partial.length, 1);
		assert.ok((await fsPromises.stat(join(dir, partial[0]!))).size > 0, "the copy was under way");
		child.kill("SIGKILL");
		await exited;

		assert.deepEqual(
			(await readdir(dir)).filter((name) => name.endsWith(".jsonl")),
			["source.jsonl"],
		);
		assert.deepEqual(
			(await SessionManager.list(dir, dir)).map((session) => session.id),
			["source"],
		);
		const retried = await SessionManager.forkFrom(file, dir, dir);
		try {
			assert.equal((await SessionManager.list(dir, dir)).length, 2);
			assert.equal(retried.getLeafId(), "now");
		} finally {
			await retried.getSessionStore().close();
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}, 60_000);

test("streamed forks reject missing and invalid sources without creating a session (#3577)", async () => {
	const dir = await mkdtemp(join(tmpdir(), "session-invalid-fork-"));
	try {
		const source = join(dir, "source.jsonl");
		const destination = join(dir, "forks");
		await assert.rejects(SessionManager.forkFrom(source, dir, destination), (error: Error) => {
			assert.ok(error instanceof StorageUnavailableError);
			assert.equal((error.cause as NodeJS.ErrnoException).code, "ENOENT");
			return true;
		});
		await writeFile(source, "not a session\n");
		await assert.rejects(SessionManager.forkFrom(source, dir, destination), StorageUnavailableError);
		await assert.rejects(fsPromises.access(destination), { code: "ENOENT" });
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test.each(["z.jsonl", "backup.bak"])(
	"an explicitly opened %s owns its reads and writes even beside a file with the same header ID (#5554)",
	async (name) => {
		const dir = await mkdtemp(join(tmpdir(), "session-explicit-owner-"));
		try {
			const time = new Date(0).toISOString();
			const header = { type: "session", version: 4, id: "shared", createdAt: time, cwd: dir };
			const contents = (text: string) =>
				`${JSON.stringify(header)}\n${JSON.stringify({ type: "message", id: text, parentId: null, timestamp: time, message: { role: "user", content: text, timestamp: 0 } })}\n`;
			const first = join(dir, "a.jsonl"),
				selected = join(dir, name);
			await writeFile(first, contents("unselected"));
			await writeFile(selected, contents("selected"));
			const sm = await SessionManager.open(selected);
			try {
				assert.equal(sm.getLeafId(), "selected");
				await sm.appendMessage({ role: "user", content: "only on selected", timestamp: 1 });
				assert.equal(await readFile(first, "utf8"), contents("unselected"));
				assert.match(await readFile(selected, "utf8"), /only on selected/);
				await rm(selected);
				await assert.rejects(sm.appendMessage({ role: "user", content: "no fallthrough", timestamp: 2 }));
				assert.equal(await readFile(first, "utf8"), contents("unselected"));
			} finally {
				await sm.getSessionStore().close();
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	},
);

test("a successfully recreated explicit session ID writes to its new generation's file (#5554)", async () => {
	const dir = await mkdtemp(join(tmpdir(), "session-pinned-recreate-"));
	try {
		const original = join(dir, "z.jsonl");
		await writeFile(
			original,
			JSON.stringify({ type: "session", version: 4, id: "A", createdAt: new Date(0).toISOString(), cwd: dir }) +
				"\n",
		);
		const sm = await SessionManager.open(original);
		try {
			await sm.newSession({ id: "B" });
			await sm.getSessionStore().delete("A");
			const created = await sm.newSession({ id: "A" });
			assert.ok(created);
			assert.notEqual(created, original);
			await sm.appendMessage({ role: "user", content: "new A", timestamp: 1 });
			assert.match(await readFile(created, "utf8"), /new A/);
			await assert.rejects(fsPromises.access(original), { code: "ENOENT" });
		} finally {
			await sm.getSessionStore().close();
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("opening a missing explicit session creates its directory and persists at that path (#3577)", async () => {
	const dir = await mkdtemp(join(tmpdir(), "session-missing-open-"));
	try {
		const sessionDir = join(dir, "nested", "sessions");
		const path = join(sessionDir, "explicit.jsonl");
		const session = await SessionManager.open(path, sessionDir, dir);
		assert.equal(session.getSessionFile(), path);
		assert.equal((await fsPromises.stat(sessionDir)).isDirectory(), true);
		await session.appendMessage({ role: "user", content: "first message", timestamp: Date.now() });
		const reopened = await SessionManager.open(path);
		assert.equal(reopened.getSessionId(), session.getSessionId());
		assert.deepEqual(reopened.getEntries(), session.getEntries());
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
