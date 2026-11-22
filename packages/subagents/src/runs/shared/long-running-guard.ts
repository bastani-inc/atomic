import { isJsWhitespace, skipHorizontalWhitespaceLines } from "../../shared/prompt-text.js";
import type { ResolvedControlConfig } from "../../shared/types.js";
import { progressAwareThreshold } from "./progress-trend.js";

interface LongRunningNoticeMetrics {
	startedAt: number;
	now: number;
	turns: number;
	tokens: number;
}

type LongRunningTriggerReason = "time_threshold" | "turn_threshold" | "token_threshold";

interface FailedMutatingAttempt {
	tool: string;
	path?: string;
	error: string;
	ts: number;
}

interface MutatingFailureState {
	consecutiveFailures: number;
	lastFailureAt?: number;
	recentFailures: FailedMutatingAttempt[];
	lastMutatingPath?: string;
	repeatedPathFailures: number;
}

const MUTATING_BASH_PATTERNS = [
	/(^|[;&|()\s])rm\s+/,
	/(^|[;&|()\s])mv\s+/,
	/(^|[;&|()\s])cp\s+/,
	/(^|[;&|()\s])mkdir\s+/,
	/(^|[;&|()\s])touch\s+/,
	/(^|[;&|()\s])git\s+apply\b/,
	/(^|[;&|()\s])patch\s+/,
	/\b(writeFile|writeFileSync|appendFile|appendFileSync)\b/,
	/\bwrite_text\s*\(/,
];

function isCommandBoundaryChar(code: number): boolean {
	return code === 0x3b || code === 0x26 || code === 0x7c || code === 0x28 || code === 0x29 || isJsWhitespace(code);
}

function isWordChar(code: number): boolean {
	return (
		(code >= 0x30 && code <= 0x39) ||
		(code >= 0x41 && code <= 0x5a) ||
		(code >= 0x61 && code <= 0x7a) ||
		code === 0x5f
	);
}

function matchesFlagWordAt(command: string, flag: string, offset: number): boolean {
	if (!command.startsWith(flag, offset)) return false;
	const after = offset + flag.length;
	return after >= command.length || !isWordChar(command.charCodeAt(after));
}

function hasInPlaceCommandFlag(command: string, cmd: string, flag: string): boolean {
	let searchFrom = 0;
	let checkedEnd = 0;
	while (searchFrom < command.length) {
		const pos = command.indexOf(cmd, searchFrom);
		if (pos === -1) return false;
		const afterCmd = pos + cmd.length;
		if (
			(pos > 0 && !isCommandBoundaryChar(command.charCodeAt(pos - 1))) ||
			afterCmd >= command.length ||
			!isJsWhitespace(command.charCodeAt(afterCmd))
		) {
			searchFrom = pos + 1;
			continue;
		}
		const afterWs = afterCmd + 1;
		const i = skipHorizontalWhitespaceLines(command, afterWs);
		if (i > afterWs && matchesFlagWordAt(command, flag, i)) {
			return true;
		}
		if (i >= command.length) return false;
		if (i < checkedEnd) {
			searchFrom = i;
			continue;
		}
		let k = i;
		while (k < command.length) {
			const code = command.charCodeAt(k);
			if (code === 0x0a) {
				if (matchesFlagWordAt(command, flag, k + 1)) return true;
				break;
			}
			if (code === 0x3b || code === 0x26 || code === 0x7c) {
				break;
			}
			if (isJsWhitespace(code) && matchesFlagWordAt(command, flag, k + 1)) {
				return true;
			}
			k++;
		}
		checkedEnd = k;
		searchFrom = i;
	}
	return false;
}

function hasTeeCommand(command: string): boolean {
	let searchFrom = 0;
	while (searchFrom < command.length) {
		const pos = command.indexOf("tee", searchFrom);
		if (pos === -1) return false;
		const after = pos + 3;
		if (after + 1 < command.length && isJsWhitespace(command.charCodeAt(after))) {
			const nextCode = command.charCodeAt(after + 1);
			if (nextCode !== 0x7c && nextCode !== 0x26 && nextCode !== 0x3b) {
				let k = pos - 1;
				while (k >= 0 && isJsWhitespace(command.charCodeAt(k))) {
					if (command.charCodeAt(k) === 0x0a) return true;
					k--;
				}
				if (k < 0) return true;
				const prev = command.charCodeAt(k);
				if (prev === 0x3b || prev === 0x26 || prev === 0x7c || prev === 0x28 || prev === 0x29) {
					return true;
				}
			}
		}
		searchFrom = pos + 1;
	}
	return false;
}

function hasOpenWriteMode(command: string): boolean {
	let searchFrom = 0;
	while (searchFrom < command.length) {
		const pos = command.indexOf("open", searchFrom);
		if (pos === -1) return false;
		if (pos > 0 && isWordChar(command.charCodeAt(pos - 1))) {
			searchFrom = pos + 1;
			continue;
		}
		let paren = pos + 4;
		while (paren < command.length && isJsWhitespace(command.charCodeAt(paren))) {
			paren++;
		}
		if (paren >= command.length || command.charCodeAt(paren) !== 0x28) {
			searchFrom = Math.max(pos + 1, paren);
			continue;
		}
		let j = paren + 1;
		while (j < command.length) {
			const code = command.charCodeAt(j);
			if (code === 0x29) break;
			if (code === 0x2c) {
				let ws = j + 1;
				while (ws < command.length && isJsWhitespace(command.charCodeAt(ws))) {
					ws++;
				}
				if (ws + 1 < command.length) {
					const quote = command.charCodeAt(ws);
					const mode = command.charCodeAt(ws + 1);
					if ((quote === 0x22 || quote === 0x27) && (mode === 0x77 || mode === 0x61)) {
						return true;
					}
				}
				j = ws;
				continue;
			}
			j++;
		}
		if (j >= command.length) return false;
		searchFrom = j + 1;
	}
	return false;
}

const MUTATING_FAILURE_HINTS = [
	"failed",
	"error",
	"no exact match",
	"did not match",
	"malformed",
	"rejected",
	"unable",
	"cannot",
	"could not",
];

export function resolveCurrentPath(
	toolName: string | undefined,
	args: Record<string, unknown> | undefined,
): string | undefined {
	if (!toolName || !args) return undefined;
	const direct = ["path", "file", "filename", "target", "cwd"];
	for (const key of direct) {
		const value = args[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	if (toolName === "bash") {
		const command = typeof args.command === "string" ? args.command : undefined;
		if (!command) return undefined;
		const redirect = command.match(/(?:>|>>|tee\s+)(\S+)/);
		if (redirect?.[1]) return redirect[1];
	}
	return undefined;
}

function hasUnquotedFileRedirection(command: string): boolean {
	let inSingle = false;
	let inDouble = false;
	for (let i = 0; i < command.length; i++) {
		const char = command[i]!;
		if (char === "'" && !inDouble) {
			inSingle = !inSingle;
			continue;
		}
		if (char === '"' && !inSingle) {
			inDouble = !inDouble;
			continue;
		}
		if (inSingle || inDouble) continue;
		if (char !== ">") continue;
		if (command[i - 1] === "-") continue;
		const isDouble = command[i + 1] === ">";
		let cursor = i + (isDouble ? 2 : 1);
		while (cursor < command.length && /\s/.test(command[cursor]!)) cursor++;
		if (cursor >= command.length) continue;
		const targetStart = command[cursor]!;
		if (targetStart === "&" || targetStart === "|" || targetStart === ";") continue;
		if (targetStart === "(" || targetStart === ")") continue;
		return true;
	}
	return false;
}

export function isMutatingBashCommand(command: string): boolean {
	return (
		hasUnquotedFileRedirection(command) ||
		hasInPlaceCommandFlag(command, "sed", "-i") ||
		hasInPlaceCommandFlag(command, "perl", "-pi") ||
		hasTeeCommand(command) ||
		hasOpenWriteMode(command) ||
		MUTATING_BASH_PATTERNS.some((pattern) => pattern.test(command))
	);
}

export function isMutatingTool(toolName: string | undefined, args: Record<string, unknown> | undefined): boolean {
	if (!toolName) return false;
	if (toolName === "edit" || toolName === "write") return true;
	if (toolName !== "bash") return false;
	const command = typeof args?.command === "string" ? args.command : "";
	if (!command.trim()) return false;
	return isMutatingBashCommand(command);
}

export function didMutatingToolFail(text: string): boolean {
	const lowered = text.toLowerCase();
	return MUTATING_FAILURE_HINTS.some((hint) => lowered.includes(hint));
}

export function nextLongRunningTrigger(
	config: ResolvedControlConfig,
	metrics: LongRunningNoticeMetrics,
): LongRunningTriggerReason | undefined {
	const activeNoticeAfterMs = progressAwareThreshold(config.activeNoticeAfterMs, config.progressScores);
	if (metrics.now - metrics.startedAt >= activeNoticeAfterMs) return "time_threshold";
	if (config.activeNoticeAfterTurns !== undefined && metrics.turns >= config.activeNoticeAfterTurns)
		return "turn_threshold";
	if (config.activeNoticeAfterTokens !== undefined && metrics.tokens >= config.activeNoticeAfterTokens)
		return "token_threshold";
	return undefined;
}

export function resetMutatingFailureState(state: MutatingFailureState): void {
	state.consecutiveFailures = 0;
	state.lastFailureAt = undefined;
	state.recentFailures = [];
	state.lastMutatingPath = undefined;
	state.repeatedPathFailures = 0;
}

export function createMutatingFailureState(): MutatingFailureState {
	return {
		consecutiveFailures: 0,
		recentFailures: [],
		repeatedPathFailures: 0,
	};
}

export function recordMutatingFailure(
	state: MutatingFailureState,
	input: FailedMutatingAttempt,
	windowMs: number,
): void {
	if (state.lastFailureAt === undefined || input.ts - state.lastFailureAt > windowMs) {
		state.consecutiveFailures = 0;
		state.recentFailures = [];
		state.repeatedPathFailures = 0;
		state.lastMutatingPath = undefined;
	}
	state.lastFailureAt = input.ts;
	state.consecutiveFailures += 1;
	if (input.path && state.lastMutatingPath === input.path) {
		state.repeatedPathFailures += 1;
	} else if (input.path) {
		state.lastMutatingPath = input.path;
		state.repeatedPathFailures = 1;
	}
	state.recentFailures.push(input);
	if (state.recentFailures.length > 3) state.recentFailures.shift();
}

export function shouldEscalateMutatingFailures(state: MutatingFailureState, threshold: number): boolean {
	return state.consecutiveFailures >= threshold || state.repeatedPathFailures >= threshold;
}

export function summarizeRecentMutatingFailures(state: MutatingFailureState): string | undefined {
	if (state.recentFailures.length === 0) return undefined;
	return state.recentFailures
		.map((entry) => `${entry.tool}${entry.path ? `(${entry.path})` : ""}: ${entry.error}`)
		.join(" | ");
}
