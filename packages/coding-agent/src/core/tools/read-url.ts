/**
 * URL branch of the `read` tool: routes plain URL reads through the
 * cache/artifact/llms.txt fetch pipeline ({@link executeReadUrl}) and keeps an
 * inline fetch + line-range path for explicit URL line selectors.
 */
import { resolve as resolvePath } from "node:path";
import type { TextContent } from "@earendil-works/pi-ai";
import type { ReadToolDetails } from "./read.ts";
import { applyReadLineSelection, decodeReadableUrl } from "./read-document-extract.ts";
import { executeReadUrl } from "./fetch-url.ts";

export interface ReadUrlBranchArgs {
	effectivePath: string;
	rawOutput: boolean;
	effectiveRanges: { start: number; end?: number }[] | undefined;
	effectiveOffset: number | undefined;
	effectiveLimit: number | undefined;
	cwd: string;
	ctx: unknown;
	signal?: AbortSignal;
	maxChars: number;
	maxBytes: number;
	oversized: (details: { blocked: true; path: string; chars: number; maxChars: number; startLine: number; totalFileLines: number; firstLineBytes: number; byteGuidance: boolean }) => { content: TextContent[]; details: ReadToolDetails };
	sourceMeta: (source: string) => ReadToolDetails;
}

export type ReadUrlBranchResult = { content: TextContent[]; details: ReadToolDetails | undefined };

export async function readUrlBranch(args: ReadUrlBranchArgs): Promise<ReadUrlBranchResult> {
	const { effectivePath, rawOutput, effectiveRanges, effectiveOffset, effectiveLimit, cwd, ctx, signal, maxChars, maxBytes, oversized, sourceMeta } = args;
	const session = (ctx as { sessionManager?: { getSessionDir?: () => string | undefined; getSessionId?: () => string | undefined } } | undefined)?.sessionManager;
	const sessionDir = session?.getSessionDir?.();
	const scope = session?.getSessionId?.() ?? cwd;
	const artifactsDir = sessionDir ? resolvePath(sessionDir, "artifacts") : undefined;
	if (!effectiveRanges && !effectiveOffset && effectiveLimit === undefined) {
		const result = await executeReadUrl(scope, { path: effectivePath, raw: rawOutput }, artifactsDir, signal);
		const artifactId = result.artifactId ?? result.details.meta?.artifactId;
		const truncation = result.details.meta?.truncation;
		return {
			content: [{ type: "text", text: result.content }],
			details: {
				...(truncation ? { truncation } : {}),
				meta: { ...(result.details.meta ?? {}), source: effectivePath, sourcePath: effectivePath, ...(artifactId ? { artifactId } : {}) },
			},
		};
	}
	const response = await fetch(/^www\./i.test(effectivePath) ? `https://${effectivePath}` : effectivePath, { signal });
	const textContent = rawOutput ? await response.text() : await decodeReadableUrl(response, effectivePath);
	const selection = applyReadLineSelection(textContent.split("\n"), effectiveRanges, effectiveOffset, effectiveLimit, rawOutput), selectedText = selection.lines.join("\n");
	if ((effectiveRanges || effectiveOffset) && selection.lines.length === 0) {
		const requested = effectiveRanges?.[0]?.start ?? effectiveOffset ?? 1;
		return { content: [{ type: "text", text: `Requested line ${requested} is beyond end of resource (${textContent.split("\n").length} lines total).` }], details: undefined };
	}
	if (selectedText.length > maxChars || Buffer.byteLength(selectedText, "utf8") > maxBytes) {
		return oversized({ blocked: true, path: effectivePath, chars: selectedText.length, maxChars, startLine: selection.firstLine, totalFileLines: textContent.split("\n").length, firstLineBytes: Buffer.byteLength(selection.lines[0] ?? "", "utf8"), byteGuidance: false });
	}
	return { content: [{ type: "text", text: rawOutput ? selectedText : `URL: ${effectivePath}\nStatus: ${response.status}\nContent-Type: ${response.headers.get("content-type") ?? "unknown"}\n\n${selectedText}` }], details: sourceMeta(effectivePath) };
}
