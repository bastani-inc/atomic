import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";

export interface TodoFrontMatter {
	id: string;
	title: string;
	tags: string[];
	status: string;
	created_at: string;
	assigned_to_session?: string;
}

export interface TodoRecord extends TodoFrontMatter {
	body: string;
}

export interface LockInfo {
	id: string;
	pid: number;
	session?: string | null;
	created_at: string;
}

export const TodoParams = Type.Object({
	action: StringEnum([
		"list",
		"list-all",
		"get",
		"create",
		"update",
		"append",
		"delete",
		"claim",
		"release",
	] as const),
	id: Type.Optional(Type.String({ description: "Todo id (TODO-<hex> or raw hex filename)" })),
	title: Type.Optional(Type.String({ description: "Short summary shown in lists" })),
	status: Type.Optional(Type.String({ description: "Todo status" })),
	tags: Type.Optional(Type.Array(Type.String({ description: "Todo tag" }))),
	body: Type.Optional(
		Type.String({
			description: "Long-form details (markdown). Update replaces; append adds.",
		}),
	),
	force: Type.Optional(Type.Boolean({ description: "Override another session's assignment" })),
});

export type TodoToolParams = Static<typeof TodoParams>;

export type TodoAction =
	| "list"
	| "list-all"
	| "get"
	| "create"
	| "update"
	| "append"
	| "delete"
	| "claim"
	| "release";

export type TodoRecordAction = Exclude<TodoAction, "list" | "list-all">;

export type TodoToolDetails =
	| {
			action: "list" | "list-all";
			todos: TodoFrontMatter[];
			currentSessionId?: string;
			error?: string;
	  }
	| {
			action: TodoRecordAction;
			todo?: TodoRecord;
			error?: string;
	  };

export interface TodoOperationError {
	error: string;
}

export type TodoOperationResult<T> = T | TodoOperationError;

export function isTodoOperationError<T>(result: TodoOperationResult<T>): result is TodoOperationError {
	return typeof result === "object" && result !== null && "error" in result;
}
