(function (root) {
	"use strict";

	function extractText(content) {
		if (content == null) return "";
		if (typeof content === "string") return content;
		if (!Array.isArray(content)) return String(content);
		return content
			.map((block) => {
				if (!block || typeof block !== "object") return "";
				if (block.type === "text") return block.text || "";
				if (block.type === "thinking") return "";
				return "";
			})
			.join("");
	}

	function extractThinking(content) {
		if (!Array.isArray(content)) return "";
		return content
			.filter((block) => block && block.type === "thinking")
			.map((block) => block.thinking || "")
			.join("\n");
	}

	function createSession() {
		return {
			items: [],
			streaming: false,
			streamingId: null,
			nextId: 1,
			pendingUser: null,
			tools: new Map(),
		};
	}

	function push(session, item) {
		item.id = item.id || `item-${session.nextId++}`;
		session.items.push(item);
		return item;
	}

	function applyAssistantDelta(item, event) {
		if (!event || typeof event !== "object") return;
		item.parts = item.parts || [{ type: "text", text: "" }];
		const index = event.contentIndex ?? 0;
		while (item.parts.length <= index) item.parts.push({ type: "text", text: "" });
		const part = item.parts[index];
		switch (event.type) {
			case "text_start":
				item.parts[index] = { type: "text", text: "" };
				break;
			case "text_delta":
				if (part.type !== "text") item.parts[index] = { type: "text", text: event.delta || "" };
				else part.text += event.delta || "";
				break;
			case "text_end":
				item.parts[index] = { type: "text", text: event.content || "" };
				break;
			case "thinking_start":
				item.parts[index] = { type: "thinking", thinking: "" };
				break;
			case "thinking_delta":
				if (part.type !== "thinking") {
					item.parts[index] = { type: "thinking", thinking: event.delta || "" };
				} else part.thinking += event.delta || "";
				break;
			case "thinking_end":
				item.parts[index] = { type: "thinking", thinking: event.content || "" };
				break;
			default:
				break;
		}
		item.text = item.parts
			.filter((entry) => entry.type === "text")
			.map((entry) => entry.text)
			.join("");
		item.thinking = item.parts
			.filter((entry) => entry.type === "thinking")
			.map((entry) => entry.thinking)
			.join("\n");
	}

	function ingestMessage(session, message, streaming) {
		if (!message || typeof message !== "object") return;
		if (message.role === "user") {
			const text = extractText(message.content);
			if (session.pendingUser && session.pendingUser.text === text) {
				session.pendingUser = null;
				return;
			}
			push(session, { kind: "user", text });
			return;
		}
		if (message.role === "assistant") {
			const item = {
				kind: "assistant",
				text: extractText(message.content),
				thinking: extractThinking(message.content),
				parts: Array.isArray(message.content) ? message.content.map((block) => ({ ...block })) : [],
				streaming: Boolean(streaming),
			};
			if (streaming) {
				session.streamingId = push(session, item).id;
			} else {
				const existing = session.items.find((entry) => entry.id === session.streamingId);
				if (existing) {
					existing.text = item.text;
					existing.thinking = item.thinking;
					existing.parts = item.parts;
					existing.streaming = false;
					session.streamingId = null;
				} else {
					push(session, item);
				}
			}
		}
	}

	function handleEvent(session, event) {
		if (!event || typeof event !== "object") return { kind: "ignored" };
		switch (event.type) {
			case "agent_start":
				session.streaming = true;
				return { kind: "status", streaming: true };
			case "agent_end":
			case "agent_settled":
				session.streaming = false;
				return { kind: "status", streaming: false };
			case "message_start":
				ingestMessage(session, event.message, event.message && event.message.role === "assistant");
				return { kind: "transcript" };
			case "message_update":
				if (session.streamingId) {
					const item = session.items.find((entry) => entry.id === session.streamingId);
					if (item) applyAssistantDelta(item, event.assistantMessageEvent);
				}
				return { kind: "transcript" };
			case "message_end":
				ingestMessage(session, event.message, false);
				return { kind: "transcript" };
			case "tool_execution_start": {
				const tool = push(session, {
					kind: "tool",
					toolCallId: event.toolCallId,
					toolName: event.toolName || "tool",
					args: event.args,
					phase: "running",
					output: "",
				});
				session.tools.set(event.toolCallId, tool.id);
				return { kind: "transcript" };
			}
			case "tool_execution_update": {
				const id = session.tools.get(event.toolCallId);
				const tool = session.items.find((entry) => entry.id === id);
				if (tool) {
					tool.args = event.args || tool.args;
					tool.output = extractText(event.partialResult && event.partialResult.content);
				}
				return { kind: "transcript" };
			}
			case "tool_execution_end": {
				const id = session.tools.get(event.toolCallId);
				const tool = session.items.find((entry) => entry.id === id);
				if (tool) {
					tool.phase = event.isError ? "error" : "done";
					tool.output = extractText(event.result && event.result.content) || tool.output;
				}
				return { kind: "transcript" };
			}
			case "model_changed":
				return { kind: "model", model: event.model };
			case "session_info_changed":
				return { kind: "session-name", name: event.name };
			case "extension_ui_request":
				return { kind: "ui", request: event };
			default:
				if (typeof event.type === "string" && event.type.startsWith("engine_")) {
					return { kind: "ignored" };
				}
				return { kind: "ignored" };
		}
	}

	function loadMessages(session, messages) {
		session.items = [];
		session.tools = new Map();
		session.streamingId = null;
		session.pendingUser = null;
		for (const message of messages || []) ingestMessage(session, message, false);
	}

	function noteLocalUser(session, text) {
		const item = push(session, { kind: "user", text });
		session.pendingUser = item;
		return item;
	}

	root.AtomicSession = {
		createSession,
		handleEvent,
		loadMessages,
		noteLocalUser,
		extractText,
	};
})(globalThis);
