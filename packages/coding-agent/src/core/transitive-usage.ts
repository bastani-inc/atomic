import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import type { Usage } from "@earendil-works/pi-ai/compat";
import type { FileEntry, SessionInfo } from "./session-manager-types.ts";
import { loadEntriesFromFile } from "./session-manager-storage.ts";

export const USAGE_DESCENDANT_ROLLUP_CHANNEL = "usage:descendant-rollup";

export type DescendantUsageKind = "subagent" | "workflow-stage" | "workflow-run";

export interface DescendantUsageReport {
	rootSessionId: string;
	childRunId: string;
	kind: DescendantUsageKind;
	usage: Usage;
	settled: boolean;
	label?: string;
	sessionFile?: string;
	/** Additional session files covered by this rollup, used to alias live run-id reports to durable walk reports. */
	sessionFiles?: string[];
}

export interface DescendantUsageContribution extends DescendantUsageReport {}

export interface TransitiveUsage {
	self: Usage;
	descendants: Usage;
	total: Usage;
	complete: boolean;
	breakdown: DescendantUsageContribution[];
}

export interface TransitiveUsageReconcileOptions {
	/** Revision captured before an async persisted-session walk began. */
	startedAtRevision?: number;
}

export function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function finiteNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function usageCost(usage: Usage): Usage["cost"] {
	const input = finiteNumber(usage.cost?.input);
	const output = finiteNumber(usage.cost?.output);
	const cacheRead = finiteNumber(usage.cost?.cacheRead);
	const cacheWrite = finiteNumber(usage.cost?.cacheWrite);
	const total = finiteNumber(usage.cost?.total);
	return { input, output, cacheRead, cacheWrite, total: total > 0 ? total : input + output + cacheRead + cacheWrite };
}

export function addUsage(left: Usage, right: Usage): Usage {
	const leftCost = usageCost(left);
	const rightCost = usageCost(right);
	return {
		input: finiteNumber(left.input) + finiteNumber(right.input),
		output: finiteNumber(left.output) + finiteNumber(right.output),
		cacheRead: finiteNumber(left.cacheRead) + finiteNumber(right.cacheRead),
		cacheWrite: finiteNumber(left.cacheWrite) + finiteNumber(right.cacheWrite),
		totalTokens: totalTokens(left) + totalTokens(right),
		cost: {
			input: leftCost.input + rightCost.input,
			output: leftCost.output + rightCost.output,
			cacheRead: leftCost.cacheRead + rightCost.cacheRead,
			cacheWrite: leftCost.cacheWrite + rightCost.cacheWrite,
			total: leftCost.total + rightCost.total,
		},
	};
}

function maxUsage(left: Usage, right: Usage): Usage {
	const leftCost = usageCost(left);
	const rightCost = usageCost(right);
	return {
		input: Math.max(finiteNumber(left.input), finiteNumber(right.input)),
		output: Math.max(finiteNumber(left.output), finiteNumber(right.output)),
		cacheRead: Math.max(finiteNumber(left.cacheRead), finiteNumber(right.cacheRead)),
		cacheWrite: Math.max(finiteNumber(left.cacheWrite), finiteNumber(right.cacheWrite)),
		totalTokens: Math.max(totalTokens(left), totalTokens(right)),
		cost: {
			input: Math.max(leftCost.input, rightCost.input),
			output: Math.max(leftCost.output, rightCost.output),
			cacheRead: Math.max(leftCost.cacheRead, rightCost.cacheRead),
			cacheWrite: Math.max(leftCost.cacheWrite, rightCost.cacheWrite),
			total: Math.max(leftCost.total, rightCost.total),
		},
	};
}

function mergeStringArrays(left: readonly string[] | undefined, right: readonly string[] | undefined): string[] | undefined {
	const merged = [...(left ?? []), ...(right ?? [])];
	return merged.length === 0 ? undefined : [...new Set(merged)];
}

