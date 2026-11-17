import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, expect, test } from "vitest";
import { getReadmePath } from "../src/config.ts";
import { createToolHtmlRenderer } from "../src/core/export-html/tool-renderer.ts";
import { withWorktreeRootMappings } from "../src/core/resume/path-mapping.ts";
import { resolveToCwdAsync } from "../src/core/tools/path-utils.ts";
import { createReadToolDefinition } from "../src/core/tools/read.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const roots: string[] = [];

beforeAll(() => initTheme("dark"));

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function htmlText(html: string): string {
	return html
		.replace(/<[^>]+>/g, "")
		.replaceAll("&nbsp;", " ")
		.replaceAll("&amp;", "&");
}

test.each([
	{ title: "skill", path: `@${join(process.cwd(), "attio", "SKILL.md")}`, compact: "[skill] attio" },
	{ title: "docs", path: `@${getReadmePath()}`, compact: "read docs README.md" },
])(
	"an HTML export of a read renderer under another tool name shows an @-mentioned $title compactly",
	({ path, compact }) => {
		const definition = createReadToolDefinition(process.cwd());
		const renderer = createToolHtmlRenderer({
			getToolRenderers: (name) => (name === "open_file" ? definition : undefined),
			theme,
			cwd: process.cwd(),
		});
		const html = renderer.renderCall("call-1", "open_file", { path });
		assert.ok(html, "the read renderer rendered nothing");
		expect(htmlText(html)).toContain(compact);
	},
);

test("a read row whose path cannot be resolved under a restored checkout keeps its label without a rejection", async () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-read-label-loop-"));
	roots.push(root);
	const worktree = join(root, "wt");
	mkdirSync(worktree);
	const loop = join(worktree, "loop");
	symlinkSync(loop, loop, process.platform === "win32" ? "junction" : undefined);
	const path = `@${join(loop, "SKILL.md")}`;
	const rejections: unknown[] = [];
	const onRejection = (reason: unknown) => rejections.push(reason);
	process.on("unhandledRejection", onRejection);
	try {
		const rendered = await withWorktreeRootMappings(
			[
				{
					from: join(root, "elsewhere"),
					to: worktree,
					snapshotId: "s".repeat(64),
					tree: "t".repeat(40),
					restoredAt: "2026-11-05T00:00:00.000Z",
				},
			],
			async () => {
				const row = new ToolExecutionComponent(
					"read",
					"read-loop",
					{ path },
					{},
					createReadToolDefinition(worktree),
					{ requestRender: () => {} } as never,
					worktree,
				);
				const text = stripAnsi(row.render(120).join("\n"));
				await assert.rejects(resolveToCwdAsync(path, worktree));
				return text;
			},
		);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(rendered).toContain("[skill] loop");
		expect(rejections).toEqual([]);
	} finally {
		process.off("unhandledRejection", onRejection);
	}
});
