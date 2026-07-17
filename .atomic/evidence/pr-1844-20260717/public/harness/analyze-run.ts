import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";

interface EventRecord {
  atNs: string;
  type: string;
  provider?: string;
  model?: string;
  api?: string;
  tokensBefore?: number;
  lines?: number;
  format?: string;
  promptVersion?: number;
  stats?: { tokensAfter: number; linesKept: number; linesDeleted: number };
  cache?: { cacheReadTokens: number; cacheWriteTokens: number; cacheHit: boolean };
}
interface PairIntegrity { sampleId: string; snapshotBodySha256: string; semanticHistoryMatch: boolean }

const root = process.argv[2];
if (!root) throw new Error("usage: analyze-run.ts RUN_ROOT");
const sha = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const parse = <T>(path: string): T[] => readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line) as T);
const aDir = join(root, "raw/sessions/scenario-a-final");
const aNames = readdirSync(aDir);
const session = join(aDir, aNames.find(name => name.endsWith(".jsonl"))!);
const backup = join(aDir, aNames.find(name => name.endsWith(".bak"))!);
const inspectA = (path: string) => {
  const entries = parse<Record<string, object>>(path);
  const messages = entries.filter(entry => entry.type === "message").map(entry => entry.message as Record<string, object>);
  const calls = new Map<string, string>();
  const results = new Map<string, string>();
  let large: { chars: number; sha256: string } | undefined;
  let continuation = false;
  for (const message of messages) {
    const content = message.content;
    if (Array.isArray(content)) for (const block of content as Array<Record<string, object>>) {
      if (block.type === "toolCall") calls.set(String(block.id), String(block.name));
      if (block.type === "text" && block.text === "CONTINUATION_OK pr1844-functional") continuation = true;
    }
    if (message.role === "toolResult") {
      const id = String(message.toolCallId);
      results.set(id, String(message.toolName));
      if (Array.isArray(content)) for (const block of content as Array<Record<string, object>>) {
        if (block.type === "text" && typeof block.text === "string" && block.text.length > 100000) {
          large = { chars: block.text.length, sha256: sha(block.text) };
        }
      }
    }
  }
  return {
    file: basename(path), bytes: statSync(path).size,
    mode: (statSync(path).mode & 0o777).toString(8).padStart(4, "0"), sha256: sha(readFileSync(path)), large,
    toolCalls: calls.size, toolResults: results.size,
    unmatchedCalls: [...calls].filter(([id, name]) => results.get(id) !== name).length,
    unmatchedResults: [...results].filter(([id, name]) => calls.get(id) !== name).length, continuation,
  };
};

const pairIds = ["2r", "5", "6"];
const pairIntegrity: PairIntegrity[] = pairIds.map(sampleId => {
  const snapshot = join(root, `raw/b-pair-${sampleId}-precompact.jsonl`);
  const snapshotLines = readFileSync(snapshot, "utf8").trimEnd().split("\n");
  const bodyHash = sha(snapshotLines.slice(1).join("\n"));
  const coldDir = join(root, `raw/sessions/b-cold-${sampleId}`);
  const coldBackup = readdirSync(coldDir).find(name => name.endsWith(".bak"))!;
  const coldLines = readFileSync(join(coldDir, coldBackup), "utf8").trimEnd().split("\n");
  const coldHash = sha(coldLines.slice(1).join("\n"));
  return { sampleId, snapshotBodySha256: bodyHash, coldBackupBodySha256: coldHash,
    semanticHistoryMatch: bodyHash === coldHash, snapshotBytes: statSync(snapshot).size };
});
writeFileSync(join(root, "public/a-integrity.json"), JSON.stringify({ session: inspectA(session), backup: inspectA(backup), pairIntegrity }, null, 2) + "\n");

