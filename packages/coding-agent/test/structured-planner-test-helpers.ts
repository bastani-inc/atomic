import type { Context } from "@bastani/pi-ai/compat";
import { createFauxStreamFn } from "./test-harness.js";

type Request = { messages: Array<{ id: number; lines: string[] }> };

export function plannerRequest(context: Context): Request {
	for (const message of context.messages) {
		const text =
			typeof message.content === "string"
				? message.content
				: message.content
						.filter((block) => block.type === "text")
						.map((block) => block.text)
						.join("");
		const match = /<compaction_request>\n([\s\S]*?)\n<\/compaction_request>/.exec(text);
		if (match) return JSON.parse(match[1]) as Request;
	}
	throw new Error("Expected structured compaction request");
}

export function messageLocalRecords(text: string, request: Request): string {
	return text.replace(/^(\d+),(\d+)(\n|$)/gm, (record, startText, endText, terminator) => {
		const start = Number(startText);
		const end = Number(endText);
		if (start > end) return record;
		let offset = 0;
		const records: string[] = [];
		for (const message of request.messages) {
			const localStart = Math.max(1, start - offset);
			const localEnd = Math.min(message.lines.length, end - offset);
			if (localStart <= localEnd) records.push(`${message.id}:${localStart},${localEnd}`);
			offset += message.lines.length;
		}
		return records.length ? records.join("\n") + terminator : record;
	});
}

export function createPlannerStreamFn(
	responses: Parameters<typeof createFauxStreamFn>[0],
): ReturnType<typeof createFauxStreamFn> {
	const state: ReturnType<typeof createFauxStreamFn>["state"] = { callCount: 0, contexts: [] };
	return {
		state,
		streamFn: (model, context, options) => {
			const response = responses[state.callCount++ % responses.length];
			state.contexts.push(context);
			const request = plannerRequest(context);
			const translated =
				typeof response === "string"
					? messageLocalRecords(response, request)
					: {
							...response,
							...(response.text !== undefined ? { text: messageLocalRecords(response.text, request) } : {}),
						};
			return createFauxStreamFn([translated]).streamFn(model, context, options);
		},
	};
}
