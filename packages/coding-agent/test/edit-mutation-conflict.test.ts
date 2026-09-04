import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEditTool, type EditOperations } from "../src/core/tools/edit.ts";
import {
	FILE_MUTATION_CONFLICT_CODE,
	FileMutationConflict,
	type MutationRequester,
} from "../src/core/tools/file-mutation-coordinator.ts";
import { createHashlineSnapshotStore } from "../src/core/tools/hashline.ts";
import { createReadTool } from "../src/core/tools/read.ts";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "edit-mutation-conflict-"));
	tempDirs.push(dir);
	return dir;
}

function resultText(result: unknown): string {
	const typed = result as { content?: Array<{ text?: string }> };
	return (typed.content ?? []).map((entry) => entry.text ?? "").join("\n");
}

function advertisedTag(text: string): string {
	const match = text.match(/\[[^\]\n]+#([0-9A-F]{4})\]/);
	if (!match) throw new Error(`no hashline header in tool output: ${text.slice(0, 200)}`);
	return match[1]!;
}

const ORIGINAL = "alpha\nbravo\ncharlie\n";

/**
 * Operations whose reads return `ORIGINAL` while the patch is prepared and `swapped` from the
 * given read onwards.
 *
 * The window this guard closes is between `prepare` reading the file and the write committing,
 * which no amount of real concurrency reproduces reliably. Driving it through the injection
 * seam pins the interleaving instead of racing for it.
 */
function operationsSwappingAfter(readsBeforeSwap: number, swapped: string) {
	const state = { reads: 0, wrote: undefined as string | undefined };
	const operations: EditOperations = {
		readFile: async () => {
			state.reads += 1;
			return Buffer.from(state.reads > readsBeforeSwap ? swapped : ORIGINAL, "utf-8");
		},
		writeFile: async (_path, content) => {
			state.wrote = content;
		},
		access: async () => {},
	};
	return { operations, state };
}

describe("edit raises a typed conflict when the file moves under a prepared patch", () => {
	it("rejects with FILE_MUTATION_CONFLICT and never writes", async () => {
		const dir = await createTempDir();
		const file = join(dir, "target.txt");
		await writeFile(file, ORIGINAL, "utf-8");

		const hashlineStore = createHashlineSnapshotStore();
		const read = createReadTool(dir, { hashlineStore });
		const tag = advertisedTag(resultText(await read.execute("read-1", { path: "target.txt" })));

		const { operations, state } = operationsSwappingAfter(1, "alpha\nbravo\nCHARLIE-EXTERNAL\n");
		const requester: MutationRequester = {
			sessionId: "session-1",
			subagentAgent: "reviewer",
			subagentIndex: 0,
		};
		const edit = createEditTool(dir, {
			hashlineStore,
			operations,
			resolveMutationRequester: () => requester,
		});

		const error = await edit.execute("edit-1", { input: `[target.txt#${tag}]\nreplace 2..2:\n+BRAVO-MINE\n` }).then(
			() => undefined,
			(caught: unknown) => caught,
		);

		expect(error).toBeInstanceOf(FileMutationConflict);
		const conflict = error as FileMutationConflict;
		expect(conflict.reason).toBe("changed_before_write");
		expect(conflict.message.startsWith(FILE_MUTATION_CONFLICT_CODE)).toBe(true);
		// The identity reached the message through the resolver rather than being passed by hand.
		expect(conflict.message).toContain("session=session-1");
		expect(conflict.message).toContain("index=0");
		// The divergence is the line the external change touched, not the line being edited.
		expect(conflict.evidence?.line).toBe(3);
		expect(conflict.evidence?.found).toBe("CHARLIE-EXTERNAL");
		expect(state.wrote).toBeUndefined();
	});

	it("reports target_missing rather than a raw filesystem error when the file is deleted", async () => {
		const dir = await createTempDir();
		const file = join(dir, "target.txt");
		await writeFile(file, ORIGINAL, "utf-8");

		const hashlineStore = createHashlineSnapshotStore();
		const read = createReadTool(dir, { hashlineStore });
		const tag = advertisedTag(resultText(await read.execute("read-1", { path: "target.txt" })));

		let reads = 0;
		const operations: EditOperations = {
			readFile: async () => {
				reads += 1;
				if (reads > 1) {
					const error: NodeJS.ErrnoException = new Error("ENOENT: no such file or directory");
					error.code = "ENOENT";
					throw error;
				}
				return Buffer.from(ORIGINAL, "utf-8");
			},
			writeFile: async () => {},
			access: async () => {},
		};
		const edit = createEditTool(dir, { hashlineStore, operations });

		const error = await edit.execute("edit-1", { input: `[target.txt#${tag}]\nreplace 2..2:\n+BRAVO-MINE\n` }).then(
			() => undefined,
			(caught: unknown) => caught,
		);

		expect(error).toBeInstanceOf(FileMutationConflict);
		expect((error as FileMutationConflict).reason).toBe("target_missing");
		expect((error as FileMutationConflict).message).toContain("Do not read it");
	});

	it("reports target_unreadable when the path is replaced by something unreadable", async () => {
		const dir = await createTempDir();
		const file = join(dir, "target.txt");
		await writeFile(file, ORIGINAL, "utf-8");

		const hashlineStore = createHashlineSnapshotStore();
		const read = createReadTool(dir, { hashlineStore });
		const tag = advertisedTag(resultText(await read.execute("read-1", { path: "target.txt" })));

		// A directory now occupies the path. The file is neither unchanged nor gone, which is
		// the state that previously escaped as a raw filesystem error.
		let reads = 0;
		const operations: EditOperations = {
			readFile: async () => {
				reads += 1;
				if (reads > 1) {
					const error: NodeJS.ErrnoException = new Error("EISDIR: illegal operation on a directory");
					error.code = "EISDIR";
					throw error;
				}
				return Buffer.from(ORIGINAL, "utf-8");
			},
			writeFile: async () => {},
			access: async () => {},
		};
		const edit = createEditTool(dir, { hashlineStore, operations });

		const error = await edit.execute("edit-1", { input: `[target.txt#${tag}]\nreplace 2..2:\n+BRAVO-MINE\n` }).then(
			() => undefined,
			(caught: unknown) => caught,
		);

		expect(error).toBeInstanceOf(FileMutationConflict);
		const conflict = error as FileMutationConflict;
		expect(conflict.reason).toBe("target_unreadable");
		expect(conflict.causeCode).toBe("EISDIR");
		expect(conflict.message).toContain("(EISDIR)");
		expect(conflict.liveState).toBeUndefined();
		expect(conflict.message).not.toContain("does not exist");
	});

	it("reports foreign_snapshot for a tag this session never issued", async () => {
		const dir = await createTempDir();
		const file = join(dir, "target.txt");
		await writeFile(file, ORIGINAL, "utf-8");

		// Two stores stands in for two sessions: the reader mints a tag the editor has never
		// recorded, which is what a cross-session handoff looks like from the editor's side.
		const readerStore = createHashlineSnapshotStore();
		const editorStore = createHashlineSnapshotStore();
		const read = createReadTool(dir, { hashlineStore: readerStore });
		const tag = advertisedTag(resultText(await read.execute("read-1", { path: "target.txt" })));
		const edit = createEditTool(dir, { hashlineStore: editorStore });

		const error = await edit.execute("edit-1", { input: `[target.txt#${tag}]\nreplace 2..2:\n+BRAVO-MINE\n` }).then(
			() => undefined,
			(caught: unknown) => caught,
		);

		expect(error).toBeInstanceOf(FileMutationConflict);
		const conflict = error as FileMutationConflict;
		expect(conflict.reason).toBe("foreign_snapshot");
		expect(conflict.presentedTag).toBe(tag);
		// No diff: the tag names content this session has never seen, so there is no prior side.
		expect(conflict.evidence).toBeUndefined();
		expect(conflict.liveState?.lines).toBe(3);
	});

	it("keeps the message bounded when the target is rewritten as binary content", async () => {
		const dir = await createTempDir();
		const file = join(dir, "target.txt");
		await writeFile(file, ORIGINAL, "utf-8");

		const hashlineStore = createHashlineSnapshotStore();
		const read = createReadTool(dir, { hashlineStore });
		const tag = advertisedTag(resultText(await read.execute("read-1", { path: "target.txt" })));

		// Invalid UTF-8 does not throw: it decodes to replacement characters. So this arrives as
		// an ordinary content change, and the excerpt has to stay escaped and clamped rather
		// than spilling raw control bytes into a message that gets relayed and logged.
		let reads = 0;
		const operations: EditOperations = {
			readFile: async () => {
				reads += 1;
				return reads > 1
					? Buffer.from([0x00, 0xff, 0xfe, ...new Array(4000).fill(0x00)])
					: Buffer.from(ORIGINAL, "utf-8");
			},
			writeFile: async () => {},
			access: async () => {},
		};
		const edit = createEditTool(dir, { hashlineStore, operations });

		const error = await edit.execute("edit-1", { input: `[target.txt#${tag}]\nreplace 2..2:\n+BRAVO-MINE\n` }).then(
			() => undefined,
			(caught: unknown) => caught,
		);

		expect(error).toBeInstanceOf(FileMutationConflict);
		const conflict = error as FileMutationConflict;
		expect(conflict.reason).toBe("changed_before_write");
		// Raw NUL bytes must never reach the message; JSON quoting renders them as an escape.
		expect(conflict.message.includes(String.fromCharCode(0))).toBe(false);
		expect(conflict.message.length).toBeLessThan(2000);
	});
});
