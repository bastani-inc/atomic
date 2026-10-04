import assert from "node:assert/strict";
import { Pool } from "pg";
import { test, vi } from "vitest";
import { DbosOwnerFence } from "../../packages/workflows/src/durable/dbos-owner-fence.js";

test("failed owner acquisition retires the generation so explicit recovery can create a successor (#3419)", async () => {
	const pool = new Pool();
	const connect = vi.spyOn(pool, "connect").mockRejectedValue(new Error("connection refused"));
	const fence = new DbosOwnerFence(
		() => pool,
		"atomic-db-11111111-1111-4111-8111-111111111111",
		() => pool.end(),
	);
	try {
		await assert.rejects(
			fence.write("run", async () => {}),
			/connection refused/,
		);
		assert.equal(fence.invalidated, true);
		await assert.rejects(
			fence.write("run", async () => {}),
			/ownership connection was lost/,
		);
		assert.equal(connect.mock.calls.length, 1);
	} finally {
		connect.mockRestore();
		await fence.close();
	}
});
