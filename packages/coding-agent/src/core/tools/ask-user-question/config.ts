import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { stripBom } from "../../../utils/text.ts";

const CONFIG_DIR = join(homedir(), ".config", "rpiv-ask-user-question");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

interface GuidanceFields {
	promptSnippet?: string;
	promptGuidelines?: string[];
}

interface AskUserQuestionConfig {
	guidance?: GuidanceFields;
}

export function loadConfig(): AskUserQuestionConfig {
	if (!existsSync(CONFIG_PATH)) return {};
	try {
		const parsed = JSON.parse(stripBom(readFileSync(CONFIG_PATH, "utf-8"))) as unknown;
		if (parsed === null || typeof parsed !== "object") return {};
		return parsed as AskUserQuestionConfig;
	} catch {
		return {};
	}
}

export function validateGuidanceFields(fields: unknown): GuidanceFields {
	if (!fields || typeof fields !== "object") return {};
	const g = fields as Record<string, unknown>;
	const result: GuidanceFields = {};
	if (typeof g.promptSnippet === "string" && g.promptSnippet.length > 0) {
		result.promptSnippet = g.promptSnippet;
	}
	if (
		Array.isArray(g.promptGuidelines) &&
		g.promptGuidelines.length > 0 &&
		g.promptGuidelines.every((s) => typeof s === "string" && s.length > 0)
	) {
		result.promptGuidelines = g.promptGuidelines;
	}
	return result;
}
