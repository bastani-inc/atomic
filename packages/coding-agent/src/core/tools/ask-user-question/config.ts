import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { stripBom } from "../../../utils/text.ts";

const CONFIG_DIR = join(homedir(), ".config", "rpiv-ask-user-question");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

interface GuidanceFields {
	promptSnippet?: string;
	promptGuidelines?: string[];
}

export interface AskUserQuestionConfig {
	guidance?: GuidanceFields;
}

let loaded: AskUserQuestionConfig | undefined;
let reading: Promise<AskUserQuestionConfig> | undefined;

/** Reads the config file again without blocking; {@link loadConfig} serves what it read. */
export function refreshConfig(): Promise<AskUserQuestionConfig> {
	reading ??= readConfig().then((config) => {
		loaded = config;
		reading = undefined;
		return config;
	});
	return reading;
}

/**
 * The config as last read, served from memory so a tool definition is created without file I/O once a read has finished;
 * a call before any read reads the file. Each later call refreshes it in the background, so an edited file applies to the
 * definitions created after that read.
 */
export function loadConfig(): AskUserQuestionConfig {
	if (loaded === undefined) {
		loaded = readConfigSync();
		return loaded;
	}
	void refreshConfig();
	return loaded;
}

export function loadedConfig(): AskUserQuestionConfig {
	void refreshConfig();
	return loaded ?? {};
}

function readConfigSync(): AskUserQuestionConfig {
	let text: string;
	try {
		text = readFileSync(CONFIG_PATH, "utf-8");
	} catch {
		return {};
	}
	return parseConfig(text);
}

async function readConfig(): Promise<AskUserQuestionConfig> {
	let text: string;
	try {
		text = await readFile(CONFIG_PATH, "utf-8");
	} catch {
		return {};
	}
	return parseConfig(text);
}

function parseConfig(text: string): AskUserQuestionConfig {
	try {
		const parsed = JSON.parse(stripBom(text)) as unknown;
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
