import { computeFileHash, formatHashlineHeader, formatNumberedLines, InMemorySnapshotStore, type SnapshotStore } from "./hashline-engine/index.ts";
import { isAbsolute, normalize as normalizePath, relative, sep } from "node:path";

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

export function normalizeHashlineContent(content: string): string {
	return content.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
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
			const normalizedPath = normalizePath(absolutePath);
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

export function recordHashlineSnapshot(absolutePath: string, cwd: string, content: string, store: HashlineSnapshotStore): HashlineSnapshot {
	return store.record(absolutePath, cwd, content);
}

export function formatHashlineContent(snapshot: HashlineSnapshot, content = snapshot.content, startLine = 1): string {
	return [formatHashlineHeader(snapshot.displayPath, snapshot.tag), formatNumberedLines(normalizeHashlineContent(content), startLine)].join("\n");
}

export interface StrippedHashlineContent { content: string; stripped: boolean }

export function stripKnownHashlineCopiedContentWithMeta(content: string, _absolutePath: string, _cwd: string, store: HashlineSnapshotStore): StrippedHashlineContent {
	const normalized = normalizeHashlineContent(content);
	const lines = normalized.split("\n");
	const headerIndex = lines.findIndex((line, index) => /^\[[^\]\n]+#[0-9A-Fa-f]{4}\]$/.test(line) && lines.slice(0, index).every((prefix) => prefix.trim() === "" || /^#\s+.+\/?$/.test(prefix)));
	if (headerIndex < 0) return { content, stripped: false };
	const header = (lines[headerIndex] ?? "").match(/^\[([^\]\n]+)#([0-9A-Fa-f]{4})\]$/);
	if (!header) return { content, stripped: false };
	const snapshot = store.findByHeader(header[1] ?? "", header[2] ?? "");
	if (!snapshot) return { content, stripped: false };
	const body = lines.slice(headerIndex + 1);
	if (body.length === 0) return { content: "", stripped: true };
	const stripped: string[] = [];
	const snapshotLines = snapshot.content.split("\n");
	let sawRow = false;
	// Trailing tool chrome a model is likely to copy along with the hashline
	// body: the read/search continuation footers, the write tool's own
	// `Successfully wrote N bytes to <path>` confirmation (and its stripped-
	// note), and `Resolved …` conflict footers. These never carry a line
	// number, so they mark the end of the numbered body — they must not abort
	// stripping the way an arbitrary non-row line would.
	const isToolFooter = (line: string): boolean =>
		line.trim() === ""
		|| /^\[\d+ more lines in file\./.test(line)
		|| /^\[Showing lines /.test(line)
		|| /^Successfully wrote \d+ bytes to /.test(line)
		|| /^Resolved \d+ conflicts?/.test(line)
		|| /^Resolved conflict \d+/.test(line)
		|| /^Note: stripped copied hashline/.test(line)
		|| /^\[[^\]\n]+#[0-9A-Fa-f]{4}\]$/.test(line);
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
		stripped.push(strippedLine);
	}
	if (sawRow) return { content: stripped.join("\n"), stripped: true };
	// Header + only tool chrome (e.g. a copied write confirmation
	// `Successfully wrote N bytes to <path>`) names a known snapshot with no
	// numbered body to recover — resolve to the snapshot's stored content.
	if (onlyFooter) return { content: snapshot.content, stripped: true };
	return { content, stripped: false };
}

export function stripKnownHashlineCopiedContent(content: string, absolutePath: string, cwd: string, store: HashlineSnapshotStore): string {
	return stripKnownHashlineCopiedContentWithMeta(content, absolutePath, cwd, store).content;
}

export function formatCompactHashlineEditResult(snapshot: HashlineSnapshot, diff: { diff?: string; firstChangedLine?: number }, messages: readonly string[] = []): string {
	return [formatHashlineHeader(snapshot.displayPath, snapshot.tag), ...messages, diff.diff?.trim() || `First changed line: ${diff.firstChangedLine ?? 1}`].join("\n");
}
