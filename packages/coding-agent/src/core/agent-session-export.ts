import { randomUUID } from "node:crypto";
import { realpath } from "node:fs";
import { type FileHandle, mkdir, open, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import type { AssistantMessage, Usage } from "@bastani/atomic-ai/compat";
import { getThemeByName, theme } from "../modes/interactive/theme/theme.js";
import { resolvePath } from "../utils/paths.ts";
import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";
import type { SessionStats } from "./agent-session-types.js";
import { calculateContextTokens, estimateProjectedContextTokens } from "./compaction/index.ts";
import type { ToolHtmlRenderer } from "./export-html/index.ts";
import type { ContextUsage, ReplacedSessionContext } from "./extensions/index.js";
import { forkTranscriptEntries } from "./fork-transcript-boundary.js";
import {
	CURRENT_SESSION_VERSION,
	getLatestCompactionBoundaryEntry,
	type SessionEntry,
	SessionEntryError,
	type SessionHeader,
	type SessionManager,
} from "./session-manager.ts";
import { inlineToolOutput, withoutCarriedToolOutput } from "./session-tool-output.ts";
import { sessionSnapshotBlobs, snapshotBlobInliner } from "./session-worktree-snapshots.ts";
import { attachCleanupCause } from "./storage/cleanup.js";
import { worktreeSnapshotPages } from "./storage/session/snapshot-records.js";
import {
	type OversizedSessionEntry,
	SESSION_HISTORY_SCAN_ENTRIES,
	type SessionStore,
} from "./storage/session/types.js";
import { lastAssistantAnswer } from "./storage/session/window-answer.js";
import { addHistoryUsageToTotals, addUsageToTotals, createUsageTotals } from "./usage-totals.ts";
import type { SnapshotBlobStore, WorktreeSnapshot } from "./worktree-snapshot/types.ts";

export function getSessionStats(this: AgentSession): SessionStats {
	const omitted = this.sessionManager.getOmittedHistoryTotals?.();
	let userMessages = omitted?.userMessages ?? 0;
	let assistantMessages = omitted?.assistantMessages ?? 0;
	let toolResults = omitted?.toolResults ?? 0;
	let totalMessages = omitted?.totalMessages ?? 0;
	let toolCalls = omitted?.toolCalls ?? 0;
	const totals = createUsageTotals();
	addHistoryUsageToTotals(totals, omitted, true);
	let latestAssistantUsage: Usage | undefined = omitted?.latestAssistantUsage;
	let latestAssistantSeq = omitted?.latestAssistantSeq ?? -1;
	for (const entry of this.sessionManager.getEntries()) {
		if (
			(entry.type === "usage" ||
				entry.type === "branch_summary" ||
				entry.type === "session_summary" ||
				entry.type === "compaction") &&
			entry.usage
		) {
			addUsageToTotals(totals, entry.usage);
		}
		if (entry.type !== "message") continue;
		totalMessages++;
		const message = entry.message;
		if (message.role === "user") userMessages++;
		else if (message.role === "toolResult") {
			toolResults++;
			if ("usage" in message && message.usage) addUsageToTotals(totals, message.usage);
		} else if (message.role === "assistant") {
			assistantMessages++;
			const assistant = message as AssistantMessage;
			toolCalls += assistant.content.filter((content) => content.type === "toolCall").length;
			addUsageToTotals(totals, assistant.usage);
			const seq = this.sessionManager.getEntrySeq?.(entry.id) ?? Number.MAX_SAFE_INTEGER;
			if (seq >= latestAssistantSeq) {
				latestAssistantUsage = assistant.usage;
				latestAssistantSeq = seq;
			}
		}
	}

	return {
		sessionFile: this.sessionFile,
		sessionId: this.sessionId,
		userMessages,
		assistantMessages,
		toolCalls,
		toolResults,
		totalMessages,
		tokens: {
			input: totals.input,
			output: totals.output,
			cacheRead: totals.cacheRead,
			cacheWrite: totals.cacheWrite,
			total: totals.input + totals.output + totals.cacheRead + totals.cacheWrite,
		},
		cost: totals.cost,
		contextUsage: this.getContextUsage(),
		latestAssistantUsage,
	};
}

export function getContextUsage(this: AgentSession): ContextUsage | undefined {
	const model = this.model;
	if (!model) return undefined;

	const contextWindow = model.contextWindow ?? 0;
	if (contextWindow <= 0) return undefined;

	// After compaction, the last assistant usage reflects pre-compaction context size.
	// We can only trust usage from an assistant that responded after the latest compaction.
	// If no such assistant exists, context token count is unknown until the next LLM response.
	const projection = this.sessionManager.buildSessionProjection();
	const branchEntries = this.sessionManager.getBranch();
	const latestCompactionBoundary = getLatestCompactionBoundaryEntry(branchEntries);

	if (latestCompactionBoundary) {
		// Only a projected (not omitted) assistant that responded after the boundary
		// carries trustworthy usage.
		const projectedAssistants = new Set(
			projection.entries.flatMap((entry) =>
				entry.messages.some(
					(message) =>
						message.role === "assistant" &&
						message.stopReason !== "aborted" &&
						message.stopReason !== "error" &&
						calculateContextTokens(message.usage, message.api) > 0,
				)
					? [entry.sourceEntry.id]
					: [],
			),
		);
		const compactionIndex = branchEntries.findIndex((entry) => entry.id === latestCompactionBoundary.id);
		const hasPostCompactionUsage = branchEntries
			.slice(compactionIndex + 1)
			.some((entry) => projectedAssistants.has(entry.id));
		if (!hasPostCompactionUsage) return { tokens: null, contextWindow, percent: null };
	}

	const estimate = estimateProjectedContextTokens(projection, branchEntries);
	const percent = (estimate.tokens / contextWindow) * 100;

	return {
		tokens: estimate.tokens,
		contextWindow,
		percent,
	};
}

/**
 * Export session to HTML.
 * @param outputPath Optional output path (defaults to session directory)
 * @param options Optional export presentation settings; `themeName` overrides the
 * saved theme setting (e.g. with this run's --use-theme selection) when it names a
 * registered theme.
 * @returns Path to exported file
 */

export async function exportToHtml(
	this: AgentSession,
	outputPath?: string,
	options: { themeName?: string } = {},
): Promise<string> {
	const themeName = [options.themeName, this.settingsManager.getTheme()].find(
		(candidate) => candidate !== undefined && getThemeByName(candidate) !== undefined,
	);
	const [{ exportSessionToHtml }, { createToolHtmlRenderer }] = await Promise.all([
		import("./export-html/index.ts"),
		import("./export-html/tool-renderer.ts"),
	]);

	// Create tool renderer if we have an extension runner (for custom tool HTML rendering)
	const toolRenderer: ToolHtmlRenderer = createToolHtmlRenderer({
		getToolRenderers: (name) => this.extensionRunner.resolveToolRenderers(name, () => this.getToolDefinition(name)),
		theme,
		cwd: this.sessionManager.getCwd(),
	});

	return await exportSessionToHtml(this.sessionManager, this.state, {
		outputPath,
		themeName,
		toolRenderer,
	});
}

/**
 * Export the current session branch to a JSONL file.
 * Writes the session header followed by all entries on the current branch path, with the patch and bundle content
 * of its worktree snapshots and the tool outputs kept as session blobs carried inline.
 * @param outputPath Target file path. If omitted, generates a timestamped file in cwd.
 * @returns The resolved output file path.
 */

export async function exportToJsonl(
	this: AgentSession,
	outputPath?: string,
	options: { includeShareContext?: boolean; snapshotContent?: boolean; toolOutputContent?: boolean } = {},
): Promise<string> {
	const filePath = resolvePath(
		outputPath ?? `session-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`,
		process.cwd(),
	);
	await mkdir(dirname(filePath), { recursive: true });

	const sessionManager = this.sessionManager;
	const sessionId = sessionManager.getSessionId();
	const header: SessionHeader = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: sessionId,
		createdAt: new Date().toISOString(),
		cwd: sessionManager.getCwd(),
	};

	const store = sessionManager.getSessionStore();
	const snapshotEntries = withSnapshotContent(
		capturedBranch(sessionManager, store, options.snapshotContent !== false),
	);
	const branchEntries =
		options.toolOutputContent === false
			? withoutCarriedToolOutputs(snapshotEntries)
			: inlineToolOutput(snapshotEntries, store, sessionId);
	const shareEntry = (parentId: string | null) => ({
		type: "custom",
		id: randomUUID(),
		parentId,
		timestamp: new Date().toISOString(),
		customType: "atomic.share",
		data: {
			systemPrompt: this.systemPrompt,
			tools: this.agent.state.tools.map(({ name, description, parameters }) => ({
				name,
				description,
				parameters,
			})),
		},
	});

	// One line at a time into a file beside the target, moved into place when complete: carried tool outputs can be
	// large enough that the whole file would not fit in one string, and a failed export leaves the target as it was.
	// The partial file is owner-only while it is written, and takes the mode of the file it replaces, so a private
	// export never becomes readable by others; a new file stays owner-only.
	const target = await realpathJs(filePath).catch(() => filePath);
	const mode = await stat(target).then(
		(stats) => stats.mode & 0o7777,
		() => 0o600,
	);
	const partialPath = `${target}.${randomUUID()}.partial`;
	try {
		const file = await open(partialPath, "w", 0o600);
		try {
			await writeLine(file, JSON.stringify(header));
			// Re-chain parentIds to form a linear sequence
			let prevId: string | null = null;
			for await (const entry of branchEntries) {
				await writeLine(file, JSON.stringify({ ...entry, parentId: prevId }));
				prevId = entry.id;
			}
			if (options.includeShareContext) await writeLine(file, JSON.stringify(shareEntry(prevId)));
			await file.chmod(mode);
		} finally {
			await file.close();
		}
		await rename(partialPath, target);
	} catch (error) {
		try {
			await rm(partialPath, { force: true });
		} catch (cleanupCause) {
			attachCleanupCause(error, cleanupCause);
		}
		throw error;
	}
	return filePath;
}

