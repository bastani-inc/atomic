import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { it } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";
import { TreeSelectorComponent } from "../src/modes/interactive/components/tree-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

it("opens and displays a saved 0.9.x stage transcript without a workflow backend", async () => {
	initTheme("dark");
	const cwd = await mkdtemp(join(tmpdir(), "atomic-old-stage-"));
	try {
		const path = join(cwd, "stage.jsonl");
		const timestamp = "2026-10-01T00:00:00.000Z";
		const header = {
			type: "session",
			version: 4,
			id: "old-stage",
			cwd,
			createdAt: timestamp,
			internal: true,
			workflow: { runId: "old-run", stageId: "review", stageName: "Review" },
		};
		const entries = [
			header,
			{
				type: "custom",
				id: "start",
				parentId: null,
				timestamp,
				customType: "workflow.run.start",
				data: { runId: "old-run", name: "review", inputs: {} },
			},
			{
				type: "message",
				id: "note",
				parentId: "start",
				timestamp,
				message: { role: "user", content: "Keep the saved review notes", timestamp: Date.parse(timestamp) },
			},
			{
				type: "custom",
				id: "end",
				parentId: "note",
				timestamp,
				customType: "workflow.run.end",
				data: { runId: "old-run", status: "completed" },
			},
		];
		await writeFile(path, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
		const session = await SessionManager.open(path);
		try {
			const tree = new TreeSelectorComponent(
				session.getTree(),
				session.getLeafId(),
				40,
				() => {},
				() => {},
				undefined,
				undefined,
				"all",
			);
			const rendered = tree.getTreeList().render(120).map(stripVTControlCharacters).join("\n");
			assert.match(rendered, /Keep the saved review notes/);
			assert.match(rendered, /workflow\.run\.start/);
			assert.match(rendered, /workflow\.run\.end/);
		} finally {
			await session.getSessionStore().close();
		}
	} finally {
		await rm(cwd, { force: true, recursive: true });
	}
});
