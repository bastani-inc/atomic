import { randomUUID } from "node:crypto";
import { arch, platform } from "node:os";
import type { ExtensionContext, LoadedExtensionInfo } from "@bastani/atomic";
import { VERSION } from "@bastani/atomic";
import { boundDiagnostic, scrubFeedback } from "./privacy.js";

const MAX_FAILURES = 5;
const MAX_FAILURE_CHARS = 200;
const MAX_EXTENSIONS = 50;
const MAX_PATHS = 100;
const snapshots = new WeakMap<object, Map<string, Set<string>>>();
export interface FeedbackDiagnostics {
	readonly report: string;
	readonly version: string;
	readonly platform: { readonly os: string; readonly arch: string };
	readonly mode: ExtensionContext["mode"];
	readonly model: { readonly id: string; readonly provider: string } | undefined;
	readonly extensions: readonly string[];
	readonly recentFailures: readonly string[];
	readonly worktree: { readonly paths: readonly string[] };
	readonly snapshotId?: string;
	readonly createdPaths?: readonly string[];
}
interface ExecResult {
	readonly stdout: string;
	readonly code: number;
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
async function worktree(runtime: DiagnosticsRuntime): Promise<{ paths: string[]; createdPaths: string[] }> {
	try {
		const status = await runtime.exec("git", ["status", "--porcelain"], { cwd: runtime.ctx.cwd });
		if (status.code !== 0) return { paths: [], createdPaths: [] };
		const lines = status.stdout.split("\n").filter(Boolean);
		const path = (line: string) =>
			safe((/^(?:[RC].|.[RC])/u.test(line) ? line.split(" -> ").at(-1) : line.slice(3)) ?? "");
		return {
			paths: lines.map(path),
			createdPaths: lines.filter((line) => line.startsWith("??") || line.startsWith("A")).map(path),
		};
	} catch {
		return { paths: [], createdPaths: [] };
	}
}
function sessionSnapshots(ctx: ExtensionContext): Map<string, Set<string>> {
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
	const current = await worktree(runtime);
	const session = sessionSnapshots(runtime.ctx);
	const before = input.since ? session.get(input.since) : undefined;
	const snapshotId = input.phase === "before" ? `feedback-${randomUUID()}` : undefined;
	if (snapshotId) session.set(snapshotId, new Set(current.paths));
	if (input.phase === "after" && input.since) session.delete(input.since);
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
		worktree: { paths: current.paths.slice(0, MAX_PATHS) },
		...(snapshotId ? { snapshotId } : {}),
		...(before ? { createdPaths: current.createdPaths.filter((path) => !before.has(path)).slice(0, MAX_PATHS) } : {}),
	};
}
