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
	readonly worktree: { readonly paths: readonly string[]; readonly available: boolean };
	readonly snapshotId?: string;
	readonly createdPaths?: readonly string[];
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
	exec(command: string, args: string[], options: { cwd: string; signal?: AbortSignal }): Promise<ExecResult>;
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
async function worktree(runtime: DiagnosticsRuntime): Promise<{ paths: string[]; createdPaths: string[] } | undefined> {
	try {
		const status = await runtime.exec("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
			cwd: runtime.ctx.cwd,
		});
		if (status.code !== 0 || status.killed) return undefined;
		if (status.stdout && !status.stdout.endsWith("\0")) return undefined;
		const records = status.stdout.split("\0");
		records.pop(); // Remove the final terminator, not an interior empty/malformed record.
		const paths: string[] = [];
		const createdPaths: string[] = [];
		for (let i = 0; i < records.length; i++) {
			const record = records[i];
			if (record.length <= 3 || !/^[ MTADRCU?!]{2} /u.test(record)) return undefined;
			const path = record.slice(3);
			paths.push(path);
			if (record.startsWith("??") || record.startsWith("A")) createdPaths.push(path);
			// Porcelain -z emits the destination first, followed by a separate source path.
			if (/^(?:[RC].|.[RC])/u.test(record) && !records[++i]) return undefined;
		}
		return { paths, createdPaths };
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
function baseline(paths: string[]): Baseline {
	// Never truncate the comparison set: omitted old paths would appear newly created.
	if (paths.length > MAX_BASELINE_PATHS || paths.reduce((chars, path) => chars + path.length, 0) > MAX_BASELINE_CHARS)
		return "too-large";
	return new Set(paths);
}
export async function collectFeedbackDiagnostics(
	input: DiagnosticsInput,
	runtime: DiagnosticsRuntime,
): Promise<FeedbackDiagnostics> {
	const current = await worktree(runtime);
	const session = sessionSnapshots(runtime.ctx);
	const before = input.phase === "after" && input.since ? session.get(input.since) : undefined;
	const snapshotId = input.phase === "before" ? `feedback-${randomUUID()}` : undefined;
	const retained = !current ? "worktree-unavailable" : snapshotId ? baseline(current.paths) : before;
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
		worktree: { paths: current?.paths.slice(0, MAX_PATHS).map(safe) ?? [], available: current !== undefined },
		...(snapshotId ? { snapshotId } : {}),
		...(current && before instanceof Set
			? {
					createdPaths: current.createdPaths
						.filter((path) => !before.has(path))
						.slice(0, MAX_PATHS)
						.map(safe),
				}
			: {}),
		...(baselineUnavailable ? { baselineUnavailable } : {}),
	};
}
