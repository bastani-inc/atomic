import * as fs from "node:fs";
import { createHash } from "node:crypto";
import * as path from "node:path";
import { buildCompletionKey, lookupSeenWithTtl, recordSeen } from "./completion-dedupe.js";
import { deliverClaimedCompletion, type CompletionClaimSnapshot } from "./completion-claims.js";
import { deliverLocalCompletionNotification } from "./completion-notification.js";
import { quarantineResultFile } from "./result-quarantine.js";
import {
	claimIdFromScheduleKey,
	claimPublicResult,
	claimScheduleKey,
	loadResultClaim,
	readClaimData,
	removeResultClaim,
	updateResultClaim,
	type FrozenCompletionEnvelope,
	type ResultClaimFs,
	type ResultFileClaim,
} from "./result-file-claims.js";
import { modernResultHasTerminalStatus, type ResultStatusFs } from "./result-status.js";
import {
	attachNestedChildrenToResultChildren,
	buildSubagentResultIntercomPayload,
	compactNestedResultChildren,
	deliverSubagentResultIntercomEvent,
	resolveSubagentResultStatus,
} from "../../intercom/result-intercom.js";
import { projectNestedRegistryForRoot } from "../shared/nested-events.js";
import { buildCompletionSignature, sanitizeNestedResultChildren, type ResultFileData } from "./result-watcher-data.js";
import type { IntercomEventBus, SubagentResultIntercomChild, SubagentState } from "../../shared/types.js";

export interface ResultProcessOutcome {
	status: "done" | "status-pending" | "delivery-retry" | "inactive";
	entry?: string;
}

export interface ResultProcessorFs extends ResultClaimFs, Partial<ResultStatusFs> {
	existsSync?: typeof fs.existsSync;
	unlinkSync?: typeof fs.unlinkSync;
	linkSync?: typeof fs.linkSync;
	copyFileSync?: typeof fs.copyFileSync;
	openSync?: typeof fs.openSync;
	readSync?: typeof fs.readSync;
	closeSync?: typeof fs.closeSync;
}

export interface ResultProcessorContext {
	pi: { events: IntercomEventBus };
	state: SubagentState;
	resultsDir: string;
	completionTtlMs: number;
	fsApi?: ResultProcessorFs;
	allowedStatusRoots?: string[];
	maxStatusBytes?: number;
	maxNoProgressFailures?: number;
	intercomTimeoutMs?: number | false;
	isActive: () => boolean;
	ownsResult: (data: ResultFileData) => boolean;
}

function statusFs(fsApi: ResultProcessorFs): ResultStatusFs {
	return {
		realpathSync: fsApi.realpathSync ?? fs.realpathSync,
		lstatSync: fsApi.lstatSync ?? fs.lstatSync,
		openSync: fsApi.openSync ?? fs.openSync,
		fstatSync: fsApi.fstatSync ?? fs.fstatSync,
		readSync: fsApi.readSync ?? fs.readSync,
		closeSync: fsApi.closeSync ?? fs.closeSync,
	};
}

function readPublic(resultsDir: string, file: string, fsApi: ResultProcessorFs): ResultFileData {
	return JSON.parse((fsApi.readFileSync ?? fs.readFileSync)(path.join(resultsDir, file), "utf-8")) as ResultFileData;
}

function markClaimState(claim: ResultFileClaim, value: CompletionClaimSnapshot, fsApi: ResultProcessorFs): void {
	updateResultClaim(claim, {
		intercomDelivered: value.intercomDelivered,
		localDelivered: value.localDelivered,
		noProgressFailures: value.noProgressFailures,
		envelope: value.envelope,
		...(value.terminalStatus === "delivered" ? { state: "delivered" as const } : {}),
		...(value.terminalStatus === "exhausted" ? { state: "undelivered" as const } : {}),
	}, fsApi);
}

