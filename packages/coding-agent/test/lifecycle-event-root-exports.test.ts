import type {
	MessageEndEvent,
	MessageStartEvent,
	MessageUpdateEvent,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
	ToolExecutionUpdateEvent,
} from "../src/index.ts";
import { expectTypeOf, test } from "vitest";

test("package root exports message and tool execution lifecycle event types", () => {
	expectTypeOf<MessageStartEvent>().toHaveProperty("type");
	expectTypeOf<MessageUpdateEvent>().toHaveProperty("type");
	expectTypeOf<MessageEndEvent>().toHaveProperty("type");
	expectTypeOf<ToolExecutionStartEvent>().toHaveProperty("type");
	expectTypeOf<ToolExecutionUpdateEvent>().toHaveProperty("type");
	expectTypeOf<ToolExecutionEndEvent>().toHaveProperty("type");
});
