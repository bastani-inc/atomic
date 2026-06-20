import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { existsSync } from "node:fs";
import type { ExtensionContext } from "../extensions/types.ts";
import {
	clearAssignmentIfClosed,
	formatTodoId,
	splitTodosByAssignment,
	validateTodoId,
} from "./todos-model.ts";
import { deleteTodo, claimTodoAssignment, releaseTodoAssignment } from "./todos-mutations.ts";
import { getTodoPath, getTodosDir } from "./todos-paths.ts";
import { serializeTodoForAgent, serializeTodoListForAgent } from "./todos-render.ts";
import {
	appendTodoBody,
	ensureTodoExists,
	ensureTodosDir,
	generateTodoId,
	listTodos,
	writeTodoFile,
} from "./todos-storage.ts";
import {
	isTodoOperationError,
	type TodoFrontMatter,
	type TodoRecord,
	type TodoRecordAction,
	type TodoToolDetails,
	type TodoToolParams,
} from "./todos-types.ts";
import { withTodoLock } from "./todos-locks.ts";

function todoActionResult(
	action: TodoRecordAction,
	text: string,
	detailsError: string,
): AgentToolResult<TodoToolDetails> {
	return {
		content: [{ type: "text", text }],
		details: { action, error: detailsError },
	};
}

function idRequiredResult(action: TodoRecordAction): AgentToolResult<TodoToolDetails> {
	return todoActionResult(action, "Error: id required", "id required");
}

function todoSuccessResult(
	action: TodoRecordAction,
	todo: TodoRecord,
): AgentToolResult<TodoToolDetails> {
	return {
		content: [{ type: "text", text: serializeTodoForAgent(todo) }],
		details: { action, todo },
	};
}

function todoListResult(
	action: "list" | "list-all",
	todos: TodoFrontMatter[],
	currentSessionId: string,
): AgentToolResult<TodoToolDetails> {
	return {
		content: [{ type: "text", text: serializeTodoListForAgent(todos) }],
		details: { action, todos, currentSessionId },
	};
}

async function executeListAction(
	todosDir: string,
	ctx: ExtensionContext,
): Promise<AgentToolResult<TodoToolDetails>> {
	const todos = await listTodos(todosDir);
	const { assignedTodos, openTodos } = splitTodosByAssignment(todos);
	const listedTodos = [...assignedTodos, ...openTodos];
	const currentSessionId = ctx.sessionManager.getSessionId();
	return todoListResult("list", listedTodos, currentSessionId);
}

async function executeListAllAction(
	todosDir: string,
	ctx: ExtensionContext,
): Promise<AgentToolResult<TodoToolDetails>> {
	const todos = await listTodos(todosDir);
	const currentSessionId = ctx.sessionManager.getSessionId();
	return todoListResult("list-all", todos, currentSessionId);
}

async function executeGetAction(
	todosDir: string,
	params: TodoToolParams,
): Promise<AgentToolResult<TodoToolDetails>> {
	if (!params.id) return idRequiredResult("get");
	const validated = validateTodoId(params.id);
	if ("error" in validated) {
		return todoActionResult("get", validated.error, validated.error);
	}
	const normalizedId = validated.id;
	const displayId = formatTodoId(normalizedId);
	const filePath = getTodoPath(todosDir, normalizedId);
	const todo = await ensureTodoExists(filePath, normalizedId);
	if (!todo) {
		return todoActionResult("get", `Todo ${displayId} not found`, "not found");
	}
	return todoSuccessResult("get", todo);
}

async function executeCreateAction(
	todosDir: string,
	params: TodoToolParams,
	ctx: ExtensionContext,
): Promise<AgentToolResult<TodoToolDetails>> {
	if (!params.title) {
		return todoActionResult("create", "Error: title required", "title required");
	}
	await ensureTodosDir(todosDir);
	const id = await generateTodoId(todosDir);
	const filePath = getTodoPath(todosDir, id);
	const todo: TodoRecord = {
		id,
		title: params.title,
		tags: params.tags ?? [],
		status: params.status ?? "open",
		created_at: new Date().toISOString(),
		body: params.body ?? "",
	};

	const result = await withTodoLock<TodoRecord>(todosDir, id, ctx, async () => {
		await writeTodoFile(filePath, todo);
		return todo;
	});

	if (isTodoOperationError(result)) {
		return todoActionResult("create", result.error, result.error);
	}
	return todoSuccessResult("create", todo);
}