function buildEnvelope(data: ResultFileData, resultPath: string, fsApi: ResultProcessorFs): FrozenCompletionEnvelope {
	const runId = data.runId ?? data.id ?? path.basename(resultPath, ".json");
	const explicitNested = data.nestedChildren !== undefined;
	let nestedChildren = compactNestedResultChildren(sanitizeNestedResultChildren(data.nestedChildren, resultPath, "nestedChildren"));
	if (!nestedChildren?.length && !explicitNested) nestedChildren = compactNestedResultChildren(projectNestedRegistryForRoot(runId)?.children);
	const hasResults = Array.isArray(data.results) && data.results.length > 0;
	const resultChildren = hasResults ? data.results! : [{ agent: data.agent, output: data.summary, success: data.success }];
	const normalized = attachNestedChildrenToResultChildren(runId, resultChildren.map((result = {}, index): SubagentResultIntercomChild => {
		const baseOutput = result.output ?? data.summary;
		const hasOutput = typeof baseOutput === "string" && baseOutput.trim().length > 0;
		const output = hasOutput ? baseOutput : "(no output)";
		const summary = result.success === false && result.error
			? `${result.error}${hasOutput ? `\n\nOutput:\n${baseOutput}` : ""}`
			: output;
		const sessionPath = result.sessionFile ?? (resultChildren.length === 1 ? data.sessionFile : undefined);
		const children = sanitizeNestedResultChildren(result.children, resultPath, `results[${index}].children`);
		return {
			agent: result.agent ?? data.agent ?? `step-${index + 1}`,
			status: resolveSubagentResultStatus({
				success: result.success,
				state: data.state === "paused" || typeof result.success !== "boolean" ? data.state : undefined,
			}),
			summary,
			index,
			artifactPath: result.artifactPaths?.outputPath,
			...(typeof sessionPath === "string" && (fsApi.existsSync ?? fs.existsSync)(sessionPath) ? { sessionPath } : {}),
			...(result.intercomTarget ? { intercomTarget: result.intercomTarget } : {}),
			...(children ? { children } : {}),
		};
	}), nestedChildren);
	const local: Record<string, unknown> = {
		...data,
		runId,
		...(nestedChildren?.length ? { nestedChildren } : {}),
		...(Array.isArray(data.results) ? {
			results: hasResults ? normalized.map((child, index) => ({
				...data.results![index], agent: child.agent, status: child.status, summary: child.summary,
				index: child.index, artifactPath: child.artifactPath, sessionPath: child.sessionPath, children: child.children,
			})) : [],
		} : {}),
	};
	const target = data.intercomTarget?.trim();
	const mode = data.mode === "single" || data.mode === "parallel" || data.mode === "chain"
		? data.mode : resultChildren.length > 1 ? "chain" : "single";
	return {
		local,
		...(target ? { intercom: { to: target, runId, mode, source: "async", children: normalized, asyncId: data.id, asyncDir: data.asyncDir } } : {}),
	};
}

function quarantineClaim(context: ResultProcessorContext, claim: ResultFileClaim): void {
	const fsApi = context.fsApi ?? fs;
	updateResultClaim(claim, { state: "undelivered" }, fsApi);
	quarantineResultFile(context.resultsDir, claim.meta.originalFile, claim.payloadPath, fsApi as typeof fs);
	removeResultClaim(claim, fsApi);
}