type SnapshotBlobReader = Pick<SnapshotBlobStore, "getBlob">;
type SnapshotEntry = Extract<SessionEntry, { type: "worktree_snapshot" }>;

/**
 * The selected branch as the export started, which a session the manager moves on to does not change. `read` yields
 * its entries root first, as stored or as the manager holds them, as often as it is called. `record` and `blobs` give a
 * snapshot entry's record and content as a full load of the session gives them; `record` sees every snapshot entry of
 * one pass in order.
 */
interface CapturedBranch {
	/** The cut the branch is paged from, when the manager holds only its window. */
	readonly cut?: ArchiveCut;
	/** The stored position of the selected leaf, when the branch is paged from `cut`. */
	readonly leafSeq?: number;
	read(): AsyncGenerator<SessionEntry, void>;
	record(entry: SnapshotEntry): WorktreeSnapshot | undefined | Promise<WorktreeSnapshot | undefined>;
	blobs(entry: SnapshotEntry): SnapshotBlobReader | undefined;
}

/**
 * A manager that holds the whole session gives its branch from memory, with records and inline blobs from every
 * entry, as it always has. One that holds only its window pages the selected ancestry from the store, the manager's
 * own entry where it holds one, never loading the session. A snapshot entry's record is its own or one the branch
 * carried before; only a record the branch has not carried, and content neither the store's blob table nor the entry
 * has, are read from the rest of the session.
 */
