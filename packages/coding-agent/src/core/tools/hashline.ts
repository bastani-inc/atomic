import { isAbsolute, normalize as normalizePath, relative, sep } from "node:path";
import {
	computeFileHash,
	formatHashlineHeader,
	formatNumberedLines,
	InMemorySnapshotStore,
	type SnapshotStore,
} from "./hashline-engine/index.ts";

export interface HashlineSnapshot {
	absolutePath: string;
	displayPath: string;
	tag: string;
	content: string;
}

export interface HashlineSnapshotStore {
	readonly snapshots: SnapshotStore;
	record(absolutePath: string, cwd: string, content: string): HashlineSnapshot;
	findByHeader(displayPath: string, tag: string): HashlineSnapshot | undefined;
}

function toPosixPath(filePath: string): string {
	return filePath.split(sep).join("/");
}

export function hashlineDisplayPath(absolutePath: string, cwd: string): string {
	const relativePath = relative(cwd, absolutePath);
	if (relativePath && !relativePath.startsWith("..") && !isAbsolute(relativePath)) return toPosixPath(relativePath);
	return toPosixPath(absolutePath);
}

/**
 * The key a path's snapshots are filed under in the underlying {@link SnapshotStore}.
 *
 * `record` below is the only place that decides this, so anything asking the store about a
 * path it did not itself record goes through here rather than re-deriving the convention and
 * drifting from it. Note this is `path.normalize`, not `realpath`: two symlinked spellings of
 * one file are two keys here, unlike `canonicalMutationKey`.
 */
export function hashlineStoreKey(absolutePath: string): string {
	return normalizePath(absolutePath);
}

export function normalizeHashlineContent(content: string): string {
	return content
		.replace(/^\uFEFF/, "")
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n");
}

export function computeHashlineTag(content: string): string {
	return computeFileHash(normalizeHashlineContent(content));
}

export function createHashlineSnapshotStore(): HashlineSnapshotStore {
	const snapshots = new InMemorySnapshotStore();
	const headers = new Map<string, HashlineSnapshot>();
	return {
		snapshots,
		record(absolutePath: string, cwd: string, content: string): HashlineSnapshot {
			const normalizedPath = hashlineStoreKey(absolutePath);
			const normalized = normalizeHashlineContent(content);
			const displayPath = hashlineDisplayPath(normalizedPath, cwd);
			const tag = snapshots.record(normalizedPath, normalized);
			const snapshot = { absolutePath: normalizedPath, displayPath, tag, content: normalized };
			headers.set(`${displayPath}\0${tag}`, snapshot);
			return snapshot;
		},
		findByHeader(displayPath: string, tag: string): HashlineSnapshot | undefined {
			return headers.get(`${displayPath}\0${tag.toUpperCase()}`);
		},
	};
}

export function recordHashlineSnapshot(
	absolutePath: string,
	cwd: string,
	content: string,
	store: HashlineSnapshotStore,
): HashlineSnapshot {
	return store.record(absolutePath, cwd, content);
}

export function formatHashlineContent(snapshot: HashlineSnapshot, content = snapshot.content, startLine = 1): string {
	return [
		formatHashlineHeader(snapshot.displayPath, snapshot.tag),
		formatNumberedLines(normalizeHashlineContent(content), startLine),
	].join("\n");
}

export interface StrippedHashlineContent {
	content: string;
	stripped: boolean;
}

