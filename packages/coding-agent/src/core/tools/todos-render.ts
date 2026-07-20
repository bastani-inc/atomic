import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Text } from "@earendil-works/pi-tui";
import { parenthesizedKeyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { ToolRenderResultOptions } from "../extensions/types.ts";
import {
	formatTodoId,
	getTodoStatus,
	getTodoTitle,
	isTodoClosed,
	normalizeTodoId,
	splitTodosByAssignment,
} from "./todos-model.ts";
import type { TodoFrontMatter, TodoRecord, TodoToolDetails, TodoToolParams } from "./todos-types.ts";

export function serializeTodoForAgent(todo: TodoRecord): string {
	const payload = { ...todo, id: formatTodoId(todo.id) };
	return JSON.stringify(payload, null, 2);
}

export function serializeTodoListForAgent(todos: TodoFrontMatter[]): string {
	const { assignedTodos, openTodos, closedTodos } = splitTodosByAssignment(todos);
	const mapTodo = (todo: TodoFrontMatter) => ({
		...todo,
		id: formatTodoId(todo.id),
	});
	return JSON.stringify(
		{
			assigned: assignedTodos.map(mapTodo),
			open: openTodos.map(mapTodo),
			closed: closedTodos.map(mapTodo),
		},
		null,
		2,
	);
}

function renderAssignmentSuffix(
	theme: Theme,
	todo: TodoFrontMatter,
	currentSessionId?: string,
): string {
	if (!todo.assigned_to_session) return "";
	const isCurrent = todo.assigned_to_session === currentSessionId;
	const color = isCurrent ? "success" : "dim";
	const suffix = isCurrent ? ", current" : "";
	return theme.fg(color, ` (assigned: ${todo.assigned_to_session}${suffix})`);
}

function renderTodoHeading(
	theme: Theme,
	todo: TodoFrontMatter,
	currentSessionId?: string,
): string {
	const closed = isTodoClosed(getTodoStatus(todo));
	const titleColor = closed ? "dim" : "text";
	const tagText = todo.tags.length ? theme.fg("dim", ` [${todo.tags.join(", ")}]`) : "";
	const assignmentText = renderAssignmentSuffix(theme, todo, currentSessionId);
	return (
		theme.fg("accent", formatTodoId(todo.id)) +
		" " +
		theme.fg(titleColor, getTodoTitle(todo)) +
		tagText +
		assignmentText
	);
}

function renderTodoList(
	theme: Theme,
	todos: TodoFrontMatter[],
	expanded: boolean,
	currentSessionId?: string,
): string {
	if (!todos.length) return theme.fg("dim", "No todos");

	const { assignedTodos, openTodos, closedTodos } = splitTodosByAssignment(todos);
	const lines: string[] = [];
	const pushSection = (label: string, sectionTodos: TodoFrontMatter[]) => {
		lines.push(theme.fg("muted", `${label} (${sectionTodos.length})`));
		if (!sectionTodos.length) {
			lines.push(theme.fg("dim", "  none"));
			return;
		}
		const maxItems = expanded ? sectionTodos.length : Math.min(sectionTodos.length, 3);
		for (let i = 0; i < maxItems; i++) {
			lines.push(`  ${renderTodoHeading(theme, sectionTodos[i], currentSessionId)}`);
		}
		if (!expanded && sectionTodos.length > maxItems) {
			lines.push(theme.fg("dim", `  ... ${sectionTodos.length - maxItems} more`));
		}
	};

	const sections: Array<{ label: string; todos: TodoFrontMatter[] }> = [
		{ label: "Assigned todos", todos: assignedTodos },
		{ label: "Open todos", todos: openTodos },
		{ label: "Closed todos", todos: closedTodos },
	];

	sections.forEach((section, index) => {
		if (index > 0) lines.push("");
		pushSection(section.label, section.todos);
	});

	return lines.join("\n");
}

function renderTodoDetail(theme: Theme, todo: TodoRecord, expanded: boolean): string {
	const summary = renderTodoHeading(theme, todo);
	if (!expanded) return summary;

	const tags = todo.tags.length ? todo.tags.join(", ") : "none";
	const createdAt = todo.created_at || "unknown";
	const bodyText = todo.body?.trim() ? todo.body.trim() : "No details yet.";
	const bodyLines = bodyText.split("\n");

	const lines = [
		summary,
		theme.fg("muted", `Status: ${getTodoStatus(todo)}`),
		theme.fg("muted", `Tags: ${tags}`),
		theme.fg("muted", `Created: ${createdAt}`),
		"",
		theme.fg("muted", "Body:"),
		...bodyLines.map((line) => theme.fg("text", `  ${line}`)),
	];

	return lines.join("\n");
}

function appendExpandHint(theme: Theme, text: string): string {
	const hint = parenthesizedKeyHint("app.tools.expand", "Expand");
	return hint ? `${text}\n${theme.fg("dim", hint)}` : text;
}

function getActionLabel(action: TodoToolDetails["action"]): string | null {
	return action === "create"
		? "Created"
		: action === "update"
			? "Updated"
			: action === "append"
				? "Appended to"
				: action === "delete"
					? "Deleted"
					: action === "claim"
						? "Claimed"
						: action === "release"
							? "Released"
							: null;
}

export function renderTodoCall(args: TodoToolParams, theme: Theme): Text {
	const action = typeof args.action === "string" ? args.action : "";
	const id = typeof args.id === "string" ? args.id : "";
	const normalizedId = id ? normalizeTodoId(id) : "";
	const title = typeof args.title === "string" ? args.title : "";
	let text = theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", action);
	if (normalizedId) {
		text += " " + theme.fg("accent", formatTodoId(normalizedId));
	}
	if (title) {
		text += " " + theme.fg("dim", `"${title}"`);
	}
	return new Text(text, 0, 0);
}

export function renderTodoResult(
	result: AgentToolResult<TodoToolDetails>,
	{ expanded, isPartial }: ToolRenderResultOptions,
	theme: Theme,
): Text {
	const details = result.details as TodoToolDetails | undefined;
	if (isPartial) {
		return new Text(theme.fg("warning", "Processing..."), 0, 0);
	}
	if (!details) {
		const text = result.content[0];
		return new Text(text?.type === "text" ? text.text : "", 0, 0);
	}

	if (details.error) {
		return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
	}

	if (details.action === "list" || details.action === "list-all") {
		let text = renderTodoList(theme, details.todos, expanded, details.currentSessionId);
		if (!expanded) {
			const { closedTodos } = splitTodosByAssignment(details.todos);
			if (closedTodos.length) {
				text = appendExpandHint(theme, text);
			}
		}
		return new Text(text, 0, 0);
	}

	if (!("todo" in details) || !details.todo) {
		const text = result.content[0];
		return new Text(text?.type === "text" ? text.text : "", 0, 0);
	}

	let text = renderTodoDetail(theme, details.todo, expanded);
	const actionLabel = getActionLabel(details.action);
	if (actionLabel) {
		const lines = text.split("\n");
		lines[0] = theme.fg("success", "✓ ") + theme.fg("muted", `${actionLabel} `) + lines[0];
		text = lines.join("\n");
	}
	if (!expanded) {
		text = appendExpandHint(theme, text);
	}
	return new Text(text, 0, 0);
}