function capturedBranch(sessionManager: SessionManager, store: SessionStore, content: boolean): CapturedBranch {
	if (sessionManager.hasFullHistory()) {
		const branch = sessionManager.getBranch();
		const records = sessionManager.getWorktreeSnapshotRecords();
		const blobs = content ? sessionSnapshotBlobs(store.snapshotBlobs, sessionManager.getEntries()) : undefined;
		return {
			async *read() {
				yield* branch;
			},
			record: (entry) => entry.snapshot ?? records.get(entry.snapshotId),
			blobs: () => blobs,
		};
	}
	const cut = sessionManager.captureArchive();
	const leafSeq = cut.leafId === null ? undefined : sessionManager.getEntrySeq(cut.leafId);
	// The window the manager holds ends the branch: its line of descent is read from memory, only what precedes it from
	// the store. Every ancestor of an entry was stored before it, so the stored ancestry before the window is the part
	// of the branch below the window's first sequence.
	const descent: SessionEntry[] = [];
	const seqOf = new Map([...cut.held].map(([seq, entry]) => [entry.id, seq]));
	for (let seq = leafSeq; seq !== undefined; ) {
		const entry = cut.held.get(seq)!;
		descent.push(entry);
		seq = entry.parentId === null ? undefined : seqOf.get(entry.parentId);
	}
	descent.reverse();
	const first = descent[0];
	const before = first === undefined || first.parentId === null ? 0 : seqOf.get(first.id)! - 1;
	const primary = store.snapshotBlobs;
	const session = sessionSnapshots(cut);
	const seen = new Map<string, WorktreeSnapshot>();
	return {
		cut,
		leafSeq,
		async *read() {
			if (cut.leafId === null) return;
			if (leafSeq === undefined) throw new SessionEntryError(cut.leafId, "missing");
			if (before > 0)
				for await (const { items } of readAhead(
					cut.pages({ branchLeafSeq: leafSeq, toSeq: before, pageEntries: SESSION_HISTORY_SCAN_ENTRIES }),
				)) {
					for (const item of items)
						yield cut.held.get(item.seq) ?? ("entry" in item ? item.entry : await entryOf(cut, item));
				}
			yield* descent;
		},
		async record(entry) {
			const record = entry.snapshot ?? seen.get(entry.snapshotId) ?? (await session.record(entry.snapshotId));
			if (record) seen.set(entry.snapshotId, record);
			return record;
		},
		blobs: (entry) =>
			content
				? {
						getBlob: async (hash) =>
							(await primary?.getBlob(hash)) ?? carriedBlob(entry, hash) ?? (await session.blob(hash)),
					}
				: undefined,
	};
}

