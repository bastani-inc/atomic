import type { SubagentNotifyDetails } from "../runs/background/notify.ts";

const HEADER_PREFIXES = [
	["Background task completed: **", "completed"],
	["Background task failed: **", "failed"],
	["Background task paused: **", "paused"],
] as const;

function isHeaderLineTerminator(character: string): boolean {
	return character === "\r" || character === "\u2028" || character === "\u2029";
}

function isWhitespace(character: string | undefined): boolean {
	return character !== undefined && character.trim() === "";
}

function parseHeader(header: string): Pick<SubagentNotifyDetails, "agent" | "status" | "taskInfo"> | undefined {
	const matchedPrefix = HEADER_PREFIXES.find(([prefix]) => header.startsWith(prefix));
	if (!matchedPrefix) return undefined;
	const [prefix, status] = matchedPrefix;
	const suffix = header.slice(prefix.length);

	if (suffix.endsWith("**")) {
		const agent = suffix.slice(0, -2);
		if (!agent || [...agent].some(isHeaderLineTerminator)) return undefined;
		return { agent, status };
	}
	if (!suffix.endsWith(")")) return undefined;

	const lastInteriorClose = suffix.lastIndexOf(")", suffix.length - 2);
	let index = 1;
	while (index < suffix.length - 1) {
		if (suffix[index] !== "*" || suffix[index + 1] !== "*") {
			index += 1;
			continue;
		}
		let taskStart = index + 2;
		if (!isWhitespace(suffix[taskStart])) {
			index += 1;
			continue;
		}
		while (isWhitespace(suffix[taskStart])) taskStart += 1;
		if (suffix[taskStart] === "(" && taskStart > lastInteriorClose) {
			const agent = suffix.slice(0, index);
			if ([...agent].some(isHeaderLineTerminator)) return undefined;
			return { agent, status, taskInfo: suffix.slice(taskStart) };
		}
		index = taskStart;
	}
	return undefined;
}

export function parseSubagentNotifyContent(content: string): SubagentNotifyDetails | undefined {
	const lines = content.split("\n");
	const parsedHeader = parseHeader(lines[0] ?? "");
	if (!parsedHeader) return undefined;
	const body = lines.slice(2);
	let sessionIndex = -1;
	for (let i = body.length - 1; i >= 1; i--) {
		if (body[i - 1]?.trim() === "" && /^(Session|Session file|Session share error):\s+/.test(body[i]!)) {
			sessionIndex = i;
			break;
		}
	}
	const sessionLine = sessionIndex >= 0 ? body[sessionIndex] : undefined;
	const resultLines = sessionIndex >= 0 ? body.slice(0, sessionIndex) : body;
	const resultPreview = resultLines.join("\n").trim() || "(no output)";
	let sessionLabel: string | undefined;
	let sessionValue: string | undefined;
	if (sessionLine) {
		const separator = sessionLine.indexOf(":");
		sessionLabel = sessionLine.slice(0, separator).toLowerCase();
		sessionValue = sessionLine.slice(separator + 1).trim();
	}
	return {
		...parsedHeader,
		resultPreview,
		...(sessionLabel && sessionValue ? { sessionLabel, sessionValue } : {}),
	};
}
