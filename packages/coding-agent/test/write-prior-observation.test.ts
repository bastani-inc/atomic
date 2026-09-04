import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	FILE_MUTATION_CONFLICT_CODE,
	FileMutationConflict,
	type MutationRequester,
} from "../src/core/tools/file-mutation-coordinator.ts";
import { createHashlineSnapshotStore } from "../src/core/tools/hashline.ts";
import { createReadTool } from "../src/core/tools/read.ts";
import { createWriteTool } from "../src/core/tools/write.ts";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "write-prior-observation-"));
	tempDirs.push(dir);
	return dir;
}

function conflictFrom(error: unknown): FileMutationConflict {
	expect(error).toBeInstanceOf(FileMutationConflict);
	return error as FileMutationConflict;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
	return promise.then(
		() => undefined,
		(caught: unknown) => caught,
	);
}

const ORIGINAL = "alpha\nbravo\ncharlie\n";

describe("write requires this session to have observed what it overwrites", () => {
	it("rejects an overwrite of a file the session never read", async () => {
		const dir = await createTempDir();
		const file = join(dir, "target.txt");
		await writeFile(file, ORIGINAL, "utf-8");

		const requester: MutationRequester = { sessionId: "session-1", subagentAgent: "reviewer", subagentIndex: 0 };
		const write = createWriteTool(dir, {
			hashlineStore: createHashlineSnapshotStore(),
			resolveMutationRequester: () => requester,
		});

		const conflict = conflictFrom(
			await rejection(write.execute("write-1", { path: "target.txt", content: "mine\n" })),
		);
		expect(conflict.reason).toBe("no_prior_observation");
		expect(conflict.message.startsWith(FILE_MUTATION_CONFLICT_CODE)).toBe(true);
		expect(conflict.message).toContain("session=session-1");
		// Nothing to diff against: the session has no version of its own to compare with.
		expect(conflict.evidence).toBeUndefined();
		// It can still say what was about to be clobbered, which is the part a human needs.
		expect(conflict.liveState?.lines).toBe(3);
		// The refusal has to be total, not partial.
		expect(await readFile(file, "utf-8")).toBe(ORIGINAL);
	});

	it("allows the overwrite once the session has read the file", async () => {
		const dir = await createTempDir();
		const file = join(dir, "target.txt");
		await writeFile(file, ORIGINAL, "utf-8");

		const hashlineStore = createHashlineSnapshotStore();
		const read = createReadTool(dir, { hashlineStore });
		const write = createWriteTool(dir, { hashlineStore });

		await read.execute("read-1", { path: "target.txt" });
		await write.execute("write-1", { path: "target.txt", content: "mine\n" });

		expect(await readFile(file, "utf-8")).toBe("mine\n");
	});

	it("reports changed_since_observation with a divergence when the file moved after the read", async () => {
		const dir = await createTempDir();
		const file = join(dir, "target.txt");
		await writeFile(file, ORIGINAL, "utf-8");

		const hashlineStore = createHashlineSnapshotStore();
		const read = createReadTool(dir, { hashlineStore });
		const write = createWriteTool(dir, { hashlineStore });

		await read.execute("read-1", { path: "target.txt" });
		await writeFile(file, "alpha\nBRAVO-EXTERNAL\ncharlie\n", "utf-8");

		const conflict = conflictFrom(
			await rejection(write.execute("write-1", { path: "target.txt", content: "mine\n" })),
		);
		expect(conflict.reason).toBe("changed_since_observation");
		// The evidence is the read the session is acting on versus what is there now, which is
		// what separates this from an overwrite of a file nobody ever looked at.
		expect(conflict.evidence?.line).toBe(2);
		expect(conflict.evidence?.assumed).toBe("bravo");
		expect(conflict.evidence?.found).toBe("BRAVO-EXTERNAL");
		expect(await readFile(file, "utf-8")).toBe("alpha\nBRAVO-EXTERNAL\ncharlie\n");
	});

	it("still creates a file that does not exist yet", async () => {
		const dir = await createTempDir();
		const file = join(dir, "new.txt");
		const write = createWriteTool(dir, { hashlineStore: createHashlineSnapshotStore() });

		await write.execute("write-1", { path: "new.txt", content: "fresh\n" });

		expect(await readFile(file, "utf-8")).toBe("fresh\n");
	});

	it("lets a second write overwrite what the first one wrote", async () => {
		const dir = await createTempDir();
		const file = join(dir, "new.txt");
		const write = createWriteTool(dir, { hashlineStore: createHashlineSnapshotStore() });

		await write.execute("write-1", { path: "new.txt", content: "first\n" });
		await write.execute("write-2", { path: "new.txt", content: "second\n" });

		expect(await readFile(file, "utf-8")).toBe("second\n");
	});

	it("accepts a CRLF file the session read, since the store holds normalized text", async () => {
		const dir = await createTempDir();
		const file = join(dir, "crlf.txt");
		await writeFile(file, "alpha\r\nbravo\r\n", "utf-8");

		const hashlineStore = createHashlineSnapshotStore();
		const read = createReadTool(dir, { hashlineStore });
		const write = createWriteTool(dir, { hashlineStore });

		await read.execute("read-1", { path: "crlf.txt" });
		await write.execute("write-1", { path: "crlf.txt", content: "mine\n" });

		expect(await readFile(file, "utf-8")).toBe("mine\n");
	});

	it("rejects a file another session read, since the store answers for one session only", async () => {
		const dir = await createTempDir();
		const file = join(dir, "target.txt");
		await writeFile(file, ORIGINAL, "utf-8");

		// Two stores stand in for two sessions sharing a working tree.
		const theirs = createHashlineSnapshotStore();
		const mine = createHashlineSnapshotStore();
		await createReadTool(dir, { hashlineStore: theirs }).execute("read-1", { path: "target.txt" });
		const write = createWriteTool(dir, { hashlineStore: mine });

		const conflict = conflictFrom(
			await rejection(write.execute("write-1", { path: "target.txt", content: "mine\n" })),
		);
		expect(conflict.reason).toBe("no_prior_observation");
		expect(await readFile(file, "utf-8")).toBe(ORIGINAL);
	});

	it("refuses a generated file before asking about observation", async () => {
		const dir = await createTempDir();
		const file = join(dir, "generated.txt");
		await writeFile(file, "// @generated\nalpha\n", "utf-8");
		const write = createWriteTool(dir, { hashlineStore: createHashlineSnapshotStore() });

		const error = await rejection(write.execute("write-1", { path: "generated.txt", content: "mine\n" }));
		// Both guards would fire here. The generated-file refusal is the more specific answer
		// and re-reading the file would not make the write legal, so it has to win.
		expect(error).toBeInstanceOf(Error);
		expect(error).not.toBeInstanceOf(FileMutationConflict);
		expect((error as Error).message).toContain("Refusing to overwrite generated file");
	});

	it("records provenance for a write whose result was aborted after the bytes landed", async () => {
		const dir = await createTempDir();
		const file = join(dir, "aborted.txt");
		const hashlineStore = createHashlineSnapshotStore();
		const controller = new AbortController();

		const write = createWriteTool(dir, {
			hashlineStore,
			operations: {
				mkdir: async () => {},
				readFile: async (path) => readFile(path, "utf-8").catch(() => undefined),
				writeFile: async (path, content) => {
					await writeFile(path, content, "utf-8");
					// The abort arrives after the write has committed to disk but before the tool
					// reports its result, which is the window that used to lose the snapshot.
					controller.abort();
				},
			},
		});

		await expect(
			write.execute("write-1", { path: "aborted.txt", content: "landed\n" }, controller.signal),
		).rejects.toThrow("Operation aborted");
		expect(await readFile(file, "utf-8")).toBe("landed\n");

		// A retry must not be treated as overwriting a stranger's file: this session wrote it.
		const retry = createWriteTool(dir, { hashlineStore });
		await retry.execute("write-2", { path: "aborted.txt", content: "retried\n" });
		expect(await readFile(file, "utf-8")).toBe("retried\n");
	});
});

