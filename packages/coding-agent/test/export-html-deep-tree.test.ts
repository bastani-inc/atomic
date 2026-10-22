import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";
import { afterAll, beforeAll, describe, it } from "vitest";
import { exportFromFile } from "../src/core/export-html/index.js";
import { CURRENT_SESSION_VERSION, type SessionHeader, type SessionMessageEntry } from "../src/core/session-manager.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

interface TreeNode {
	entry: { id: string };
	children: TreeNode[];
}

interface TreeApi {
	buildTree: () => TreeNode[];
	buildActivePathIds: (targetId: string) => Set<string>;
	flattenTree: (roots: TreeNode[], activePathIds: Set<string>) => Array<{ node: TreeNode }>;
	findNewestLeaf: (nodeId: string) => string;
	getPath: (targetId: string) => Array<{ id: string }>;
}

function loadTreeApi(html: string): TreeApi {
	const sessionData = html.match(/<script id="session-data" type="application\/json">([^<]+)<\/script>/)?.[1];
	const scripts = html
		.split("<script>")
		.slice(1)
		.map((chunk) => chunk.slice(0, chunk.indexOf("</script>")));
	const viewer = scripts.pop();
	if (!sessionData || !viewer) throw new Error("Missing exported session data or viewer script");
	const context = createContext({
		atob,
		TextDecoder,
		URLSearchParams,
		document: { getElementById: () => ({ textContent: sessionData }), querySelector: () => null },
		window: { location: { search: "" } },
	});
	return runInContext(
		viewer.replace(
			"let treeNodeMap = null;",
			"let treeNodeMap = null; return { buildTree, buildActivePathIds, flattenTree, findNewestLeaf, getPath };",
		),
		context,
	);
}

describe("HTML export deep session tree (pi #11225)", () => {
	const depth = 20_000;
	let tempDir: string;
	let api: TreeApi;

	beforeAll(async () => {
		initTheme("dark");
		tempDir = mkdtempSync(join(tmpdir(), "atomic-export-deep-"));
		const header = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: "deep-test",
			timestamp: new Date(0).toISOString(),
			cwd: tempDir,
		} satisfies SessionHeader;
		const lines = [JSON.stringify(header)];
		for (let i = 0; i < depth; i++) {
			const entry: SessionMessageEntry = {
				type: "message",
				id: `e${i}`,
				parentId: i === 0 ? null : `e${i - 1}`,
				timestamp: new Date(i * 1000).toISOString(),
				message: { role: "user", content: "x", timestamp: i * 1000 },
			};
			lines.push(JSON.stringify(entry));
		}
		const sessionPath = join(tempDir, "session.jsonl");
		writeFileSync(sessionPath, `${lines.join("\n")}\n`);
		api = loadTreeApi(readFileSync(await exportFromFile(sessionPath, join(tempDir, "out.html")), "utf8"));
	});

	afterAll(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("builds and flattens a single-child chain deeper than the call stack", () => {
		const tree = api.buildTree();
		assert.equal(tree.length, 1);
		const leafId = `e${depth - 1}`;
		const flat = api.flattenTree(tree, api.buildActivePathIds(leafId));
		assert.equal(flat.length, depth);
		assert.equal(flat[depth - 1].node.entry.id, leafId);
		assert.equal(api.findNewestLeaf("e0"), leafId);
		const path = api.getPath(leafId);
		assert.equal(path.length, depth);
		assert.equal(path[0].id, "e0");
		assert.equal(path[depth - 1].id, leafId);
	});
});
