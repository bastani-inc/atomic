import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, test, vi } from "vitest";

const fake = vi.hoisted(() => ({ fdOutput: undefined as Buffer[] | undefined }));

vi.mock("child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("child_process")>();
	const { EventEmitter } = await import("node:events");
	const { Readable: ReadableStream } = await import("node:stream");
	return {
		...actual,
		spawn: (...args: Parameters<typeof actual.spawn>) => {
			if (fake.fdOutput === undefined) return actual.spawn(...args);
			// fd as it prints its matches: the chunks given, then exit 0 once its output is read.
			const child = Object.assign(new EventEmitter(), {
				killed: false,
				kill: () => true,
				stderr: ReadableStream.from([]),
				stdout: ReadableStream.from(fake.fdOutput),
			});
			child.stdout.on("end", () => setImmediate(() => child.emit("close", 0)));
			return child as unknown as ReturnType<typeof actual.spawn>;
		},
	};
});

vi.mock("../src/core/tools/search-native.ts", () => ({ loadNativeSearchBinding: () => null }));

import { createFindToolDefinition } from "../src/core/tools/find.ts";
import { createGrepTool } from "../src/core/tools/grep.ts";

const SEPARATED = "a\u2028b\u2029c";
const cwd = mkdtempSync(join(tmpdir(), "atomic-search-4957-"));
writeFileSync(join(cwd, `${SEPARATED}.txt`), `before\nNEEDLE ${SEPARATED} end\n`);
afterAll(() => rmSync(cwd, { recursive: true, force: true }));
afterEach(() => {
	fake.fdOutput = undefined;
});

function text(result: { content: ReadonlyArray<{ type: string; text?: string }> }): string {
	return result.content.map((item) => (item.type === "text" ? (item.text ?? "") : "")).join("\n");
}

describe("search tools and U+2028 / U+2029 (#4957)", () => {
	test("find returns a file whose name contains U+2028 and U+2029 as one path (#4957)", async () => {
		const name = Buffer.from(`${SEPARATED}.txt\n`);
		// The output arrives split inside the three-byte U+2028.
		fake.fdOutput = [name.subarray(0, 2), name.subarray(2)];
		const found = text(await createFindToolDefinition(cwd).execute("find-4957", { paths: ["*.txt"] }));
		assert.equal(found, `${SEPARATED}.txt`);
	});

	test("grep through ripgrep reports a matching line that contains U+2028 and U+2029 (#4957)", async () => {
		const grep = createGrepTool(cwd, { operations: { isDirectory: (path) => statSync(path).isDirectory() } });
		const output = text(await grep.execute("grep-4957", { pattern: "NEEDLE" }));
		assert.equal(output, `${SEPARATED}.txt:2: NEEDLE ${SEPARATED} end`);
	});
});