export function totalTokens(usage: Usage): number {
	return finiteNumber(usage.totalTokens) || finiteNumber(usage.input) + finiteNumber(usage.output) + finiteNumber(usage.cacheRead) + finiteNumber(usage.cacheWrite);
}
export function sumAssistantUsage(entries: readonly FileEntry[]): Usage {
	let usage = emptyUsage();
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		usage = addUsage(usage, entry.message.usage);
	}
	return usage;
}

function sameUsage(left: Usage, right: Usage): boolean {
	return left.input === right.input &&
		left.output === right.output &&
		left.cacheRead === right.cacheRead &&
		left.cacheWrite === right.cacheWrite &&
		totalTokens(left) === totalTokens(right) &&
		left.cost.input === right.cost.input &&
		left.cost.output === right.cost.output &&
		left.cost.cacheRead === right.cost.cacheRead &&
		left.cost.cacheWrite === right.cost.cacheWrite &&
		left.cost.total === right.cost.total;
}

function sameContribution(left: DescendantUsageContribution | undefined, right: DescendantUsageReport): boolean {
	if (!left) return false;
	return left.rootSessionId === right.rootSessionId &&
		left.childRunId === right.childRunId &&
		left.kind === right.kind &&
		left.settled === right.settled &&
		left.label === right.label &&
		left.sessionFile === right.sessionFile &&
		sameStringArray(left.sessionFiles, right.sessionFiles) &&
		sameUsage(left.usage, right.usage);
}

function sameStringArray(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
	if (left === undefined || right === undefined) return left === right;
	if (left.length !== right.length) return false;
	return left.every((value, index) => value === right[index]);
}

function sessionFileAliases(report: DescendantUsageReport): Set<string> {
	const aliases = [report.sessionFile, ...(report.sessionFiles ?? [])];
	return new Set(aliases.filter((value): value is string => typeof value === "string" && value.length > 0));
}

function sharesSessionFileAlias(left: DescendantUsageContribution, right: DescendantUsageReport): boolean {
	const aliases = sessionFileAliases(right);
	if (aliases.size === 0) return false;
	for (const alias of sessionFileAliases(left)) {
		if (aliases.has(alias)) return true;
	}
	return false;
}

export class TransitiveUsageAggregator {
	private readonly descendants = new Map<string, DescendantUsageContribution>();
	private readonly descendantRevisions = new Map<string, number>();
	private revision = 0;
	private walkComplete: boolean;
	constructor(
		private readonly rootSessionId: string,
		private readonly getSelfUsage: () => Usage,
		private readonly onMutation?: () => void,
		options: { initialComplete?: boolean } = {},
	) {
		this.walkComplete = options.initialComplete ?? true;
	}

	getRevision(): number {
		return this.revision;
	}

	getTransitiveUsage(): TransitiveUsage {
		const self = this.getSelfUsage();
		let descendants = emptyUsage();
		let complete = this.walkComplete;
		const breakdown = [...this.descendants.values()];
		for (const contribution of breakdown) {
			descendants = addUsage(descendants, contribution.usage);
			if (!contribution.settled) complete = false;
		}
		return { self, descendants, total: addUsage(self, descendants), complete, breakdown };
	}

