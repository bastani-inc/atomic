import { randomUUID } from "node:crypto";
import { arch, platform } from "node:os";
import type { ExtensionContext, LoadedExtensionInfo } from "@bastani/atomic";
import { VERSION } from "@bastani/atomic";
import { boundDiagnostic, scrubFeedback } from "./privacy.js";

const MAX_FAILURES = 5;
const MAX_FAILURE_CHARS = 200;
const MAX_EXTENSIONS = 50;
const MAX_PATHS = 100;
const MAX_PENDING_SNAPSHOTS = 8;
const MAX_BASELINE_PATHS = 10_000;
const MAX_BASELINE_CHARS = 256 * 1024;
const STATUS_TIMEOUT_MS = 10_000;
type Baseline = Set<string> | "too-large" | "worktree-unavailable";
const snapshots = new WeakMap<object, Map<string, Baseline>>();
export interface FeedbackDiagnostics {
	readonly report: string;
	readonly version: string;
	readonly platform: { readonly os: string; readonly arch: string };
	readonly mode: ExtensionContext["mode"];
	readonly model: { readonly id: string; readonly provider: string } | undefined;
	readonly extensions: readonly string[];
	readonly recentFailures: readonly string[];
	readonly worktree: {
		readonly paths: readonly string[];
		readonly available: boolean;
		readonly truncated: boolean;
	};
	readonly snapshotId?: string;
	readonly createdPaths?: readonly string[];
	readonly createdPathsTruncated?: boolean;
	readonly baselineUnavailable?: "missing" | "too-large" | "worktree-unavailable";
}
interface ExecResult {
	readonly stdout: string;
	readonly code: number;
	readonly killed?: boolean;
}
export interface DiagnosticsInput {
	readonly report: string;
	readonly phase: "before" | "after";
	readonly since?: string;
}
export interface DiagnosticsRuntime {
	readonly ctx: ExtensionContext;
	readonly loadedExtensions: readonly LoadedExtensionInfo[];
	exec(
		command: string,
		args: string[],
		options: { cwd: string; signal?: AbortSignal; timeout?: number },
	): Promise<ExecResult>;
}
function safe(text: string): string {
	return scrubFeedback("", text).body;
}
function failureText(message: object): string | undefined {
	const record = message as {
		role?: string;
		isError?: boolean;
		stopReason?: string;
		content?: readonly { type?: string; text?: string }[];
		errorMessage?: string;
	};
	if (record.role === "toolResult" && record.isError)
		return record.content?.find(({ type }) => type === "text")?.text ?? "Tool failed";
	if (record.role === "assistant" && record.stopReason === "error") return record.errorMessage ?? "Model turn failed";
	return undefined;
}
function recentFailures(ctx: ExtensionContext): string[] {
	return ctx.sessionManager
		.getBranch()
		.flatMap((entry) => (entry.type === "message" ? [failureText(entry.message)] : []))
		.filter((text): text is string => text !== undefined)
		.slice(-MAX_FAILURES)
		.map((text) => safe(text).slice(0, MAX_FAILURE_CHARS));
}
async function worktree(
	runtime: DiagnosticsRuntime,
	captureBaseline: boolean,
	before: Baseline | undefined,
): Promise<
	| {
			paths: string[];
			truncated: boolean;
			createdPaths: string[];
			createdPathsTruncated: boolean;
			baseline: Baseline | undefined;
	  }
	| undefined
