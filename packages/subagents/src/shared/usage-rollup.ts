import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@bastani/atomic";
import type { Details, ModelAttempt, SingleResult, Usage } from "./types-results.ts";

export const USAGE_DESCENDANT_ROLLUP_CHANNEL = "usage:descendant-rollup";

export interface AtomicUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

export interface DescendantUsageReport {
	rootSessionId: string;
	childRunId: string;
	kind: "subagent" | "workflow-stage" | "workflow-run";
	usage: AtomicUsage;
	settled: boolean;
	label?: string;
	sessionFile?: string;
	sessionFiles?: string[];
}

export interface RollupUsage {
	usage: AtomicUsage;
	complete: boolean;
	sessionFiles: string[];
}

interface UsageRollupOptions {
	live?: boolean;
}
export function emptyAtomicUsage(): AtomicUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

function finiteNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function usageCostTotal(cost: unknown): number {
	if (typeof cost === "number") return finiteNumber(cost);
	if (typeof cost !== "object" || cost === null) return 0;
	const fields = cost as { input?: unknown; output?: unknown; cacheRead?: unknown; cacheWrite?: unknown; total?: unknown };
	const total = finiteNumber(fields.total);
	if (total > 0) return total;
	return finiteNumber(fields.input) + finiteNumber(fields.output) + finiteNumber(fields.cacheRead) + finiteNumber(fields.cacheWrite);
}

export function scalarUsageToAtomic(usage: Usage): AtomicUsage {
	const input = finiteNumber(usage.input);
	const output = finiteNumber(usage.output);
	const cacheRead = finiteNumber(usage.cacheRead);
	const cacheWrite = finiteNumber(usage.cacheWrite);
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: usageCostTotal(usage.cost) },
	};
}

export function addAtomicUsage(left: AtomicUsage, right: AtomicUsage): AtomicUsage {
	return {
		input: left.input + right.input,
		output: left.output + right.output,
		cacheRead: left.cacheRead + right.cacheRead,
		cacheWrite: left.cacheWrite + right.cacheWrite,
		totalTokens: left.totalTokens + right.totalTokens,
		cost: {
			input: left.cost.input + right.cost.input,
			output: left.cost.output + right.cost.output,
			cacheRead: left.cost.cacheRead + right.cost.cacheRead,
			cacheWrite: left.cost.cacheWrite + right.cost.cacheWrite,
			total: left.cost.total + right.cost.total,
		},
	};
}

export function usageFromResults(results: readonly SingleResult[]): AtomicUsage {
	return usageRollupFromResults(results).usage;
}

export function usageRollupFromResults(results: readonly SingleResult[], options: UsageRollupOptions = {}): RollupUsage {
	let total = emptyAtomicUsage();
	let complete = true;
	const sessionFiles: string[] = [];
	for (const result of results) {
		const rollup = usageRollupFromResult(result, options);
		total = addAtomicUsage(total, rollup.usage);
		if (!rollup.complete) complete = false;
		sessionFiles.push(...rollup.sessionFiles);
	}
	return { usage: total, complete, sessionFiles };
}

export function usageFromModelAttempts(results: readonly { sessionFile?: string; usage?: Usage; modelAttempts?: readonly ModelAttempt[] }[]): AtomicUsage {
	return usageRollupFromModelAttempts(results).usage;
}

export function usageRollupFromModelAttempts(results: readonly { sessionFile?: string; usage?: Usage; modelAttempts?: readonly ModelAttempt[] }[]): RollupUsage {
	let total = emptyAtomicUsage();
	let complete = true;
	const sessionFiles: string[] = [];
	for (const result of results) {
		const rollup = usageRollupFromAttemptBackedResult(result);
		total = addAtomicUsage(total, rollup.usage);
		if (!rollup.complete) complete = false;
		sessionFiles.push(...rollup.sessionFiles);
	}
	return { usage: total, complete, sessionFiles };
}

export function attachTransitiveUsage<T extends Details>(details: T, options: UsageRollupOptions = {}): T {
	if (details.results.length > 0) {
		const rollup = usageRollupFromResults(details.results, options);
		details.transitiveUsage = rollup.usage;
		details.transitiveUsageComplete = rollup.complete;
		details.transitiveUsageSessionFiles = rollup.sessionFiles;
	}
	return details;
}

export function liveSubagentDetails(partialResult: unknown): Details | undefined {
	if (typeof partialResult !== "object" || partialResult === null) return undefined;
	const details = (partialResult as { details?: unknown }).details;
	if (typeof details !== "object" || details === null) return undefined;
	const candidate = details as Details;
	if (!candidate.runId || !Array.isArray(candidate.results) || candidate.results.length === 0) return undefined;
	const withUsage = attachTransitiveUsage({ ...candidate, results: candidate.results }, { live: true });
	if (!withUsage.transitiveUsage) return undefined;
	return { ...withUsage, transitiveUsageComplete: false };
}

