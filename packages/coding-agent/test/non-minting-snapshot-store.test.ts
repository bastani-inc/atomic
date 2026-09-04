import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEditTool } from "../src/core/tools/edit.ts";
import { createHashlineSnapshotStore } from "../src/core/tools/hashline.ts";
import { RECOVERY_EXTERNAL_WARNING } from "../src/core/tools/hashline-engine/index.ts";
import { createReadTool } from "../src/core/tools/read.ts";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "non-minting-snapshot-store-"));
	tempDirs.push(dir);
	return dir;
}

function resultText(result: unknown): string {
	const typed = result as { content?: Array<{ text?: string }> };
	return (typed.content ?? []).map((entry) => entry.text ?? "").join("\n");
}

/** The 4-hex tag a read/edit response advertises for follow-up edits. */
function advertisedTag(text: string): string {
	const match = text.match(/\[[^\]\n]+#([0-9A-F]{4})\]/);
	if (!match) throw new Error(`no hashline header in tool output: ${text.slice(0, 200)}`);
	return match[1]!;
}

/** The live-content hash a mismatch rejection reports back to the model. */
function rejectedLiveTag(message: string): string {
	const match = message.match(/current file hashes to #([0-9A-F]{4})/);
	if (!match) throw new Error(`no live hash in rejection: ${message.slice(0, 300)}`);
	return match[1]!;
}

function numberedLines(count: number): string {
	return `${Array.from({ length: count }, (_, index) => `line${index + 1}`).join("\n")}\n`;
}

function createSession(dir: string) {
	const hashlineStore = createHashlineSnapshotStore();
	return {
		read: createReadTool(dir, { hashlineStore }),
		edit: createEditTool(dir, { hashlineStore }),
	};
}

describe("NonMintingSnapshotStore", () => {
	it("does not let a rejection mint provenance that validates an identical retry", async () => {
		const dir = await createTempDir();
		const file = join(dir, "target.txt");
		await writeFile(file, "alpha\nbravo\ncharlie\n", "utf-8");

		const { read, edit } = createSession(dir);
		const observedTag = advertisedTag(resultText(await read.execute("read-1", { path: "target.txt" })));

		// Something outside this session rewrites the line the pending edit anchors to,
		// so the edit can neither apply cleanly nor be recovered.
		await writeFile(file, "alpha\nbravo\nCHARLIE-EXTERNAL\n", "utf-8");

		const script = `[target.txt#${observedTag}]\nreplace 3..3:\n+delta\n`;
		const rejection = await edit.execute("edit-1", { input: script }).then(
			() => "",
			(error: unknown) => (error instanceof Error ? error.message : String(error)),
		);
		expect(rejection).not.toBe("");

		// The rejection reports the live content's hash. Quoting it back must not be
		// accepted: the model still has not read that content.
		const liveTag = rejectedLiveTag(rejection);
		expect(liveTag).not.toBe(observedTag);

		const retry = `[target.txt#${liveTag}]\nreplace 3..3:\n+delta\n`;
		await expect(edit.execute("edit-2", { input: retry })).rejects.toThrow();
		expect(await readFile(file, "utf-8")).toBe("alpha\nbravo\nCHARLIE-EXTERNAL\n");
	});

	it("still recovers a stale tag whose snapshot the session recorded", async () => {
		const dir = await createTempDir();
		const file = join(dir, "target.txt");
		await writeFile(file, numberedLines(40), "utf-8");

		const { read, edit } = createSession(dir);
		const observedTag = advertisedTag(resultText(await read.execute("read-1", { path: "target.txt" })));

		// External change far outside the 3-line diff context of the pending edit, so the
		// recovery patch still applies. Reads record through the wrapper store rather than
		// through the patcher, so the snapshot this tag names is still resolvable.
		const external = numberedLines(40).split("\n");
		external[0] = "line1-EXTERNAL";
		await writeFile(file, external.join("\n"), "utf-8");

		const output = resultText(
			await edit.execute("edit-1", { input: `[target.txt#${observedTag}]\nreplace 20..20:\n+line20-MINE\n` }),
		);

		expect(output).toContain(RECOVERY_EXTERNAL_WARNING);
		const finalText = await readFile(file, "utf-8");
		expect(finalText).toContain("line1-EXTERNAL");
		expect(finalText).toContain("line20-MINE");
	});
});