> {
	try {
		// The host exec API buffers stdout and has no output cap; bound our parsing and retention here.
		const status = await runtime.exec("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
			cwd: runtime.ctx.cwd,
			timeout: STATUS_TIMEOUT_MS,
		});
		if (status.code !== 0 || status.killed) return undefined;
		const output = status.stdout;
		if (output && !output.endsWith("\0")) return undefined;
		const paths: string[] = [];
		const createdPaths: string[] = [];
		let createdPathsTruncated = false;
		let baseline: Baseline | undefined = captureBaseline ? new Set<string>() : undefined;
		let pathCount = 0;
		let pathChars = 0;
		for (let start = 0; start < output.length; ) {
			const end = output.indexOf("\0", start);
			const x = output[start];
			const y = output[start + 1];
			if (end - start <= 3 || !" MTADRCU?!".includes(x) || !" MTADRCU?!".includes(y) || output[start + 2] !== " ")
				return undefined;
			pathCount++;
			pathChars += end - start - 3;
			// Never truncate the comparison set: omitted old paths would appear newly created.
			if (baseline instanceof Set && (pathCount > MAX_BASELINE_PATHS || pathChars > MAX_BASELINE_CHARS))
				baseline = "too-large";
			const compare =
				before instanceof Set &&
				!createdPathsTruncated &&
				((x === "?" && y === "?") || x === "A" || x === "C" || y === "C" || x === "R" || y === "R");
			if (paths.length < MAX_PATHS || baseline instanceof Set || compare) {
				const path = output.slice(start + 3, end);
				if (paths.length < MAX_PATHS) paths.push(path);
				if (baseline instanceof Set) baseline.add(path);
				if (compare && before instanceof Set && !before.has(path)) {
					if (createdPaths.length < MAX_PATHS) createdPaths.push(path);
					else createdPathsTruncated = true;
				}
			}
			start = end + 1;
			// Porcelain -z emits the destination first, followed by a separate nonempty source path.
			if (x === "R" || x === "C" || y === "R" || y === "C") {
				const sourceEnd = output.indexOf("\0", start);
				if (sourceEnd <= start) return undefined;
				start = sourceEnd + 1;
			}
		}
		return { paths, truncated: pathCount > MAX_PATHS, createdPaths, createdPathsTruncated, baseline };
	} catch {
		return undefined;
	}
}
function sessionSnapshots(ctx: ExtensionContext): Map<string, Baseline> {
	let session = snapshots.get(ctx.sessionManager);
	if (!session) {
		session = new Map();
		snapshots.set(ctx.sessionManager, session);
	}
	return session;
}
export async function collectFeedbackDiagnostics(
	input: DiagnosticsInput,
	runtime: DiagnosticsRuntime,
): Promise<FeedbackDiagnostics> {
	const session = sessionSnapshots(runtime.ctx);
	const before = input.phase === "after" && input.since ? session.get(input.since) : undefined;
	const snapshotId = input.phase === "before" ? `feedback-${randomUUID()}` : undefined;
	const current = await worktree(runtime, snapshotId !== undefined, before);
	const retained = !current ? "worktree-unavailable" : snapshotId ? current.baseline : before;
	if (snapshotId && retained) {
		session.set(snapshotId, retained);
		while (session.size > MAX_PENDING_SNAPSHOTS) session.delete(session.keys().next().value!);
	}
	if (input.phase === "after" && input.since) session.delete(input.since);
	const baselineUnavailable = typeof retained === "string" ? retained : retained ? undefined : "missing";
	return {
		report: boundDiagnostic(safe(input.report)),
		version: safe(VERSION),
		platform: { os: platform(), arch: arch() },
		mode: runtime.ctx.mode,
		model: runtime.ctx.model
			? { id: safe(runtime.ctx.model.id), provider: safe(runtime.ctx.model.provider) }
			: undefined,
		extensions: runtime.loadedExtensions
			.filter(({ configurationOrigin }) => configurationOrigin !== "bundled")
			.map(({ name }) => safe(name).replaceAll("\\", "/").split("/").slice(-2).join("/"))
			.slice(0, MAX_EXTENSIONS),
		recentFailures: recentFailures(runtime.ctx),
		worktree: {
			paths: current?.paths.map(safe) ?? [],
			available: current !== undefined,
			truncated: current?.truncated ?? false,
		},
		...(snapshotId ? { snapshotId } : {}),
		...(current && before instanceof Set
			? { createdPaths: current.createdPaths.map(safe), createdPathsTruncated: current.createdPathsTruncated }
			: {}),
		...(baselineUnavailable ? { baselineUnavailable } : {}),
	};
}