describe("write creating a file claims the path exclusively", () => {
	it("reports target_exists when something takes the path between the check and the write", async () => {
		const dir = await createTempDir();
		const file = join(dir, "raced.txt");

		// The window is between `write` observing an absent path and its own write landing.
		// Real concurrency cannot be made to hit it reliably, so the operations seam pins the
		// interleaving: this stands in for another process creating the file in that gap.
		const write = createWriteTool(dir, {
			hashlineStore: createHashlineSnapshotStore(),
			operations: {
				mkdir: async () => {},
				readFile: async (path) => readFile(path, "utf-8").catch(() => undefined),
				writeFile: async (path, content, options) => {
					if (options?.exclusive) await writeFile(path, "SOMEONE-ELSE\n", "utf-8");
					await writeFile(path, content, { encoding: "utf-8", ...(options?.exclusive ? { flag: "wx" } : {}) });
				},
			},
		});

		const conflict = conflictFrom(
			await rejection(write.execute("write-1", { path: "raced.txt", content: "mine\n" })),
		);
		expect(conflict.reason).toBe("target_exists");
		// The loser is told what is there now rather than being sent to re-read blind.
		expect(conflict.liveState?.lines).toBe(1);
		// The write that got there first survives.
		expect(await readFile(file, "utf-8")).toBe("SOMEONE-ELSE\n");
	});

	it("asks for exclusive create only when the path was absent", async () => {
		const dir = await createTempDir();
		const seen: Array<boolean | undefined> = [];
		const hashlineStore = createHashlineSnapshotStore();
		const write = createWriteTool(dir, {
			hashlineStore,
			operations: {
				mkdir: async () => {},
				readFile: async (path) => readFile(path, "utf-8").catch(() => undefined),
				writeFile: async (path, content, options) => {
					seen.push(options?.exclusive);
					await writeFile(path, content, "utf-8");
				},
			},
		});

		await write.execute("write-1", { path: "twice.txt", content: "first\n" });
		await write.execute("write-2", { path: "twice.txt", content: "second\n" });

		// Create claims the path; the overwrite must not, or it would fail against its own file.
		expect(seen).toEqual([true, undefined]);
	});
});

