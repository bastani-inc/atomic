import assert from "node:assert/strict";
import { test } from "vitest";
import { readExpandedChildDetails } from "../../packages/coding-agent/src/core/storage/session/expanded-child-details.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { storageBackends } from "../helpers/storage-backends.js";

for (const backend of storageBackends) {
	(backend.skipReason ? test.skip : test)(
		`a saved launch card reads its child branch in a read-only snapshot on ${backend.name} (#5594)`,
		async () => {
			const scope = await backend.openScope();
			try {
				const db = await scope.connect();
				const store = await SqlSessionStore.open(db, { prefix: scope.prefix });
				const timestamp = new Date(0).toISOString();
				await store.create({ id: "card-child", version: 4, createdAt: timestamp, cwd: "/example" }, [
					{
						type: "message",
						id: "launch",
						parentId: null,
						timestamp,
						message: { role: "user", content: "inherited", timestamp: 1 },
					},
					{
						type: "message",
						id: "own",
						parentId: "launch",
						timestamp,
						message: { role: "user", content: "child prompt", timestamp: 2 },
					},
				]);
				assert.deepEqual(await readExpandedChildDetails(store, "card-child", { launchLeafId: "launch" }), {
					prompt: "child prompt",
					lines: ["› child prompt"],
					toolCalls: [],
				});
			} finally {
				await scope.close();
			}
		},
	);
}
