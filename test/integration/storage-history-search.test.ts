import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { runStorageCommand } from "../../packages/coding-agent/src/cli/storage-command.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { createHistoryRouter } from "../../packages/coding-agent/src/core/tools/history-protocol.js";
import { createSearchToolDefinition } from "../../packages/coding-agent/src/core/tools/search.js";

test.each(["current", "migrated"])(
	"storage search-session preserves the first page of a %s transcript (#5479)",
	async (version) => {
		const cwd = await mkdtemp(join(tmpdir(), "atomic-storage-search-"));
		const path = join(cwd, "sessions.sqlite");
		const db = await openNodeSqliteDatabase(path);
		try {
			const store = await SqlSessionStore.open(db);
			try {
				const timestamp = new Date(0).toISOString();
				const context = "界".repeat(500);
				await store.create(
					{ version: 4, id: "sample", cwd, createdAt: timestamp },
					Array.from({ length: 9 }, (_, i) => ({
						id: `m${i}`,
						parentId: i ? `m${i - 1}` : null,
						timestamp,
						type: "message",
						message: {
							role: "user",
							timestamp: i,
							content: [context, `needle-${i}${context}`, context, context, context].join("\n"),
						},
					})),
				);
				// Rows migrated from before write revisions keep the empty default until the next write.
				if (version !== "current") await db.run("UPDATE session_sessions SET revision = '' WHERE id = ?", "sample");
				const base = "history://sessions/sample";
				const router = createHistoryRouter({ cwd, sessionStore: () => store, workflows: () => undefined });
				const search = createSearchToolDefinition(cwd);
				async function manual(paths: string) {
					const page = await search.execute("manual", { pattern: "needle", paths }, undefined, undefined, {
						cwd,
						internalResourceRouter: router,
					} as never);
					const block = page.content[0];
					assert.ok(block?.type === "text");
					return block.text;
				}
				const first = await manual(base);
				assert.ok(first.includes(`the byte budget ran out; continue with ${base}?cursor=6]`));
				const second = await manual(`${base}?cursor=6`);
				assert.ok(!second.includes("the byte budget ran out"));
				const pages: string[] = [],
					errors: string[] = [];
				const code = await runStorageCommand(["search-session", path, "sample", "needle"], {
					cwd,
					agentDir: cwd,
					log: (page) => pages.push(page),
					error: (error) => errors.push(error),
				});
				assert.equal(code, 0, errors.join("\n"));
				assert.deepEqual(pages, version === "current" ? [first, second] : [first]);
			} finally {
				await store.close();
			}
		} finally {
			await db.close();
			await rm(cwd, { force: true, recursive: true });
		}
	},
);
