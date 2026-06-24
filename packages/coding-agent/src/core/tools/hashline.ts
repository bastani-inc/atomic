import { computeFileHash, formatHashlineHeader, formatNumberedLines, InMemorySnapshotStore, type SnapshotStore } from "./hashline-engine/index.ts";
import { isAbsolute, relative, sep } from "node:path";

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
			const normalized = normalizeHashlineContent(content);
			const displayPath = hashlineDisplayPath(absolutePath, cwd);
			const tag = snapshots.record(absolutePath, normalized);
			const snapshot = { absolutePath, displayPath, tag, content: normalized };
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

export function stripKnownHashlineCopiedContent(content: string, _absolutePath: string, _cwd: string, store: HashlineSnapshotStore): string {
	const normalized = normalizeHashlineContent(content);
	const lines = normalized.split("\n");
	const headerIndex = lines.findIndex((line, index) => /^\[[^\]\n]+#[0-9A-Fa-f]{4}\]$/.test(line) && lines.slice(0, index).every((prefix) => prefix.trim() === "" || /^#\s+.+\/?$/.test(prefix)));
	if (headerIndex < 0) return content;
	const header = (lines[headerIndex] ?? "").match(/^\[([^\]\n]+)#([0-9A-Fa-f]{4})\]$/);
	if (!header) return content;
	const snapshot = store.findByHeader(header[1] ?? "", header[2] ?? "");
	if (!snapshot) return content;
	const body = lines.slice(headerIndex + 1);
	if (body.length === 0) return "";
	const stripped: string[] = [];
	const snapshotLines = snapshot.content.split("\n");
	let sawRow = false;
	for (const line of body) {
		if (line.trim() === "" || /^\[\d+ more lines in file\./.test(line) || /^\[Showing lines /.test(line)) continue;
		const match = line.match(/^[* ]?(\d+):(.*)$/s);
		if (!match) return content;
		sawRow = true;
		const lineNumber = Number.parseInt(match[1] ?? "0", 10);
		const strippedLine = match[2] ?? "";
		if (snapshotLines[lineNumber - 1] !== strippedLine) return content;
		stripped.push(strippedLine);
	}
	return sawRow ? stripped.join("\n") : content;
}

export function formatCompactHashlineEditResult(snapshot: HashlineSnapshot, diff: { diff?: string; firstChangedLine?: number }, messages: readonly string[] = []): string {
	return [formatHashlineHeader(snapshot.displayPath, snapshot.tag), ...messages, diff.diff?.trim() || `First changed line: ${diff.firstChangedLine ?? 1}`].join("\n");
}