	attributeDescendantUsage(report: DescendantUsageReport): boolean {
		if (report.rootSessionId !== this.rootSessionId) return false;
		const aliasKeysToDelete: string[] = [];
		for (const [key, contribution] of this.descendants) {
			if (key === report.childRunId || !sharesSessionFileAlias(contribution, report)) continue;
			aliasKeysToDelete.push(key);
		}
		const previous = this.descendants.get(report.childRunId);
		const nextReport = previous && !report.settled
			? { ...report, usage: maxUsage(previous.usage, report.usage), sessionFiles: mergeStringArrays(previous.sessionFiles, report.sessionFiles) }
			: report;
		const contributionChanged = !sameContribution(previous, nextReport);
		if (aliasKeysToDelete.length === 0 && !contributionChanged) return false;
		const nextRevision = ++this.revision;
		for (const key of aliasKeysToDelete) {
			this.descendants.delete(key);
			this.descendantRevisions.delete(key);
		}
		if (contributionChanged) {
			const sessionFiles = nextReport.sessionFiles ? [...nextReport.sessionFiles] : undefined;
			this.descendants.set(nextReport.childRunId, { ...nextReport, sessionFiles });
			this.descendantRevisions.set(nextReport.childRunId, nextRevision);
		}
		this.onMutation?.();
		return true;
	}
	reconcile(reports: DescendantUsageReport[], complete: boolean, options: TransitiveUsageReconcileOptions = {}): void {
		let metadataChanged = this.walkComplete !== complete;
		this.walkComplete = complete;
		const nextKeys = new Set(reports.map((report) => report.childRunId));
		if (complete) {
			for (const [key, contribution] of this.descendants) {
				if (nextKeys.has(key) || !contribution.settled) continue;
				const contributionRevision = this.descendantRevisions.get(key) ?? 0;
				if (options.startedAtRevision !== undefined && contributionRevision > options.startedAtRevision) continue;
				this.descendants.delete(key);
				this.descendantRevisions.delete(key);
				this.revision += 1;
				metadataChanged = true;
			}
		}
		for (const report of reports) {
			if (this.isStaleWalkReport(report, options.startedAtRevision)) continue;
			this.attributeDescendantUsage(report);
		}
		if (metadataChanged) this.onMutation?.();
	}

	private isStaleWalkReport(report: DescendantUsageReport, startedAtRevision: number | undefined): boolean {
		if (startedAtRevision === undefined) return false;
		for (const [key, contribution] of this.descendants) {
			if (key !== report.childRunId && !sharesSessionFileAlias(contribution, report)) continue;
			const contributionRevision = this.descendantRevisions.get(key) ?? 0;
			if (contributionRevision > startedAtRevision) return true;
		}
		return false;
	}

	markIncomplete(): void {
		if (!this.walkComplete) return;
		this.walkComplete = false;
		this.onMutation?.();
	}
}

export async function collectDescendantUsageReports(input: {
	root: SessionInfo;
	rootSessionId: string;
	listSessions: () => Promise<SessionInfo[]>;
}): Promise<{ reports: DescendantUsageReport[]; complete: boolean }> {
	let complete = true;
	let sessions: SessionInfo[] = [];
	try {
		sessions = await input.listSessions();
	} catch {
		complete = false;
	}
	const rootPath = input.root.path;
	const byPath = new Map(sessions.map((session) => [session.path, session]));
	const discoveredPaths = new Set<string>();
	const descendants = sessions.filter((session) => isDescendantOf(session, rootPath, byPath));
	for (const session of descendants) discoveredPaths.add(session.path);
	try {
		for (const path of discoverSubagentSessionFiles(rootPath)) discoveredPaths.add(path);
	} catch {
		complete = false;
	}
	const reportsByKey = new Map<string, DescendantUsageReport>();
	const coveredSubtrees: string[] = [];
	const coveredFiles = new Set<string>();
	for (const sessionPath of [rootPath, ...discoveredPaths]) {
		try {
			const entries = loadEntriesFromFile(sessionPath);
			if (entries.length === 0) {
				complete = false;
				continue;
			}
			const ownEntries = sessionPath === rootPath ? entries : entriesExcludingInheritedParent(entries);
			if (!isCovered(sessionPath, coveredFiles, coveredSubtrees)) {
				for (const report of workflowStageReportsFromEntries(ownEntries, input.rootSessionId)) {
					if (report.sessionFile && isCovered(report.sessionFile, coveredFiles, coveredSubtrees)) continue;
					reportsByKey.set(report.childRunId, report);
					if (report.sessionFile) addCoverage(report.sessionFile, coveredFiles, coveredSubtrees);
				}
			}
			if (sessionPath === rootPath || isCovered(sessionPath, coveredFiles, coveredSubtrees)) continue;
			const listed = byPath.get(sessionPath);
			const header = entries.find((entry) => entry.type === "session") as ({ id?: string; workflow?: { stageName?: string } } | undefined);
			const report = {
				rootSessionId: input.rootSessionId,
				childRunId: listed?.id ?? header?.id ?? sessionPath,
				kind: listed?.workflow || header?.workflow ? "workflow-stage" : "subagent",
				usage: sumAssistantUsage(ownEntries),
				settled: true,
				label: listed?.workflow?.stageName ?? header?.workflow?.stageName ?? listed?.name,
				sessionFile: sessionPath,
			} satisfies DescendantUsageReport;
			if (!reportsByKey.has(report.childRunId)) reportsByKey.set(report.childRunId, report);
		} catch {
			complete = false;
		}
	}
	return { reports: [...reportsByKey.values()], complete };
}