const samples = pairIds.flatMap((sampleId, pairIndex) => ["warm", "cold"].map((cohort, cohortIndex) => {
  const events = parse<EventRecord>(join(root, `raw/b-${cohort}-${sampleId}-events.jsonl`));
  const start = events.find(event => event.type === "before_compact")!;
  const end = events.find(event => event.type === "session_compact")!;
  const sessionStart = events.find(event => event.type === "session_start")!;
  const beforeCompactNs = BigInt(start.atNs);
  const sessionCompactNs = BigInt(end.atNs);
  const elapsedNs = sessionCompactNs - beforeCompactNs;
  const history = pairIntegrity.find(pair => pair.sampleId === sampleId)!;
  return {
    cohort, sample_id: sampleId, order: pairIndex * 2 + cohortIndex + 1,
    before_compact_ns: beforeCompactNs.toString(), session_compact_ns: sessionCompactNs.toString(),
    elapsed_ns: elapsedNs.toString(), elapsed_ms: Number(elapsedNs) / 1e6,
    cache_telemetry_present: Boolean(end.cache), cache_read_tokens: end.cache?.cacheReadTokens ?? "",
    cache_write_tokens: end.cache?.cacheWriteTokens ?? "", cache_hit: end.cache?.cacheHit ?? "",
    provider: sessionStart.provider, model: sessionStart.model, api: sessionStart.api,
    history_body_sha256: history.snapshotBodySha256, tokens_before: start.tokensBefore,
    tokens_after: end.stats!.tokensAfter, lines_before: start.lines, lines_after: end.stats!.linesKept,
    lines_deleted: end.stats!.linesDeleted, format: end.format, prompt_version: end.promptVersion,
    strategy: "verbatim-lines", success: true, failure: "",
  };
}));
const columns = Object.keys(samples[0]) as Array<keyof (typeof samples)[number]>;
const csv = [columns.join(","), ...samples.map(sample => columns.map(column => String(sample[column])).join(","))].join("\n") + "\n";
writeFileSync(join(root, "public/samples.csv"), csv);

const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const warm = samples.filter(sample => sample.cohort === "warm");
const cold = samples.filter(sample => sample.cohort === "cold");
const warmMs = warm.map(sample => sample.elapsed_ms);
const coldMs = cold.map(sample => sample.elapsed_ms);
const warmMedian = median(warmMs);
const coldMedian = median(coldMs);
const summary = {
  source: "raw/b-{warm,cold}-{2r,5,6}-events.jsonl",
  timingBoundary: "session_compact.atNs - before_compact.atNs",
  sampleIds: pairIds, sampleCount: samples.length,
  elapsedNsIdentityVerified: samples.every(sample => BigInt(sample.session_compact_ns) - BigInt(sample.before_compact_ns) === BigInt(sample.elapsed_ns)),
  semanticHistoryMatchAllPairs: pairIntegrity.every(pair => pair.semanticHistoryMatch),
  warm: { elapsedMs: warmMs, medianMs: warmMedian, minMs: Math.min(...warmMs), maxMs: Math.max(...warmMs),
    cacheReadTokens: warm.map(sample => sample.cache_read_tokens), cacheWriteTokens: warm.map(sample => sample.cache_write_tokens), cacheHit: warm.map(sample => sample.cache_hit) },
  cold: { elapsedMs: coldMs, medianMs: coldMedian, minMs: Math.min(...coldMs), maxMs: Math.max(...coldMs),
    cacheTelemetry: "absent by design on isolated no-snapshot fallback; not represented as zero" },
  medianDeltaMsColdMinusWarm: coldMedian - warmMedian,
  warmOverColdMedianRatio: warmMedian / coldMedian,
  coldOverWarmMedianRatio: coldMedian / warmMedian,
  medianLatencyReductionPercent: (1 - warmMedian / coldMedian) * 100,
};
writeFileSync(join(root, "public/benchmark-summary.json"), JSON.stringify(summary, null, 2) + "\n");
const results = JSON.parse(readFileSync(join(root, "public/results.json"), "utf8")) as Record<string, object>;
const scenarioB = results.scenarioB as Record<string, object>;
Object.assign(scenarioB, {
  semanticHistoryMatchAllPairs: summary.semanticHistoryMatchAllPairs,
  warm: summary.warm, cold: summary.cold,
  medianDeltaMsColdMinusWarm: summary.medianDeltaMsColdMinusWarm,
  warmOverColdMedianRatio: summary.warmOverColdMedianRatio,
  coldOverWarmMedianRatio: summary.coldOverWarmMedianRatio,
  medianLatencyReductionPercent: summary.medianLatencyReductionPercent,
  generatedSummary: "benchmark-summary.json",
});
writeFileSync(join(root, "public/results.json"), JSON.stringify(results, null, 2) + "\n");