/** One pass of `branch`, each snapshot entry with its record and content carried, each once. */
async function* withSnapshotContent(branch: CapturedBranch): AsyncGenerator<SessionEntry, void> {
	const inline = snapshotBlobInliner();
	for await (const entry of forkTranscriptEntries(() => branch.read()))
		yield entry.type === "worktree_snapshot"
			? await inline(entry, await branch.record(entry), branch.blobs(entry))
			: entry;
}

type ArchiveCut = ReturnType<SessionManager["captureArchive"]>;

/**
 * `pages`, each read while the one before it is written: the store's read and the file's writes overlap instead of
 * waiting on each other. At most two pages are held. A read that fails is thrown where its page would have been.
 */
async function* readAhead<T>(pages: AsyncGenerator<T, void>): AsyncGenerator<T, void> {
	const ahead = () => {
		const next = pages.next();
		next.catch(() => {});
		return next;
	};
	let next = ahead();
	try {
		for (;;) {
			const page = await next;
			if (page.done) return;
			next = ahead();
			yield page.value;
		}
	} finally {
		await pages.return(undefined);
	}
}

/** A stored entry too large for a history page, from its exact bytes. */
async function entryOf(cut: ArchiveCut, item: OversizedSessionEntry): Promise<SessionEntry> {
	const chunks: Uint8Array[] = [];
	for await (const chunk of cut.chunks(item)) chunks.push(chunk);
	return JSON.parse(Buffer.concat(chunks).toString("utf8")) as SessionEntry;
}

function carriedBlob(entry: SessionEntry, hash: string): Uint8Array | undefined {
	const base64 = entry.type === "worktree_snapshot" ? entry.blobs?.[hash] : undefined;
	return base64 === undefined ? undefined : new Uint8Array(Buffer.from(base64, "base64"));
}

