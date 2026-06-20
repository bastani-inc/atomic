import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import type { ExtensionContext } from "../extensions/types.ts";
import { displayTodoId, isTodoClosed, validateTodoId } from "./todos-model.ts";
import { getTodoPath } from "./todos-paths.ts";
import { withTodoLock } from "./todos-locks.ts";
import { ensureTodoExists, writeTodoFile } from "./todos-storage.ts";
import type { TodoOperationResult, TodoRecord } from "./todos-types.ts";

export async function claimTodoAssignment(
	todosDir: string,
	id: string,
	ctx: ExtensionContext,
	force = false,
): Promise<TodoOperationResult<TodoRecord>> {
	const validated = validateTodoId(id);
	if ("error" in validated) {
		return { error: validated.error };
	}
	const normalizedId = validated.id;
	const filePath = getTodoPath(todosDir, normalizedId);
	if (!existsSync(filePath)) {
		return { error: `Todo ${displayTodoId(id)} not found` };
	}
	const sessionId = ctx.sessionManager.getSessionId();
	return withTodoLock<TodoRecord>(todosDir, normalizedId, ctx, async () => {
		const existing = await ensureTodoExists(filePath, normalizedId);
		if (!existing) return { error: `Todo ${displayTodoId(id)} not found` };
		if (isTodoClosed(existing.status)) {
			return { error: `Todo ${displayTodoId(id)} is closed` };
		}
		const assigned = existing.assigned_to_session;
		if (assigned && assigned !== sessionId && !force) {
			return {
				error: `Todo ${displayTodoId(id)} is already assigned to session ${assigned}. Use force to override.`,
			};
		}
		if (assigned !== sessionId) {
			existing.assigned_to_session = sessionId;
			await writeTodoFile(filePath, existing);
		}
		return existing;
	});
}

export async function releaseTodoAssignment(
	todosDir: string,
	id: string,
	ctx: ExtensionContext,
	force = false,
): Promise<TodoOperationResult<TodoRecord>> {
	const validated = validateTodoId(id);
	if ("error" in validated) {
		return { error: validated.error };
	}
	const normalizedId = validated.id;
	const filePath = getTodoPath(todosDir, normalizedId);
	if (!existsSync(filePath)) {
		return { error: `Todo ${displayTodoId(id)} not found` };
	}
	const sessionId = ctx.sessionManager.getSessionId();
	return withTodoLock<TodoRecord>(todosDir, normalizedId, ctx, async () => {
		const existing = await ensureTodoExists(filePath, normalizedId);
		if (!existing) return { error: `Todo ${displayTodoId(id)} not found` };
		const assigned = existing.assigned_to_session;
		if (!assigned) {
			return existing;
		}
		if (assigned !== sessionId && !force) {
			return {
				error: `Todo ${displayTodoId(id)} is assigned to session ${assigned}. Use force to release.`,
			};
		}
		existing.assigned_to_session = undefined;
		await writeTodoFile(filePath, existing);
		return existing;
	});
}

export async function deleteTodo(
	todosDir: string,
	id: string,
	ctx: ExtensionContext,
): Promise<TodoOperationResult<TodoRecord>> {
	const validated = validateTodoId(id);
	if ("error" in validated) {
		return { error: validated.error };
	}
	const normalizedId = validated.id;
	const filePath = getTodoPath(todosDir, normalizedId);
	if (!existsSync(filePath)) {
		return { error: `Todo ${displayTodoId(id)} not found` };
	}

	return withTodoLock<TodoRecord>(todosDir, normalizedId, ctx, async () => {
		const existing = await ensureTodoExists(filePath, normalizedId);
		if (!existing) return { error: `Todo ${displayTodoId(id)} not found` };
		await fs.unlink(filePath);
		return existing;
	});
}