export function stripKnownHashlineCopiedContentWithMeta(
	content: string,
	absolutePath: string,
	cwd: string,
	store: HashlineSnapshotStore,
	emittedPath: string,
): StrippedHashlineContent {
	const normalized = normalizeHashlineContent(content);
	const lines = normalized.split("\n");
	const headerIndex = lines.findIndex(
		(line, index) =>
			/^\[[^\]\n]+#[0-9A-Fa-f]{4}\]$/.test(line) &&
			lines.slice(0, index).every((prefix) => prefix.trim() === "" || /^#\s+.+\/?$/.test(prefix)),
	);
	if (headerIndex < 0) return { content, stripped: false };
	const header = (lines[headerIndex] ?? "").match(/^\[([^\]\n]+)#([0-9A-Fa-f]{4})\]$/);
	if (!header) return { content, stripped: false };
	const snapshot = store.findByHeader(header[1] ?? "", header[2] ?? "");
	if (!snapshot) return { content, stripped: false };
	const body = lines.slice(headerIndex + 1);
	if (body.length === 0) return { content: snapshot.content, stripped: true };
	// The write tool emits its confirmation from the raw `path` argument it was
	// called with (`Successfully wrote to ${path}`), not from the resolved path,
	// so `emittedPath` is the authoritative anchor: it is the only form that is
	// guaranteed to round-trip. The resolved and cwd-relative forms are accepted
	// because a caller may have named the file either way, and the snapshot's own
	// paths are accepted because a copied confirmation may belong to the write
	// that produced the snapshot being copied. Every candidate is a complete
	// path — a bare basename is deliberately NOT accepted, since `Successfully
	// wrote to notes.md` is ordinary prose when the target is `deep/dir/notes.md`,
	// and treating it as chrome destroys that line and everything after it.
	const knownConfirmationPaths = new Set<string>();
	const addKnownPath = (filePath: string): void => {
		if (!filePath) return;
		knownConfirmationPaths.add(filePath);
		knownConfirmationPaths.add(filePath.replaceAll("\\", "/"));
		knownConfirmationPaths.add(filePath.replaceAll("/", "\\"));
	};
	addKnownPath(emittedPath);
	addKnownPath(absolutePath);
	if (absolutePath) addKnownPath(relative(cwd, absolutePath));
	addKnownPath(snapshot.absolutePath);
	addKnownPath(snapshot.displayPath);
	const isKnownWriteConfirmation = (line: string): boolean => {
		const match = line.match(/^Successfully wrote (?:\d+ bytes )?to (.+)$/);
		return match !== null && knownConfirmationPaths.has(match[1] ?? "");
	};
	const stripped: string[] = [];
	const snapshotLines = snapshot.content.split("\n");
	let sawRow = false;
	let lastCopiedLineNumber: number | undefined;
	// Trailing tool chrome a model is likely to copy along with the hashline
	// body: the read/search continuation footers, the write tool's own
	// confirmation (and its stripped-note), and `Resolved …` conflict footers.
	// A write confirmation is chrome only when it names the exact path the write
	// was asked for; a matching prefix or basename alone may be user content.
	// The optional byte count keeps pre-e583b290 confirmations matchable.
	// These footers never carry a line number, so they mark the end of the
	// numbered body instead of aborting stripping like an arbitrary line.
	const isToolFooter = (line: string): boolean =>
		line.trim() === "" ||
		/^\[\d+ more lines in file\./.test(line) ||
		/^\[Showing lines /.test(line) ||
		isKnownWriteConfirmation(line) ||
		/^Resolved \d+ conflicts?/.test(line) ||
		/^Resolved conflict \d+/.test(line) ||
		/^Note: stripped copied hashline/.test(line) ||
		/^\[[^\]\n]+#[0-9A-Fa-f]{4}\]$/.test(line);
	let onlyFooter = true;
	for (const line of body) {
		if (isToolFooter(line)) {
			// A footer after the numbered body ends the body; a footer before any
			// row (leading blanks / a copied snapshot header) is just skipped.
			if (sawRow) break;
			continue;
		}
		onlyFooter = false;
		const match = line.match(/^[* ]?(\d+):(.*)$/s);
		if (!match) return { content, stripped: false };
		sawRow = true;
		const lineNumber = Number.parseInt(match[1] ?? "0", 10);
		const strippedLine = match[2] ?? "";
		if (snapshotLines[lineNumber - 1] !== strippedLine) return { content, stripped: false };
		lastCopiedLineNumber = lineNumber;
		stripped.push(strippedLine);
	}
	if (sawRow) {
		let strippedContent = stripped.join("\n");
		if (snapshot.content.endsWith("\n") && lastCopiedLineNumber === snapshotLines.length - 1) strippedContent += "\n";
		return { content: strippedContent, stripped: true };
	}

	// Header + only tool chrome (e.g. a copied write confirmation
	// `Successfully wrote to <path>`) names a known snapshot with no numbered
	// body to recover — resolve to the snapshot's stored content.
	if (onlyFooter) return { content: snapshot.content, stripped: true };
	return { content, stripped: false };
}

export function stripKnownHashlineCopiedContent(
	content: string,
	absolutePath: string,
	cwd: string,
	store: HashlineSnapshotStore,
	emittedPath: string,
): string {
	return stripKnownHashlineCopiedContentWithMeta(content, absolutePath, cwd, store, emittedPath).content;
}

export function formatCompactHashlineEditResult(
	snapshot: HashlineSnapshot,
	diff: { diff?: string; firstChangedLine?: number },
	messages: readonly string[] = [],
): string {
	return [
		formatHashlineHeader(snapshot.displayPath, snapshot.tag),
		...messages,
		diff.diff?.trim() || `First changed line: ${diff.firstChangedLine ?? 1}`,
	].join("\n");
}
