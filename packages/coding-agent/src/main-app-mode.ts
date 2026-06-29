import type { ImageContent } from "@earendil-works/pi-ai/compat";
import type { Args, Mode } from "./cli/args.ts";
import { processFileArguments } from "./cli/file-processor.ts";
import { buildInitialMessage } from "./cli/initial-message.ts";
import type { CreateAgentSessionOptions } from "./core/sdk.ts";
import { isLocalPath, resolvePath } from "./utils/paths.ts";

export type AppMode = "interactive" | "print" | "json" | "rpc";

const NO_UI_EXCLUDED_TOOLS = ["ask_user_question"] as const;

export function resolveExcludedToolsForAppMode(
	appMode: AppMode,
	excludedTools: CreateAgentSessionOptions["excludedTools"],
): CreateAgentSessionOptions["excludedTools"] {
	switch (appMode) {
		case "interactive":
		case "rpc":
			return excludedTools;
		case "print":
		case "json":
			return [...new Set([...(excludedTools ?? []), ...NO_UI_EXCLUDED_TOOLS])];
	}
}

export function resolveAppMode(parsed: Args, stdinIsTTY: boolean, stdoutIsTTY: boolean): AppMode {
	if (parsed.mode === "rpc") {
		return "rpc";
	}
	if (parsed.mode === "json") {
		return "json";
	}
	if (parsed.print || !stdinIsTTY || !stdoutIsTTY) {
		return "print";
	}
	return "interactive";
}

export function isReadOnlyRuntimeMetadataCommand(parsed: Args): boolean {
	return parsed.help === true || parsed.listModels !== undefined;
}

export function isPlainRuntimeMetadataCommand(parsed: Args): boolean {
	return !parsed.print && parsed.mode === undefined && isReadOnlyRuntimeMetadataCommand(parsed);
}

export function toPrintOutputMode(appMode: AppMode): Exclude<Mode, "rpc"> {
	return appMode === "json" ? "json" : "text";
}

export async function prepareInitialMessage(
	parsed: Args,
	autoResizeImages: boolean,
	stdinContent?: string,
): Promise<{
	initialMessage?: string;
	initialImages?: ImageContent[];
}> {
	if (parsed.fileArgs.length === 0) {
		return buildInitialMessage({ parsed, stdinContent });
	}

	const { text, images } = await processFileArguments(parsed.fileArgs, { autoResizeImages });
	return buildInitialMessage({
		parsed,
		fileText: text,
		fileImages: images,
		stdinContent,
	});
}

export function resolveCliPaths(cwd: string, paths: string[] | undefined): string[] | undefined {
	return paths?.map((value) => (isLocalPath(value) ? resolvePath(value, cwd) : value));
}
