import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentConfigPaths } from "@bastani/atomic";
import { appendToActiveEventWriter } from "./event-jsonl-writer.ts";
import { TEMP_ARTIFACTS_DIR, type ArtifactPaths } from "./types.ts";
const CLEANUP_MARKER_FILE = ".last-cleanup";

export function getArtifactsDir(sessionFile: string | null): string {
	if (sessionFile) {
		const sessionDir = path.dirname(sessionFile);
		return path.join(sessionDir, "subagent-artifacts");
	}
	return TEMP_ARTIFACTS_DIR;
}

export function getArtifactPaths(artifactsDir: string, runId: string, agent: string, index?: number): ArtifactPaths {
	const suffix = index !== undefined ? `_${index}` : "";
	const safeAgent = agent.replace(/[^\w.-]/g, "_");
	const base = `${runId}_${safeAgent}${suffix}`;
	return {
		inputPath: path.join(artifactsDir, `${base}_input.md`),
		outputPath: path.join(artifactsDir, `${base}_output.md`),
		jsonlPath: path.join(artifactsDir, `${base}.jsonl`),
		metadataPath: path.join(artifactsDir, `${base}_meta.json`),
	};
}

export function ensureArtifactsDir(dir: string): void {
	fs.mkdirSync(dir, { recursive: true });
}

export function writeArtifact(filePath: string, content: string): void {
	fs.writeFileSync(filePath, content, "utf-8");
}

export function writeMetadata(filePath: string, metadata: object): void {
	fs.writeFileSync(filePath, JSON.stringify(metadata, null, 2), "utf-8");
}

export function appendJsonl(filePath: string, line: string): void {
	if (!appendToActiveEventWriter(filePath, line)) fs.appendFileSync(filePath, `${line}\n`);
}

function cleanupOldArtifactEntry(entryPath: string, cutoff: number): void {
	try {
		const stat = fs.lstatSync(entryPath);
		if (stat.isDirectory()) {
			for (const child of fs.readdirSync(entryPath)) {
				cleanupOldArtifactEntry(path.join(entryPath, child), cutoff);
			}
			if (fs.readdirSync(entryPath).length === 0 && stat.mtimeMs < cutoff) {
				fs.rmSync(entryPath, { recursive: true, force: true });
			}
			return;
		}
		if (stat.mtimeMs < cutoff) fs.rmSync(entryPath, { force: true });
	} catch {
		// Artifact cleanup is best-effort housekeeping. Skip entries that disappear
		// or become unreadable while scanning so one bad entry does not block the rest.
	}
}

export function cleanupOldArtifacts(dir: string, maxAgeDays: number): void {
	if (!fs.existsSync(dir)) return;

	const markerPath = path.join(dir, CLEANUP_MARKER_FILE);
	const now = Date.now();

	if (fs.existsSync(markerPath)) {
		const stat = fs.statSync(markerPath);
		if (now - stat.mtimeMs < 24 * 60 * 60 * 1000) return;
	}

	const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
	const cutoff = now - maxAgeMs;

	for (const file of fs.readdirSync(dir)) {
		if (file === CLEANUP_MARKER_FILE) continue;
		cleanupOldArtifactEntry(path.join(dir, file), cutoff);
	}

	fs.writeFileSync(markerPath, String(now));
}

export function cleanupAllArtifactDirs(maxAgeDays: number): void {
	cleanupOldArtifacts(TEMP_ARTIFACTS_DIR, maxAgeDays);

	for (const sessionsBase of getAgentConfigPaths("sessions")) {
		if (!fs.existsSync(sessionsBase)) continue;

		let dirs: string[];
		try {
			dirs = fs.readdirSync(sessionsBase);
		} catch {
			// Session artifact cleanup is best-effort. If the sessions root cannot be read,
			// skip cleanup instead of failing extension startup.
			continue;
		}

		for (const dir of dirs) {
			const artifactsDir = path.join(sessionsBase, dir, "subagent-artifacts");
			try {
				cleanupOldArtifacts(artifactsDir, maxAgeDays);
			} catch {
				// Session cleanup is best-effort. Keep going so one unreadable session dir
				// does not block cleanup for the rest.
			}
		}
	}
}