async function executeUpdateAction(
	todosDir: string,
	params: TodoToolParams,
	ctx: ExtensionContext,
): Promise<AgentToolResult<TodoToolDetails>> {
	if (!params.id) return idRequiredResult("update");
	const validated = validateTodoId(params.id);
	if ("error" in validated) {
		return todoActionResult("update", validated.error, validated.error);
	}
	const normalizedId = validated.id;
	const displayId = formatTodoId(normalizedId);
	const filePath = getTodoPath(todosDir, normalizedId);
	if (!existsSync(filePath)) {
		return todoActionResult("update", `Todo ${displayId} not found`, "not found");
	}
	const result = await withTodoLock<TodoRecord>(todosDir, normalizedId, ctx, async () => {
		const existing = await ensureTodoExists(filePath, normalizedId);
		if (!existing) return { error: `Todo ${displayId} not found` };

		existing.id = normalizedId;
		if (params.title !== undefined) existing.title = params.title;
		if (params.status !== undefined) existing.status = params.status;
		if (params.tags !== undefined) existing.tags = params.tags;
		if (params.body !== undefined) existing.body = params.body;
		if (!existing.created_at) existing.created_at = new Date().toISOString();
		clearAssignmentIfClosed(existing);

		await writeTodoFile(filePath, existing);
		return existing;
	});

	if (isTodoOperationError(result)) {
		return todoActionResult("update", result.error, result.error);
	}
	return todoSuccessResult("update", result);
}

async function executeAppendAction(
	todosDir: string,
	params: TodoToolParams,
	ctx: ExtensionContext,
): Promise<AgentToolResult<TodoToolDetails>> {
	if (!params.id) return idRequiredResult("append");
	const validated = validateTodoId(params.id);
	if ("error" in validated) {
		return todoActionResult("append", validated.error, validated.error);
	}
	const normalizedId = validated.id;
	const displayId = formatTodoId(normalizedId);
	const filePath = getTodoPath(todosDir, normalizedId);
	if (!existsSync(filePath)) {
		return todoActionResult("append", `Todo ${displayId} not found`, "not found");
	}
	const result = await withTodoLock<TodoRecord>(todosDir, normalizedId, ctx, async () => {
		const existing = await ensureTodoExists(filePath, normalizedId);
		if (!existing) return { error: `Todo ${displayId} not found` };
		if (!params.body || !params.body.trim()) {
			return existing;
		}
		return appendTodoBody(filePath, existing, params.body);
	});

	if (isTodoOperationError(result)) {
		return todoActionResult("append", result.error, result.error);
	}
	return todoSuccessResult("append", result);
}

async function executeClaimAction(
	todosDir: string,
	params: TodoToolParams,
	ctx: ExtensionContext,
): Promise<AgentToolResult<TodoToolDetails>> {
	if (!params.id) return idRequiredResult("claim");
	const result = await claimTodoAssignment(todosDir, params.id, ctx, Boolean(params.force));
	if (isTodoOperationError(result)) {
		return todoActionResult("claim", result.error, result.error);
	}
	return todoSuccessResult("claim", result);
}

async function executeReleaseAction(
	todosDir: string,
	params: TodoToolParams,
	ctx: ExtensionContext,
): Promise<AgentToolResult<TodoToolDetails>> {
	if (!params.id) return idRequiredResult("release");
	const result = await releaseTodoAssignment(todosDir, params.id, ctx, Boolean(params.force));
	if (isTodoOperationError(result)) {
		return todoActionResult("release", result.error, result.error);
	}
	return todoSuccessResult("release", result);
}

async function executeDeleteAction(
	todosDir: string,
	params: TodoToolParams,
	ctx: ExtensionContext,
): Promise<AgentToolResult<TodoToolDetails>> {
	if (!params.id) return idRequiredResult("delete");

	const validated = validateTodoId(params.id);
	if ("error" in validated) {
		return todoActionResult("delete", validated.error, validated.error);
	}
	const result = await deleteTodo(todosDir, validated.id, ctx);
	if (isTodoOperationError(result)) {
		return todoActionResult("delete", result.error, result.error);
	}
	return todoSuccessResult("delete", result);
}

export async function executeTodoToolAction(
	params: TodoToolParams,
	ctx: ExtensionContext,
): Promise<AgentToolResult<TodoToolDetails>> {
	const todosDir = getTodosDir(ctx.cwd);

	switch (params.action) {
		case "list":
			return executeListAction(todosDir, ctx);
		case "list-all":
			return executeListAllAction(todosDir, ctx);
		case "get":
			return executeGetAction(todosDir, params);
		case "create":
			return executeCreateAction(todosDir, params, ctx);
		case "update":
			return executeUpdateAction(todosDir, params, ctx);
		case "append":
			return executeAppendAction(todosDir, params, ctx);
		case "claim":
			return executeClaimAction(todosDir, params, ctx);
		case "release":
			return executeReleaseAction(todosDir, params, ctx);
		case "delete":
			return executeDeleteAction(todosDir, params, ctx);
	}
}
