import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join, posix, win32 } from "node:path";
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
	return aggregateUsageRollups(results, (result) => usageRollupFromResult(result, options));
}

export function usageFromModelAttempts(results: readonly { sessionFile?: string; usage?: Usage; modelAttempts?: readonly ModelAttempt[] }[]): AtomicUsage {
	return usageRollupFromModelAttempts(results).usage;
}

export function usageRollupFromModelAttempts(results: readonly { sessionFile?: string; usage?: Usage; modelAttempts?: readonly ModelAttempt[] }[]): RollupUsage {
	return aggregateUsageRollups(results, usageRollupFromAttemptBackedResult);
}

function aggregateUsageRollups<T extends { sessionFile?: string }>(results: readonly T[], rollupFor: (result: T) => RollupUsage): RollupUsage {
	const grouped = new Map<string, RollupUsage>();
	const ungrouped: RollupUsage[] = [];
	for (const result of results) {
		const rollup = rollupFor(result);
		if (!result.sessionFile) {
			ungrouped.push(rollup);
			continue;
		}
		const key = normalizedPathKey(result.sessionFile);
		const previous = grouped.get(key);
		if (!previous) {
			grouped.set(key, rollup);
			continue;
		}
		const usage = maxAtomicUsage(previous.usage, rollup.usage);
		const sessionFiles = [...new Map([...previous.sessionFiles, ...rollup.sessionFiles].map((file) => [normalizedPathKey(file), file])).values()];
		grouped.set(key, {
			usage,
			complete: previous.complete && rollup.complete && sameAtomicUsage(usage, previous.usage) && sameAtomicUsage(usage, rollup.usage),
			sessionFiles,
		});
	}
	let usage = emptyAtomicUsage();
	let complete = true;
	const sessionFiles: string[] = [];
	for (const rollup of [...grouped.values(), ...ungrouped]) {
		usage = addAtomicUsage(usage, rollup.usage);
		complete = complete && rollup.complete;
		sessionFiles.push(...rollup.sessionFiles);
	}
	return { usage, complete, sessionFiles };
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

export function rememberAsyncRootSession(roots: Map<string, string> | undefined, rootSessionId: string | null | undefined, payload: { id?: unknown }): void {
	if (roots && rootSessionId && typeof payload.id === "string") roots.set(payload.id, rootSessionId);
}

export function consumeAsyncRootSession(roots: Map<string, string> | undefined, currentRootSessionId: string | null | undefined, details: { runId?: unknown }): string | null | undefined {
	if (!roots || typeof details.runId !== "string") return currentRootSessionId;
	const rootSessionId = roots.get(details.runId) ?? currentRootSessionId;
	roots.delete(details.runId);
	return rootSessionId;
}

function usageRollupFromResult(result: SingleResult, options: UsageRollupOptions): RollupUsage {
	const fileUsage = usageFromSessionTree(result.sessionFile);
	const scalarUsage = scalarUsageToAtomic(result.usage);
	if (options.live) {
		return {
			usage: fileUsage ? maxAtomicUsage(scalarUsage, fileUsage.usage) : scalarUsage,
			complete: false,
			sessionFiles: fileUsage?.sessionFiles ?? (result.sessionFile ? [result.sessionFile] : []),
		};
	}
	if (fileUsage) return usageRollupWithScalarFloor(fileUsage, scalarUsage);
	return { usage: scalarUsage, complete: false, sessionFiles: result.sessionFile ? [result.sessionFile] : [] };
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

function usageRollupWithScalarFloor(fileUsage: RollupUsage, scalarUsage: AtomicUsage): RollupUsage {
	const usage = maxAtomicUsage(fileUsage.usage, scalarUsage);
	return { ...fileUsage, usage, complete: fileUsage.complete && sameAtomicUsage(usage, fileUsage.usage) };
}

function sameAtomicUsage(left: AtomicUsage, right: AtomicUsage): boolean {
	return left.input === right.input && left.output === right.output &&
		left.cacheRead === right.cacheRead && left.cacheWrite === right.cacheWrite &&
		left.totalTokens === right.totalTokens && left.cost.input === right.cost.input &&
		left.cost.output === right.cost.output && left.cost.cacheRead === right.cost.cacheRead &&
		left.cost.cacheWrite === right.cost.cacheWrite && left.cost.total === right.cost.total;
}

function usageRollupFromAttemptBackedResult(result: { sessionFile?: string; usage?: Usage; modelAttempts?: readonly ModelAttempt[] }): RollupUsage {
	const fileUsage = usageFromSessionTree(result.sessionFile);
	let scalarUsage = result.usage ? scalarUsageToAtomic(result.usage) : emptyAtomicUsage();
	if (!result.usage) {
		for (const attempt of result.modelAttempts ?? []) {
			if (attempt.usage) scalarUsage = addAtomicUsage(scalarUsage, scalarUsageToAtomic(attempt.usage));
		}
	}
	if (fileUsage) return usageRollupWithScalarFloor(fileUsage, scalarUsage);
	return { usage: scalarUsage, complete: false, sessionFiles: result.sessionFile ? [result.sessionFile] : [] };
}

function usageFromSessionTree(sessionFile: string | undefined): RollupUsage | undefined {
	if (!sessionFile || !existsSync(sessionFile)) return undefined;
	try {
		let total = emptyAtomicUsage();
		let complete = true;
		const entriesByFile = new Map<string, Record<string, unknown>[]>();
		for (const file of [sessionFile, ...discoverNestedSessionFiles(sessionFile)]) {
			if (entriesByFile.has(file)) continue;
			const parsed = readJsonlEntries(file);
			const filtered = entriesExcludingInheritedParent(parsed.entries);
			if (!parsed.complete || !filtered.complete) complete = false;
			entriesByFile.set(file, filtered.entries);
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

interface ParsedJsonlEntries {
	entries: Record<string, unknown>[];
	complete: boolean;
}

function readJsonlEntries(file: string): ParsedJsonlEntries {
	let complete = true;
	const entries = readFileSync(file, "utf8")
		.split(/\r?\n/)
		.flatMap((line) => {
			if (!line.trim()) return [];
			try {
				return [JSON.parse(line) as Record<string, unknown>];
			} catch {
				complete = false;
				return [];
			}
		});
	return { entries, complete };
}

function entriesExcludingInheritedParent(entries: readonly Record<string, unknown>[]): ParsedJsonlEntries {
	const header = entries.find((entry) => entry["type"] === "session") as { parentSession?: unknown } | undefined;
	const parentSession = typeof header?.parentSession === "string" ? header.parentSession : undefined;
	if (!parentSession) return { entries: [...entries], complete: true };
	if (!existsSync(parentSession)) return { entries: [], complete: false };
	try {
		const parent = readJsonlEntries(parentSession);
		if (!parent.complete || parent.entries.length === 0) return { entries: [], complete: false };
		const parentIds = new Set(parent.entries.map((entry) => entry["id"]));
		return { entries: entries.filter((entry) => !parentIds.has(entry["id"])), complete: true };
	} catch {
		return { entries: [], complete: false };
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
	coveredFiles.add(normalizedPathKey(sessionFile));
	coveredSubtrees.push(sessionSubtreeRoot(sessionFile));
}

function isCovered(path: string, coveredFiles: Set<string>, coveredSubtrees: readonly string[]): boolean {
	const candidate = normalizedPathKey(path);
	if (coveredFiles.has(candidate)) return true;
	return coveredSubtrees.some((root) => isSameOrDescendant(root, candidate));
}

function pathApi(value: string): typeof posix | typeof win32 {
	return /^[A-Za-z]:[\\/]/.test(value) || value.includes("\\") ? win32 : posix;
}

function normalizedPathKey(path: string): string {
	const api = pathApi(path);
	const normalized = api.normalize(path);
	return api === win32 ? normalized.toLowerCase() : normalized;
}

function sessionSubtreeRoot(sessionFile: string): string {
	const api = pathApi(sessionFile);
	return normalizedPathKey(api.join(api.dirname(sessionFile), api.basename(sessionFile, api.extname(sessionFile))));
}

function isSameOrDescendant(root: string, candidate: string): boolean {
	const api = pathApi(root);
	const relativePath = api.relative(root, candidate);
	return relativePath === "" || (relativePath !== ".." && !relativePath.startsWith(`..${api.sep}`) && !api.isAbsolute(relativePath));
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
