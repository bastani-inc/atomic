import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, beforeEach, describe, it, vi } from "vitest";

const backend = vi.hoisted(() => ({ native: true }));
vi.mock("../../../src/core/tools/search-native.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("../../../src/core/tools/search-native.js")>();
	return {
		...original,
		loadNativeSearchBinding: () => (backend.native ? original.loadNativeSearchBinding() : null),
	};
});

import { createFindToolDefinition } from "../../../src/core/tools/find.js";
import { loadNativeSearchBinding } from "../../../src/core/tools/search-native.js";

/** Every case runs through both engines; the expected result is the same for each. */
const CASES: ReadonlyArray<readonly [pattern: string, expected: readonly string[]]> = [
	["*.ts", ["Upper/A.ts", "lower/b.ts"]],
	["*.TS", ["Docs/c.TS"]],
	["*/a.ts", []],
	["*/A.ts", ["Upper/A.ts"]],
	["**/upper/*.ts", []],
	["**/Upper/*.ts", ["Upper/A.ts"]],
	["[u]pper/*.ts", []],
	["**/docs/*", []],
	["**/Docs/*", ["Docs/c.TS"]],
	["**/LOWER/*.ts", []],
	["**/lower/*.ts", ["lower/b.ts"]],
];

describe.each([true, false])("find case rules with native=%s (#4708)", (native) => {
	let project: string;

	beforeEach(() => {
		backend.native = native;
		if (native) assert.ok(loadNativeSearchBinding());
		project = realpathSync(mkdtempSync(join(tmpdir(), "atomic-4708-")));
		for (const name of ["Upper/A.ts", "lower/b.ts", "Docs/c.TS"]) {
			const file = join(project, name);
			mkdirSync(resolve(file, ".."), { recursive: true });
			writeFileSync(file, "");
		}
	});

	afterEach(() => {
		rmSync(project, { recursive: true, force: true });
	});

	async function find(pattern: string): Promise<string[]> {
		const result = await createFindToolDefinition(project).execute("find", { paths: [pattern] });
		return (result.details?.files ?? []).filter((file) => !file.endsWith("/")).sort();
	}

	it.each(CASES)("matches %s case-sensitively (#4708)", async (pattern, expected) => {
		assert.deepEqual(await find(pattern), [...expected].sort());
	});

	it("matches an absolute pattern under an uppercase search root case-sensitively (#4708)", async () => {
		const root = join(project, "Upper").split(sep).join("/");
		assert.deepEqual(await find(`${root}/*.ts`), ["A.ts"]);
		assert.deepEqual(await find(`${root}/*.TS`), []);
	});
});
