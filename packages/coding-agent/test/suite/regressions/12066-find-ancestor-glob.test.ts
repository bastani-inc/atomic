import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
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
import { splitPathLikeGlob } from "../../../src/core/tools/glob-path-utils.js";
import { createGrepToolDefinition } from "../../../src/core/tools/grep.js";
import { loadNativeSearchBinding } from "../../../src/core/tools/search-native.js";

function portable(path: string): string {
	return path.split(sep).join("/");
}

describe.each([true, false])("find and grep ancestor globs with native=%s (#12066)", (native) => {
	let tempRoot: string;
	let project: string;

	function createProject(root: string): void {
		for (const name of ["src/a.ts", "lib/b.ts", "test/c.ts", "pkg/src/d.ts"]) {
			const file = join(root, name);
			mkdirSync(resolve(file, ".."), { recursive: true });
			writeFileSync(file, "needle\n");
		}
	}

	beforeEach(() => {
		backend.native = native;
		if (native) assert.ok(loadNativeSearchBinding());
		tempRoot = realpathSync(mkdtempSync(join(tmpdir(), "atomic-12066-")));
		project = join(tempRoot, "src", "app");
		createProject(project);
	});

	afterEach(() => {
		rmSync(tempRoot, { recursive: true, force: true });
	});

	async function find(pattern: string): Promise<string[]> {
		const result = await createFindToolDefinition(project).execute("find", { paths: [pattern] });
		const root = resolve(project, splitPathLikeGlob(pattern).basePath);
		return (result.details?.files ?? []).map((file) => portable(relative(project, resolve(root, file)))).sort();
	}

	async function grep(glob: string): Promise<string[]> {
		const result = await createGrepToolDefinition(project).execute("grep", {
			pattern: "needle",
			glob,
			mode: "filesWithMatches",
		});
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		if (text === "No matches found") return [];
		return text
			.split("\n")
			.filter(Boolean)
			.map((file) => portable(isAbsolute(file) ? relative(project, file) : file.replace(/^\.\//, "")))
			.sort();
	}

	it("describes how relative glob paths are resolved (#12066)", () => {
		const paths = createFindToolDefinition(project).parameters.properties.paths;
		assert.equal(paths.description, "Paths or glob paths to find.");
		assert.equal(paths.minItems, 1);
		assert.equal(
			paths.items.description,
			"File, directory, or glob path to find; relative paths start at the working directory.",
		);
	});

	it("anchors path globs and retains explicit any-depth matches (#12066)", async () => {
		assert.deepEqual(await find("src/**/*.ts"), ["src/a.ts"]);
		assert.deepEqual(await find("src/*.ts"), ["src/a.ts"]);
		assert.deepEqual(await find("./src/*.ts"), ["src/a.ts"]);
		assert.deepEqual(await find("pkg/src/*.ts"), ["pkg/src/d.ts"]);
		assert.deepEqual(await find("**/src/*.ts"), ["pkg/src/d.ts", "src/a.ts"]);
		assert.deepEqual(await find("**/src/**/*.ts"), ["pkg/src/d.ts", "src/a.ts"]);
		assert.deepEqual(await find("*.ts"), ["lib/b.ts", "pkg/src/d.ts", "src/a.ts", "test/c.ts"]);
		assert.deepEqual(await find(join(project, "lib", "*.ts")), ["lib/b.ts"]);
		assert.deepEqual(await grep("src/**/*.ts"), ["src/a.ts"]);
		assert.deepEqual(await grep("**/src/**/*.ts"), ["pkg/src/d.ts", "src/a.ts"]);
	});

	it("treats glob characters in the search root literally (#12066)", async () => {
		const name = process.platform === "win32" ? "w[1]{x,y}" : "w*?[1]{x,y}";
		project = join(tempRoot, name, "src");
		createProject(project);
		assert.deepEqual(await find("src/*.ts"), ["src/a.ts"]);
		assert.deepEqual(await find("**/src/**/*.ts"), ["pkg/src/d.ts", "src/a.ts"]);
		assert.deepEqual(await grep("src/*.ts"), ["src/a.ts"]);
		assert.deepEqual(await grep("**/src/**/*.ts"), ["pkg/src/d.ts", "src/a.ts"]);
	});

	it("matches relative to a symlinked search root (#12066)", async () => {
		const link = join(tempRoot, "src", "link");
		symlinkSync(project, link, "junction");
		project = link;
		assert.deepEqual(await find("src/**/*.ts"), ["src/a.ts"]);
		assert.deepEqual(await grep("src/**/*.ts"), ["src/a.ts"]);
	});

	it("preserves each backend's case behavior with an uppercase root (#12066)", async () => {
		project = join(tempRoot, "Upper");
		mkdirSync(join(project, "src"), { recursive: true });
		writeFileSync(join(project, "src", "A.ts"), "needle\n");
		writeFileSync(join(project, "src", "b.ts"), "needle\n");
		assert.deepEqual(await find("**/src/[a].ts"), native ? [] : ["src/A.ts"]);
		assert.deepEqual(await find("**/src/[B].ts"), []);
	});
});