export async function processResultEntry(entry: string, context: ResultProcessorContext): Promise<ResultProcessOutcome> {
	const fsApi = context.fsApi ?? fs;
	let claim: ResultFileClaim | undefined;
	const existingClaimId = claimIdFromScheduleKey(entry);
	if (existingClaimId) {
		claim = loadResultClaim(context.resultsDir, existingClaimId, fsApi);
		if (!claim) return { status: "done" };
		if (claim.meta.state === "delivered") { removeResultClaim(claim, fsApi); return { status: "done" }; }
		if (claim.meta.state === "undelivered") { quarantineClaim(context, claim); return { status: "done" }; }
	} else {
		const publicPath = path.join(context.resultsDir, entry);
		if (!(fsApi.existsSync ?? fs.existsSync)(publicPath)) return { status: "done" };
		const preliminary = readPublic(context.resultsDir, entry, fsApi);
		if (!context.ownsResult(preliminary)) return { status: "inactive" };
		if (!modernResultHasTerminalStatus(preliminary, statusFs(fsApi), {
			allowedRoots: context.allowedStatusRoots,
			maxBytes: context.maxStatusBytes,
		})) return { status: "status-pending", entry };
		claim = claimPublicResult(context.resultsDir, entry, fsApi);
	}

	const { data } = readClaimData(claim, fsApi);
	if (!context.ownsResult(data)) return { status: "inactive" };
	if (!modernResultHasTerminalStatus(data, statusFs(fsApi), {
		allowedRoots: context.allowedStatusRoots,
		maxBytes: context.maxStatusBytes,
	})) return { status: "status-pending", entry: claim ? claimScheduleKey(claim.id) : entry };
	const sourceSignature = buildCompletionSignature({ source: data });
	if (claim.meta.sourceSignature && claim.meta.sourceSignature !== sourceSignature) {
		quarantineClaim(context, claim);
		return { status: "done" };
	}
	let envelope = claim.meta.envelope;
	if (!envelope) {
		envelope = buildEnvelope(data, claim.payloadPath, fsApi);
		updateResultClaim(claim, { sourceSignature, envelope }, fsApi);
	}
	const completionKey = buildCompletionKey(data, `result:${claim.meta.originalFile}`);
	const claimKey = `${path.resolve(context.resultsDir)}:${completionKey}`;
	const stableHash = createHash("sha256").update(`${claimKey}:${sourceSignature}`).digest("hex");
	const seen = lookupSeenWithTtl(context.state.completionSeen, completionKey, sourceSignature, Date.now(), context.completionTtlMs);
	if (seen === "match") {
		updateResultClaim(claim, { state: "delivered" }, fsApi);
		removeResultClaim(claim, fsApi);
		return { status: "done" };
	}
	if (seen === "conflict") {
		quarantineClaim(context, claim);
		return { status: "done" };
	}
	const claimResult = await deliverClaimedCompletion(
		claimKey,
		sourceSignature,
		context.completionTtlMs,
		{
			isOwned: () => context.isActive() && context.ownsResult(data),
			onState: (value) => markClaimState(claim!, value, fsApi),
			intercom: envelope.intercom ? async (frozen) => {
				const payload = buildSubagentResultIntercomPayload(frozen.intercom!);
				payload.requestId = `completion-${stableHash}`;
				return deliverSubagentResultIntercomEvent(context.pi.events, payload, context.intercomTimeoutMs ?? 500);
			} : undefined,
			local: async (frozen) => deliverLocalCompletionNotification(
				context.pi.events, frozen.local, `completion-notify-${stableHash}`,
			),
		},
		context.maxNoProgressFailures,
		{
			envelope: claim.meta.envelope,
			intercomDelivered: claim.meta.intercomDelivered,
			localDelivered: claim.meta.localDelivered,
			noProgressFailures: claim.meta.noProgressFailures,
		},
		envelope,
	);
	if (claimResult.status === "retry" || claimResult.status === "released") {
		return context.isActive() && context.ownsResult(data)
			? { status: "delivery-retry", entry: claimScheduleKey(claim.id) }
			: { status: "inactive" };
	}
	if (claimResult.status === "conflict" || claimResult.status === "exhausted") {
		quarantineClaim(context, claim);
		return { status: "done" };
	}
	recordSeen(context.state.completionSeen, completionKey, Date.now(), sourceSignature);
	updateResultClaim(claim, { state: "delivered" }, fsApi);
	removeResultClaim(claim, fsApi);
	return { status: "done" };
}
