/**
 * This tool stores todo items as files under <todo-dir> (defaults to
 * <CONFIG_DIR_NAME>/todos, or the path in <APP_NAME>_TODO_PATH). Each todo is
 * a standalone markdown file named <id>.md and an optional <id>.lock file is
 * used while a session is editing it.
 *
 * File format in <CONFIG_DIR_NAME>/todos:
 * - The file starts with a JSON object (not YAML) containing the front matter:
 *   { id, title, tags, status, created_at, assigned_to_session }
 * - After the JSON block comes optional markdown body text separated by a blank line.
 */
import type { ToolDefinition } from "../extensions/types.ts";
import { executeTodoToolAction } from "./todos-execute.ts";
import { getTodosDirLabel } from "./todos-paths.ts";
import { renderTodoCall, renderTodoResult } from "./todos-render.ts";
import { TodoParams, type TodoToolDetails } from "./todos-types.ts";

export const DEFAULT_PROMPT_GUIDANCE: string[] = [
	"**To-do management**: If the user has a complex task that can be broken down into actionable steps, use the `todo` tool to create a task list before proceeding. This ensures clarity and alignment with the user's goals and that you have a way to track your work and ensure you are meeting the user's expectations.",
];

export function createTodoToolDefinition(
	cwd: string = process.cwd(),
): ToolDefinition<typeof TodoParams, TodoToolDetails> {
	const todosDirLabel = getTodosDirLabel(cwd);

	return {
		name: "todo",
		label: "Todo",
		description:
			`Manage file-based todos in ${todosDirLabel} (list, list-all, get, create, update, append, delete, claim, release). ` +
			"Title is the short summary; body is long-form markdown notes (update replaces, append adds). " +
			"Todo ids are shown as TODO-<hex>; id parameters accept TODO-<hex> or the raw hex filename. " +
			"Claim tasks before working on them to avoid conflicts, and close them when complete.",
		parameters: TodoParams,
		promptGuidelines: DEFAULT_PROMPT_GUIDANCE,
		execute: (_toolCallId, params, _signal, _onUpdate, ctx) => executeTodoToolAction(params, ctx),
		renderCall: renderTodoCall,
		renderResult: renderTodoResult,
	};
}
