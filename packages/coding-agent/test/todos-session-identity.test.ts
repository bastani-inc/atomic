import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, vi } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";
import { MemorySessionStore } from "../src/core/storage/session/memory-session-store.js";
import { createTodoToolDefinition } from "../src/core/tools/todos.ts";
import { renderTodoResult } from "../src/core/tools/todos-render.ts";
import type { TodoToolParams } from "../src/core/tools/todos-types.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.js";
import { createHarness } from "./suite/harness.ts";

test("an empty stored session ID owns a todo until its owner releases it", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-todo-identity-"));
	vi.stubEnv("ATOMIC_TODO_PATH", join(cwd, "todos"));
	const store = new MemorySessionStore();
	await store.create({ id: "", version: 4, createdAt: new Date().toISOString(), cwd }, []);
	const owner = await createHarness({ sessionManager: await SessionManager.open(store, "") });
	const other = await createHarness({ sessionManager: SessionManager.inMemory(cwd, { id: "other" }) });
	const tool = createTodoToolDefinition(cwd);
	const run = (params: TodoToolParams, harness = owner) =>
		tool.execute(
			"todo",
			params,
			undefined,
			undefined,
			harness.session.extensionRunner.createToolContext("todo", undefined),
		);
	try {
		const open = await run({ action: "create", title: "unassigned" });
		assert.ok(open.details && "todo" in open.details && open.details.todo);
		const created = await run({ action: "create", title: "owned by empty ID" });
		assert.ok(created.details && "todo" in created.details && created.details.todo);
		const id = created.details.todo.id;
		await run({ action: "claim", id });
		const read = await run({ action: "get", id });
		assert.ok(read.details && "todo" in read.details && read.details.todo);
		assert.equal(read.details.todo.assigned_to_session, "");
		assert.match((await run({ action: "claim", id }, other)).details?.error ?? "", /already assigned to session/);
		assert.match((await run({ action: "release", id }, other)).details?.error ?? "", /assigned to session/);
		const listed = await run({ action: "list" });
		assert.ok(listed.details && "todos" in listed.details);
		assert.deepEqual(
			listed.details.todos.map((todo) => todo.id),
			[id, open.details.todo.id],
		);
		const released = await run({ action: "release", id });
		initTheme("dark");
		assert.match(
			renderTodoResult(listed, { expanded: true, isPartial: false }, theme).render(120).join("\n"),
			/assigned: , current/,
		);
		assert.ok(released.details && "todo" in released.details && released.details.todo);
		assert.equal(released.details.todo.assigned_to_session, undefined);
	} finally {
		await owner.cleanup();
		await other.cleanup();
		await store.close();
		vi.unstubAllEnvs();
		rmSync(cwd, { recursive: true, force: true });
	}
});
