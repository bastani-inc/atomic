import type { ImageContent } from "@bastani/atomic-ai/compat";
import type { Args } from "./args.ts";

export interface InitialMessageInput {
	parsed: Args;
	fileText?: string;
	fileImages?: ImageContent[];
	stdinContent?: string;
}

export interface InitialMessageResult {
	initialMessage?: string;
	initialImages?: ImageContent[];
}

/**
 * Combine stdin content, @file text, and the first CLI message into a single
 * initial prompt for non-interactive mode.
 */
export function buildInitialMessage({
	parsed,
	fileText,
	fileImages,
	stdinContent,
}: InitialMessageInput): InitialMessageResult {
	const parts: string[] = [];
	if (stdinContent !== undefined) {
		parts.push(stdinContent);
	}
	if (fileText) {
		parts.push(fileText);
	}

	if (parsed.messages.length > 0) {
		parts.push(parsed.messages[0]);
		parsed.messages.shift();
	}

	let initialMessage: string | undefined;
	if (parts.length > 0) {
		const needsStdinSeparator =
			stdinContent !== undefined &&
			stdinContent.length > 0 &&
			parts.length > 1 &&
			!/\s$/.test(stdinContent) &&
			parts[1]!.length > 0 &&
			!/^\s/.test(parts[1]!);
		initialMessage = needsStdinSeparator ? `${parts[0]}\n\n${parts.slice(1).join("")}` : parts.join("");
	}

	return {
		initialMessage,
		initialImages: fileImages && fileImages.length > 0 ? fileImages : undefined,
	};
}
