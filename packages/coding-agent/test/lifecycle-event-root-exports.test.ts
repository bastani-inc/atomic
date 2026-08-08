import type { AssistantMessageEvent } from "@earendil-works/pi-ai/compat";
import { expectTypeOf, test } from "vitest";
import type {
	MessageEndEvent,
	MessageStartEvent,
	MessageUpdateEvent,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
	ToolExecutionUpdateEvent,
} from "../src/index.ts";

test("package root exports message and tool execution lifecycle event types", () => {
	expectTypeOf<MessageStartEvent>().toHaveProperty("type");
	expectTypeOf<MessageUpdateEvent>().toEqualTypeOf<{
		type: "message_update";
		assistantMessageEvent: AssistantMessageEvent;
	}>();
	expectTypeOf<MessageEndEvent>().toHaveProperty("type");
	expectTypeOf<ToolExecutionStartEvent>().toHaveProperty("type");
	expectTypeOf<ToolExecutionUpdateEvent>().toHaveProperty("type");
	expectTypeOf<ToolExecutionEndEvent>().toHaveProperty("type");
});