export function reportSubagentUsage(pi: ExtensionAPI, ctx: ExtensionContext, details: Details): void {
	reportSubagentUsageForRoot(pi, ctx.sessionManager.getSessionId(), details);
}

export function reportSubagentUsageForRoot(pi: ExtensionAPI, rootSessionId: string | null | undefined, details: Details): void {
	if (!rootSessionId || !details.runId || !details.transitiveUsage) return;
	const sessionFiles = details.transitiveUsageSessionFiles?.length
		? details.transitiveUsageSessionFiles
		: details.results.flatMap((result) => result.sessionFile ? [result.sessionFile] : []);
	const state = (details as Details & { state?: string }).state;
	pi.events.emit(USAGE_DESCENDANT_ROLLUP_CHANNEL, {
		rootSessionId,
		childRunId: details.runId,
		kind: "subagent",
		usage: details.transitiveUsage,
		settled: details.transitiveUsageComplete !== false && state !== "paused",
		label: details.mode === "management" ? "subagent" : details.mode,
		sessionFile: sessionFiles[0],
		sessionFiles,
	} satisfies DescendantUsageReport);
}

export function reportSubagentStarted(pi: ExtensionAPI, rootSessionId: string | null | undefined, payload: { id?: unknown; asyncDir?: unknown }): void {
	if (!rootSessionId || typeof payload.id !== "string") return;
	pi.events.emit(USAGE_DESCENDANT_ROLLUP_CHANNEL, {
		rootSessionId,
		childRunId: payload.id,
		kind: "subagent",
		usage: emptyAtomicUsage(),
		settled: false,
		label: "async",
	} satisfies DescendantUsageReport);
}

function usageRollupFromResult(result: SingleResult, options: UsageRollupOptions): RollupUsage {
	const fileUsage = usageFromSessionTree(result.sessionFile);
	if (options.live) {
		const scalarUsage = scalarUsageToAtomic(result.usage);
		return {
			usage: fileUsage ? maxAtomicUsage(scalarUsage, fileUsage.usage) : scalarUsage,
			complete: false,
			sessionFiles: fileUsage?.sessionFiles ?? (result.sessionFile ? [result.sessionFile] : []),
		};
	}
	if (fileUsage) return fileUsage;
	return { usage: scalarUsageToAtomic(result.usage), complete: false, sessionFiles: result.sessionFile ? [result.sessionFile] : [] };
}

function maxAtomicUsage(left: AtomicUsage, right: AtomicUsage): AtomicUsage {
	return {
		input: Math.max(left.input, right.input),
		output: Math.max(left.output, right.output),
		cacheRead: Math.max(left.cacheRead, right.cacheRead),
		cacheWrite: Math.max(left.cacheWrite, right.cacheWrite),
		totalTokens: Math.max(left.totalTokens, right.totalTokens),
		cost: {
			input: Math.max(left.cost.input, right.cost.input),
			output: Math.max(left.cost.output, right.cost.output),
			cacheRead: Math.max(left.cost.cacheRead, right.cost.cacheRead),
			cacheWrite: Math.max(left.cost.cacheWrite, right.cost.cacheWrite),
			total: Math.max(left.cost.total, right.cost.total),
		},
	};
}

function usageRollupFromAttemptBackedResult(result: { sessionFile?: string; usage?: Usage; modelAttempts?: readonly ModelAttempt[] }): RollupUsage {
	const fileUsage = usageFromSessionTree(result.sessionFile);
	if (fileUsage) return fileUsage;
	if (result.usage) return { usage: scalarUsageToAtomic(result.usage), complete: false, sessionFiles: result.sessionFile ? [result.sessionFile] : [] };
	let total = emptyAtomicUsage();
	for (const attempt of result.modelAttempts ?? []) {
		if (attempt.usage) total = addAtomicUsage(total, scalarUsageToAtomic(attempt.usage));
	}
	return { usage: total, complete: false, sessionFiles: result.sessionFile ? [result.sessionFile] : [] };
}

