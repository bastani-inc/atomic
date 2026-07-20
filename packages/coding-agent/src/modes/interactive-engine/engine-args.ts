import type { Args } from "../../cli/args.ts";
import type { SessionManager } from "../../core/session-manager.ts";

export interface InteractiveEngineResourcePaths {
	extensions?: readonly string[];
	promptTemplates?: readonly string[];
	skills?: readonly string[];
	themes?: readonly string[];
}

function appendValue(args: string[], flag: string, value: boolean | number | string | undefined): void {
	if (value === undefined || value === false) return;
	args.push(flag);
	if (value !== true) args.push(String(value));
}

function appendValues(args: string[], flag: string, values: readonly string[] | undefined): void {
	for (const value of values ?? []) args.push(flag, value);
}

export function buildInteractiveEngineArgs(
	parsed: Args,
	sessionManager: SessionManager,
	resources: InteractiveEngineResourcePaths,
): string[] {
	const args: string[] = [];
	const sessionFile = sessionManager.getSessionFile();
	if (parsed.noSession || !sessionFile) args.push("--no-session");
	else args.push("--session", sessionFile);
	appendValue(args, "--session-dir", parsed.sessionDir);
	appendValue(args, "--provider", parsed.provider);
	appendValue(args, "--model", parsed.model);
	appendValue(args, "--thinking", parsed.thinking);
	appendValue(args, "--context-window", parsed.contextWindow);
	appendValue(args, "--system-prompt", parsed.systemPrompt);
	appendValues(args, "--append-system-prompt", parsed.appendSystemPrompt);
	if (parsed.models) appendValue(args, "--models", parsed.models.join(","));
	if (parsed.tools) appendValue(args, "--tools", parsed.tools.join(","));
	if (parsed.excludeTools) appendValue(args, "--exclude-tools", parsed.excludeTools.join(","));
	appendValue(args, "--no-tools", parsed.noTools);
	appendValue(args, "--no-builtin-tools", parsed.noBuiltinTools);
	appendValues(args, "--extension", resources.extensions);
	appendValue(args, "--no-extensions", parsed.noExtensions);
	appendValues(args, "--skill", resources.skills);
	appendValue(args, "--no-skills", parsed.noSkills);
	appendValues(args, "--prompt-template", resources.promptTemplates);
	appendValue(args, "--no-prompt-templates", parsed.noPromptTemplates);
	appendValues(args, "--theme", resources.themes);
	appendValue(args, "--no-themes", parsed.noThemes);
	appendValue(args, "--no-context-files", parsed.noContextFiles);
	appendValue(args, "--offline", parsed.offline);
	appendValue(args, "--verbose", parsed.verbose);
	if (parsed.projectTrustOverride !== undefined) {
		args.push(parsed.projectTrustOverride ? "--approve" : "--no-approve");
	}
	for (const [name, value] of parsed.unknownFlags) {
		args.push(`--${name}`);
		if (value !== true) args.push(String(value));
	}
	return args;
}