describe("write reads the filesystem its writes land on", () => {
	it("reports target_unreadable rather than treating an occupied path as free", async () => {
		const dir = await createTempDir();
		const write = createWriteTool(dir, {
			hashlineStore: createHashlineSnapshotStore(),
			operations: {
				mkdir: async () => {},
				readFile: async () => {
					const error: NodeJS.ErrnoException = new Error("EISDIR: illegal operation on a directory");
					error.code = "EISDIR";
					throw error;
				},
				writeFile: async () => {
					throw new Error("must not write to a path it could not read");
				},
			},
		});

		const conflict = conflictFrom(await rejection(write.execute("write-1", { path: "blocked", content: "mine\n" })));
		expect(conflict.reason).toBe("target_unreadable");
		// The structured field is the contract a ledger records without re-parsing text. The
		// message is derived from it, so asserting it here covers both.
		expect(conflict.causeCode).toBe("EISDIR");
		// Nothing about the target is knowable once the read fails, so nothing is claimed.
		expect(conflict.liveState).toBeUndefined();
	});

	it("consults the operations read rather than local disk", async () => {
		const dir = await createTempDir();
		const file = join(dir, "remote.txt");
		// Local disk holds content the session never observed. A guard reading local disk would
		// reject; one reading through `operations` sees a free path and creates.
		await writeFile(file, "LOCAL-DECOY\n", "utf-8");

		let wrote: string | undefined;
		const write = createWriteTool(dir, {
			hashlineStore: createHashlineSnapshotStore(),
			operations: {
				mkdir: async () => {},
				readFile: async () => undefined,
				writeFile: async (_path, content) => {
					wrote = content;
				},
			},
		});

		await write.execute("write-1", { path: "remote.txt", content: "mine\n" });
		expect(wrote).toBe("mine\n");
		expect(await readFile(file, "utf-8")).toBe("LOCAL-DECOY\n");
	});
});