function workflowStageReportsFromEntries(entries: readonly FileEntry[], rootSessionId: string): DescendantUsageReport[] {
	const reports: DescendantUsageReport[] = [];
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== "workflow.stage.end") continue;
		const data = entry.data as { stageId?: unknown; sessionId?: unknown; sessionFile?: unknown; usage?: unknown; usageComplete?: unknown; usageSettled?: unknown } | undefined;
		if (!isUsage(data?.usage)) continue;
		const sessionId = typeof data?.sessionId === "string" ? data.sessionId : undefined;
		const stageId = typeof data?.stageId === "string" ? data.stageId : undefined;
		reports.push({
			rootSessionId,
			childRunId: sessionId ?? (stageId ? `workflow-stage:${stageId}` : entry.id),
			kind: "workflow-stage",
			usage: data.usage,
			settled: usageSettledFromData(data),
			label: stageId,
			sessionFile: typeof data?.sessionFile === "string" ? data.sessionFile : undefined,
		});
	}
	return reports;
}

function entriesExcludingInheritedParent(entries: readonly FileEntry[]): FileEntry[] {
	const header = entries.find((entry) => entry.type === "session") as ({ parentSession?: unknown } | undefined);
	const parentSession = typeof header?.parentSession === "string" ? header.parentSession : undefined;
	if (!parentSession || !existsSync(parentSession)) return [...entries];
	try {
		const parentIds = new Set(loadEntriesFromFile(parentSession).map((entry) => entry.id));
		return entries.filter((entry) => !parentIds.has(entry.id));
	} catch {
		return [...entries];
	}
}

function isUsage(value: unknown): value is Usage {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<Usage>;
	return typeof candidate.input === "number" &&
		typeof candidate.output === "number" &&
		typeof candidate.cacheRead === "number" &&
		typeof candidate.cacheWrite === "number" &&
		typeof candidate.cost === "object" &&
		candidate.cost !== null &&
		typeof candidate.cost.total === "number";
}

function discoverSubagentSessionFiles(rootPath: string): string[] {
	const rootDir = join(dirname(rootPath), basename(rootPath, extname(rootPath)));
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

function addCoverage(sessionFile: string, coveredFiles: Set<string>, coveredSubtrees: string[]): void {
	coveredFiles.add(sessionFile);
	coveredSubtrees.push(join(dirname(sessionFile), basename(sessionFile, extname(sessionFile))));
}

function isCovered(path: string, coveredFiles: Set<string>, coveredSubtrees: readonly string[]): boolean {
	if (coveredFiles.has(path)) return true;
	return coveredSubtrees.some((root) => path === root || path.startsWith(`${root}/`));
}

function usageSettledFromData(data: { usageComplete?: unknown; usageSettled?: unknown }): boolean {
	if (typeof data.usageComplete === "boolean") return data.usageComplete;
	if (typeof data.usageSettled === "boolean") return data.usageSettled;
	return true;
}
function isDescendantOf(session: SessionInfo, rootPath: string, byPath: Map<string, SessionInfo>): boolean {
	let parentPath = session.parentSessionPath;
	const seen = new Set<string>();
	while (parentPath) {
		if (parentPath === rootPath) return true;
		if (seen.has(parentPath)) return false;
		seen.add(parentPath);
		parentPath = byPath.get(parentPath)?.parentSessionPath;
	}
	return false;
}