/**
 * The session's snapshot records and inline snapshot content at `cut`, each the last the session has, as a full load
 * gives them. The first lookup reads the session's snapshot entries once, keeping only where each record and blob is;
 * each lookup then reads that one entry, so a session missing many blobs is still read once, not once a blob.
 */
function sessionSnapshots(cut: ArchiveCut) {
	let located: Promise<{ records: Map<string, number>; blobs: Map<string, number> }> | undefined;
	const locate = async () => {
		const records = new Map<string, number>();
		const blobs = new Map<string, number>();
		// Every page of the session is consumed at once, so it is read as a scan: more entries a page, never more bytes.
		const scan = {
			...cut,
			pages: (options = {}) => cut.pages({ ...options, pageEntries: SESSION_HISTORY_SCAN_ENTRIES }),
		};
		for await (const page of worktreeSnapshotPages(scan)) {
			for (const { seq, entry } of page) {
				if (entry.snapshot) records.set(entry.snapshotId, seq);
				for (const hash of Object.keys(entry.blobs ?? {})) blobs.set(hash, seq);
			}
		}
		return { records, blobs };
	};
	const at = async (seq: number | undefined) => {
		if (seq === undefined) return undefined;
		const held = cut.held.get(seq);
		if (held) return held;
		for await (const { items } of cut.pages({ fromSeq: seq, toSeq: seq }))
			for (const item of items) return "entry" in item ? item.entry : await entryOf(cut, item);
		return undefined;
	};
	return {
		async record(snapshotId: string): Promise<WorktreeSnapshot | undefined> {
			located ??= locate();
			const entry = await at((await located).records.get(snapshotId));
			return entry?.type === "worktree_snapshot" ? entry.snapshot : undefined;
		},
		async blob(hash: string): Promise<Uint8Array | undefined> {
			located ??= locate();
			const entry = await at((await located).blobs.get(hash));
			return entry === undefined ? undefined : carriedBlob(entry, hash);
		},
	};
}

/** `entries` without the bytes any tool-output entry carries inline, one at a time. */
async function* withoutCarriedToolOutputs(entries: AsyncIterable<SessionEntry>): AsyncGenerator<SessionEntry, void> {
	for await (const entry of entries) yield withoutCarriedToolOutput(entry);
}

const realpathJs = promisify(realpath);

/** Writes `text` and a line break to `file`, all of it: one write may take only part of a large string. */
async function writeLine(file: FileHandle, text: string): Promise<void> {
	const bytes = Buffer.from(`${text}\n`);
	for (let written = 0; written < bytes.length; ) written += (await file.write(bytes, written)).bytesWritten;
}

// =========================================================================
// Utilities
// =========================================================================

/**
 * Get text content of the last assistant reply.
 * Useful for /copy command.
 * @returns Text content, or undefined if no assistant message exists or the last reply has no text
 */

export function getLastAssistantText(this: AgentSession): string | undefined {
	const inContext = lastAssistantAnswer(this.messages);
	return inContext ? inContext.text : this.sessionManager.getLastBranchAnswer();
}

// =========================================================================
// Extension System
// =========================================================================

export function createReplacedSessionContext(this: AgentSession): ReplacedSessionContext {
	const context = Object.defineProperties(
		{},
		Object.getOwnPropertyDescriptors(this._extensionRunner.createCommandContext()),
	) as ReplacedSessionContext;
	context.sendMessage = (message, options) => this.sendCustomMessage(message, options);
	context.sendUserMessage = (content, options) => this.sendUserMessage(content, options);
	return context;
}

/**
 * Check if extensions have handlers for a specific event type.
 */

export function hasExtensionHandlers(this: AgentSession, eventType: string): boolean {
	return this._extensionRunner.hasHandlers(eventType);
}

/**
 * Get the extension runner (for setting UI context and error handlers).
 */

export const agentSessionExportMethods = {
	getSessionStats,
	getContextUsage,
	exportToHtml,
	exportToJsonl,
	getLastAssistantText,
	createReplacedSessionContext,
	hasExtensionHandlers,
};