function usageFromSessionTree(sessionFile: string | undefined): RollupUsage | undefined {
	if (!sessionFile || !existsSync(sessionFile)) return undefined;
	try {
		let total = emptyAtomicUsage();
		let complete = true;
		const entriesByFile = new Map<string, Record<string, unknown>[]>();
		for (const file of [sessionFile, ...discoverNestedSessionFiles(sessionFile)]) {
			if (entriesByFile.has(file)) continue;
			entriesByFile.set(file, entriesExcludingInheritedParent(readJsonlEntries(file)));
		}
		const coveredFiles = new Set<string>();
		const coveredSubtrees: string[] = [];
		for (const [file, entries] of entriesByFile) {
			if (isCovered(file, coveredFiles, coveredSubtrees)) continue;
			for (const stage of workflowStageUsagesFromEntries(entries)) {
				if (stage.sessionFile && isCovered(stage.sessionFile, coveredFiles, coveredSubtrees)) continue;
				total = addAtomicUsage(total, stage.usage);
				if (!stage.complete) complete = false;
				if (stage.sessionFile) addCoverage(stage.sessionFile, coveredFiles, coveredSubtrees);
			}
		}
		for (const [file, entries] of entriesByFile) {
			if (isCovered(file, coveredFiles, coveredSubtrees)) continue;
			if (entries.length > 0) total = addAtomicUsage(total, usageFromEntries(entries));
		}
		return { usage: total, complete, sessionFiles: [...entriesByFile.keys()] };
	} catch {
		return undefined;
	}
}

function discoverNestedSessionFiles(sessionFile: string): string[] {
	const rootDir = join(dirname(sessionFile), basename(sessionFile, extname(sessionFile)));
	if (!existsSync(rootDir)) return [];
	const files: string[] = [];
	const visit = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) visit(path);
			else if (entry.isFile() && entry.name.endsWith(".jsonl") && statSync(path).isFile()) files.push(path);
		}
	};
	visit(rootDir);
	return files;
}

function readJsonlEntries(file: string): Record<string, unknown>[] {
	return readFileSync(file, "utf8")
		.split(/\r?\n/)
		.flatMap((line) => {
			if (!line.trim()) return [];
			try {
				return [JSON.parse(line) as Record<string, unknown>];
			} catch {
				return [];
			}
		});
}

function entriesExcludingInheritedParent(entries: readonly Record<string, unknown>[]): Record<string, unknown>[] {
	const header = entries.find((entry) => entry["type"] === "session") as { parentSession?: unknown } | undefined;
	const parentSession = typeof header?.parentSession === "string" ? header.parentSession : undefined;
	if (!parentSession || !existsSync(parentSession)) return [...entries];
	try {
		const parentIds = new Set(readJsonlEntries(parentSession).map((entry) => entry["id"]));
		return entries.filter((entry) => !parentIds.has(entry["id"]));
	} catch {
		return [...entries];
	}
}
function usageFromEntries(entries: readonly Record<string, unknown>[]): AtomicUsage {
	let total = emptyAtomicUsage();
	for (const entry of entries) {
		if (entry["type"] !== "message") continue;
		const message = entry["message"] as { role?: unknown; usage?: unknown } | undefined;
		if (message?.role !== "assistant" || !isAtomicUsage(message.usage)) continue;
		total = addAtomicUsage(total, message.usage);
	}
	return total;
}

function workflowStageUsagesFromEntries(entries: readonly Record<string, unknown>[]): Array<{ usage: AtomicUsage; complete: boolean; sessionFile?: string }> {
	const usages: Array<{ usage: AtomicUsage; complete: boolean; sessionFile?: string }> = [];
	for (const entry of entries) {
		if (entry["type"] !== "custom" || entry["customType"] !== "workflow.stage.end") continue;
		const data = entry["data"] as { usage?: unknown; sessionFile?: unknown; usageComplete?: unknown; usageSettled?: unknown } | undefined;
		if (isAtomicUsage(data?.usage)) {
			usages.push({
				usage: data.usage,
				complete: usageCompleteFromData(data),
				...(typeof data.sessionFile === "string" ? { sessionFile: data.sessionFile } : {}),
			});
		}
	}
	return usages;
}

function addCoverage(sessionFile: string, coveredFiles: Set<string>, coveredSubtrees: string[]): void {
	coveredFiles.add(sessionFile);
	coveredSubtrees.push(join(dirname(sessionFile), basename(sessionFile, extname(sessionFile))));
}

function isCovered(path: string, coveredFiles: Set<string>, coveredSubtrees: readonly string[]): boolean {
	if (coveredFiles.has(path)) return true;
	return coveredSubtrees.some((root) => path === root || path.startsWith(`${root}/`));
}

function usageCompleteFromData(data: { usageComplete?: unknown; usageSettled?: unknown }): boolean {
	if (typeof data.usageComplete === "boolean") return data.usageComplete;
	if (typeof data.usageSettled === "boolean") return data.usageSettled;
	return true;
}
function isAtomicUsage(value: unknown): value is AtomicUsage {
	if (typeof value !== "object" || value === null) return false;
	const usage = value as Partial<AtomicUsage>;
	return typeof usage.input === "number" &&
		typeof usage.output === "number" &&
		typeof usage.cacheRead === "number" &&
		typeof usage.cacheWrite === "number" &&
		typeof usage.cost === "object" &&
		usage.cost !== null &&
		typeof usage.cost.total === "number";
}
