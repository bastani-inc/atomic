import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import type { PromptOptions } from "@bastani/atomic";
import type {
  StageOutputOptions,
  StagePromptOptions,
  WorkflowMaxOutput,
} from "../../shared/types.js";

const DEFAULT_MAX_OUTPUT_BYTES = 200 * 1024;
const DEFAULT_MAX_OUTPUT_LINES = 5000;

function normalizeMaxOutput(maxOutput: WorkflowMaxOutput | undefined): Required<WorkflowMaxOutput> {
  return {
    bytes: maxOutput?.bytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    lines: maxOutput?.lines ?? DEFAULT_MAX_OUTPUT_LINES,
  };
}

function truncateByLines(text: string, maxLines: number): { text: string; truncated: boolean } {
  if (!Number.isFinite(maxLines) || maxLines <= 0) return { text: "", truncated: text.length > 0 };
  const lines = text.split(/\r?\n/);
  if (lines.length <= maxLines) return { text, truncated: false };
  return { text: lines.slice(0, maxLines).join("\n"), truncated: true };
}

function truncateByBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return { text: "", truncated: text.length > 0 };
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return { text, truncated: false };

  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, mid), "utf8") <= maxBytes) low = mid;
    else high = mid - 1;
  }
  return { text: text.slice(0, low), truncated: true };
}

function truncateOutput(text: string, maxOutput: WorkflowMaxOutput | undefined): string {
  const limits = normalizeMaxOutput(maxOutput);
  const byLines = truncateByLines(text, limits.lines);
  const byBytes = truncateByBytes(byLines.text, limits.bytes);
  if (!byLines.truncated && !byBytes.truncated) return text;
  return `${byBytes.text}\n\n[workflow output truncated; limits: ${limits.bytes} bytes, ${limits.lines} lines]`;
}

function countLines(text: string): number {
  if (!text) return 0;
  const newlineMatches = text.match(/\r\n|\r|\n/g);
  return (newlineMatches?.length ?? 0) + (/[\r\n]$/.test(text) ? 0 : 1);
}

function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

function savedOutputReference(outputPath: string, fullOutput: string): string {
  const absolutePath = resolve(outputPath);
  const bytes = Buffer.byteLength(fullOutput, "utf8");
  const lines = countLines(fullOutput);
  return `Output saved to: ${absolutePath} (${formatByteSize(bytes)}, ${lines} ${lines === 1 ? "line" : "lines"}). Read this file if needed.`;
}

function resolveOutputPath(
  output: string | false | undefined,
  runtimeCwd: string,
  requestedCwd: string | undefined,
): string | undefined {
  if (typeof output !== "string" || output.length === 0) return undefined;
  if (isAbsolute(output)) return output;
  const baseCwd = requestedCwd === undefined
    ? runtimeCwd
    : isAbsolute(requestedCwd)
      ? requestedCwd
      : resolve(runtimeCwd, requestedCwd);
  return resolve(baseCwd, output);
}

export function splitPromptOptions(options: StagePromptOptions | undefined): {
  sdkOptions: PromptOptions | undefined;
  outputOptions: StageOutputOptions;
} {
  if (!options) return { sdkOptions: undefined, outputOptions: {} };
  const sdkOptions: PromptOptions = {};
  if (options.expandPromptTemplates !== undefined) sdkOptions.expandPromptTemplates = options.expandPromptTemplates;
  if (options.images !== undefined) sdkOptions.images = options.images;
  if (options.streamingBehavior !== undefined) sdkOptions.streamingBehavior = options.streamingBehavior;
  if (options.source !== undefined) sdkOptions.source = options.source;
  if (options.preflightResult !== undefined) sdkOptions.preflightResult = options.preflightResult;

  const outputOptions: StageOutputOptions = {
    ...(options.output !== undefined ? { output: options.output } : {}),
    ...(options.outputMode !== undefined ? { outputMode: options.outputMode } : {}),
    ...(options.context !== undefined ? { context: options.context } : {}),
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.maxOutput !== undefined ? { maxOutput: options.maxOutput } : {}),
    ...(options.artifacts !== undefined ? { artifacts: options.artifacts } : {}),
    ...(options.sessionDir !== undefined ? { sessionDir: options.sessionDir } : {}),
  };

  return {
    sdkOptions: Object.keys(sdkOptions).length === 0 ? undefined : sdkOptions,
    outputOptions,
  };
}

export function validatePromptOutputOptions(outputOptions: StageOutputOptions): void {
  if (outputOptions.outputMode === "file-only" && (typeof outputOptions.output !== "string" || outputOptions.output.length === 0)) {
    throw new Error(
      "atomic-workflows: prompt sets outputMode: \"file-only\" but does not configure an output file. Set output to a path or use outputMode: \"inline\".",
    );
  }
}

export async function finalizePromptOutput(
  fullOutput: string,
  outputOptions: StageOutputOptions,
  runtimeCwd: string,
): Promise<string> {
  const outputPath = resolveOutputPath(outputOptions.output, runtimeCwd, outputOptions.cwd);
  validatePromptOutputOptions(outputOptions);
  const displayOutput = truncateOutput(fullOutput, outputOptions.maxOutput);
  if (outputPath === undefined) return displayOutput;

  try {
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, fullOutput, "utf8");
  } catch (err) {
    return `${displayOutput}\n\nOutput file error: ${outputPath}\n${err instanceof Error ? err.message : String(err)}`;
  }

  const reference = savedOutputReference(outputPath, fullOutput);
  return outputOptions.outputMode === "file-only"
    ? reference
    : `${displayOutput}\n\n${reference}`;
}
