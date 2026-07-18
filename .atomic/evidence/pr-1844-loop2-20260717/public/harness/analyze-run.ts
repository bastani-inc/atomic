import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

type Json = Record<string, unknown>;
type Event = Json & { atNs: string; type: string };
const root = process.argv[2];
if (!root) throw new Error("usage: bun analyze-run.ts RUN_ROOT");
const raw = join(root, "raw");
const sha = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const lines = (path: string): string[] => readFileSync(path, "utf8").trimEnd().split("\n");
const parse = <T>(path: string): T[] => lines(path).map(line => JSON.parse(line) as T);
const mode = (path: string): string => (statSync(path).mode & 0o777).toString(8).padStart(4, "0");

function inspectSession(path: string): Json {
  const entries = parse<Json>(path);
  const calls = new Map<string, string>();
  const results = new Map<string, string>();
  let large: Json | undefined;
  let continuation = false;
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message as Json;
    const content = Array.isArray(message.content) ? message.content as Json[] : [];
    for (const block of content) {
      if (block.type === "toolCall") calls.set(String(block.id), String(block.name));
      if (block.type === "text" && block.text === "CONTINUATION_OK pr1844-loop2-functional") continuation = true;
      if (message.role === "toolResult" && block.type === "text" && typeof block.text === "string" && block.text.length > 100000) {
        large = { chars: block.text.length, sha256: sha(block.text) };
      }
    }
    if (message.role === "toolResult") results.set(String(message.toolCallId), String(message.toolName));
  }
  return {
    file: basename(path), bytes: statSync(path).size, mode: mode(path), sha256: sha(readFileSync(path)), large,
    toolCalls: calls.size, toolResults: results.size,
    unmatchedCalls: [...calls].filter(([id, name]) => results.get(id) !== name).length,
    unmatchedResults: [...results].filter(([id, name]) => calls.get(id) !== name).length,
    continuation,
    compactionBoundaryCount: entries.filter(entry => entry.type === "compaction").length,
  };
}

const aDir = join(raw, "sessions/scenario-a-final");
const aFiles = readdirSync(aDir);
const aSessionPath = join(aDir, aFiles.find(name => name.endsWith(".jsonl"))!);
const aBackupPath = join(aDir, aFiles.find(name => name.endsWith(".bak"))!);
const aEvents = parse<Event>(join(raw, "scenario-a-final-events.jsonl"));
const aCompact = aEvents.find(event => event.type === "session_compact")!;
const aBefore = aEvents.find(event => event.type === "before_compact")!;
const aTurn = aEvents.filter(event => event.type === "turn_end").find(event => Number(event.totalTokens) > 100000)!;
const aBlob = aEvents.find(event => event.type === "blob")!;
const aStart = aEvents.find(event => event.type === "session_start")!;
const aSession = inspectSession(aSessionPath);
const aBackup = inspectSession(aBackupPath);
const backupBytes = readFileSync(aBackupPath);
const sessionBytes = readFileSync(aSessionPath);
const diagnosticCount = aFiles.filter(name => name.includes("diagnostic")).length;

const pairIds = ["1", "2", "3"];
const pairIntegrity = pairIds.map(sampleId => {
  const snapshot = join(raw, `b-pair-${sampleId}-precompact.jsonl`);
  const snapshotBody = lines(snapshot).slice(1).join("\n");
  const sessionDirs = [`sessions/b-warm-${sampleId}`, `sessions/b-cold-${sampleId}`];
  const backupBodies = sessionDirs.map(directory => {
    const dir = join(raw, directory);
    const backup = readdirSync(dir).find(name => name.endsWith(".bak"))!;
    return lines(join(dir, backup)).slice(1).join("\n");
  });
  return {
    sampleId, semanticBodySha256: sha(snapshotBody), snapshotBytes: statSync(snapshot).size,
    warmBackupBodySha256: sha(backupBodies[0]), coldBackupBodySha256: sha(backupBodies[1]),
    warmHistoryMatch: snapshotBody === backupBodies[0], coldHistoryMatch: snapshotBody === backupBodies[1],
  };
});

const samples = pairIds.flatMap((sampleId, pairIndex) => ["warm", "cold"].map((cohort, cohortIndex) => {
  const events = parse<Event>(join(raw, `b-${cohort}-${sampleId}-events.jsonl`));
  const start = events.find(event => event.type === "before_compact")!;
  const end = events.find(event => event.type === "session_compact")!;
  const sessionStart = events.find(event => event.type === "session_start")!;
  const normalTurn = events.find(event => event.type === "turn_end");
  const request = events.find(event => event.type === "provider_request");
  const cache = end.cache as Json | undefined;
  const stats = end.stats as Json;
  const beforeNs = BigInt(start.atNs);
  const compactNs = BigInt(end.atNs);
  const history = pairIntegrity.find(pair => pair.sampleId === sampleId)!;
  return {
    cohort, sample_id: sampleId, order: pairIndex * 2 + cohortIndex + 1,
    before_compact_ns: beforeNs.toString(), session_compact_ns: compactNs.toString(),
    elapsed_ns: (compactNs - beforeNs).toString(), elapsed_ms: Number(compactNs - beforeNs) / 1e6,
    cache_telemetry_present: Boolean(cache), cache_read_tokens: cache?.cacheReadTokens ?? "",
    cache_write_tokens: cache?.cacheWriteTokens ?? "", cache_hit: cache?.cacheHit ?? "",
    provider: sessionStart.provider, model: sessionStart.model, api: sessionStart.api,
    history_body_sha256: history.semanticBodySha256, tokens_before: start.tokensBefore,
    tokens_after: stats.tokensAfter, lines_before: start.lines, lines_after: stats.linesKept,
    lines_deleted: stats.linesDeleted, format: end.format, prompt_version: end.promptVersion,
    normal_request_input_items: normalTurn ? request?.inputItems ?? "" : "",
    normal_request_input_bytes: normalTurn ? request?.inputBytes ?? "" : "",
    normal_request_input_sha256: normalTurn ? request?.inputSha256 ?? "" : "",
    normal_request_repeated_item_hash_kinds: normalTurn ? request?.repeatedItemHashKinds ?? "" : "",
    request_bound_provider_input_tokens: normalTurn ? Number(normalTurn.input) + Number(normalTurn.cacheRead) + Number(normalTurn.cacheWrite) : "",
    request_total_tokens: normalTurn?.totalTokens ?? "", success: true, failure: "",
  };
}));
const columns = Object.keys(samples[0]) as Array<keyof typeof samples[number]>;
writeFileSync(join(root, "public/samples.csv"), [columns.join(","), ...samples.map(row => columns.map(key => String(row[key])).join(","))].join("\n") + "\n");
const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const warm = samples.filter(row => row.cohort === "warm");
const cold = samples.filter(row => row.cohort === "cold");
const warmMs = warm.map(row => row.elapsed_ms);
const coldMs = cold.map(row => row.elapsed_ms);
const warmMedian = median(warmMs);
const coldMedian = median(coldMs);
const overlap = Math.max(Math.min(...warmMs), Math.min(...coldMs)) <= Math.min(Math.max(...warmMs), Math.max(...coldMs));
const summary = {
  source: "fresh raw/b-{warm,cold}-{1,2,3}-events.jsonl", timingBoundary: "session_compact.atNs - before_compact.atNs",
  sampleIds: pairIds, sampleCount: samples.length,
  elapsedNsIdentityVerified: samples.every(row => BigInt(row.session_compact_ns) - BigInt(row.before_compact_ns) === BigInt(row.elapsed_ns)),
  semanticHistoryMatchAllPairs: pairIntegrity.every(pair => pair.warmHistoryMatch && pair.coldHistoryMatch),
  warm: { elapsedMs: warmMs, medianMs: warmMedian, minMs: Math.min(...warmMs), maxMs: Math.max(...warmMs), cacheReadTokens: warm.map(row => row.cache_read_tokens), cacheHit: warm.map(row => row.cache_hit) },
  cold: { elapsedMs: coldMs, medianMs: coldMedian, minMs: Math.min(...coldMs), maxMs: Math.max(...coldMs), cacheTelemetry: "absent; never coerced to zero" },
  rangesOverlap: overlap, medianDeltaMsColdMinusWarm: coldMedian - warmMedian,
  warmOverColdMedianRatio: warmMedian / coldMedian, coldOverWarmMedianRatio: coldMedian / warmMedian,
  medianLatencyReductionPercent: (1 - warmMedian / coldMedian) * 100,
};
writeFileSync(join(root, "public/benchmark-summary.json"), JSON.stringify(summary, null, 2) + "\n");
const integrity = {
  scenarioA: {
    session: aSession, backup: aBackup,
    backupIsBytePrefixOfSession: sessionBytes.subarray(0, backupBytes.length).equals(backupBytes),
    durableLargeResultMatches: JSON.stringify(aSession.large) === JSON.stringify(aBackup.large),
    plannerViewLines: aBefore.lines, durableToolPhysicalLines: Number(aBlob.lines), diagnosticCount,
  },
  scenarioB: { pairIntegrity, normalRequestPayloadProof: warm.map(row => ({ sampleId: row.sample_id, inputItems: row.normal_request_input_items, inputBytes: row.normal_request_input_bytes, inputSha256: row.normal_request_input_sha256, repeatedItemHashKinds: row.normal_request_repeated_item_hash_kinds, requestBoundProviderInputTokens: row.request_bound_provider_input_tokens, requestTotalTokens: row.request_total_tokens })) },
};
writeFileSync(join(root, "public/functional-session-tool-integrity.json"), JSON.stringify(integrity, null, 2) + "\n");
const results = {
  runRoot: ".atomic/evidence/pr-1844-loop2-20260717", attribution: { head: "03157e16ba1e06aee9614ceb487b85038931fb1d", originMainAtStart: "a870f3f6feee4d52af5debab6b696908ea1dd4df", remotePrHeadAtStart: "65e9b233ead4b53c89b3ca27d1d87ee1ed0a11e1", compiledCliSha256: "222f4d1a9493043055bbca61d4f1e183a79f19741c8af56694d3cab7e4cd245e", bun: "1.3.14", tmux: "3.7b", model: "openai-codex/gpt-5.6-sol:off", providerContextWindow: 372000 },
  preflight: { build: "pass", modelListing: "pass", authSmokeExit: 0, authSmokeExact: "AUTH_OK", trackedAndIndexCleanAtStart: true },
  scenarioA: { tmuxSession: "pr1844-loop2-a-final", identity: { provider: aStart.provider, model: aStart.model, api: aStart.api }, blob: { lines: aBlob.lines, width: aBlob.width, chars: aBlob.chars, sha256: aBlob.sha256 }, providerMeasuredTokens: aTurn.totalTokens, localContextWindow: 262130, localPercent: Number(aTurn.totalTokens) / 262130 * 100, providerInputUnderHardCap: Number(aTurn.totalTokens) < 372000, projection: { lines: aBefore.lines, tokens: aBefore.tokensBefore, durableToolPhysicalLines: aBlob.lines }, autoCompaction: { reason: aCompact.reason, format: aCompact.format, promptVersion: aCompact.promptVersion, rung: aCompact.rung, backupBasename: basename(String(aCompact.backupPath)), stats: aCompact.stats, backupExists: statSync(aBackupPath).isFile(), failureDiagnosticCount: diagnosticCount }, rawPreservation: integrity.scenarioA, continuationExact: "CONTINUATION_OK pr1844-loop2-functional" },
  scenarioB: { successfulSamples: { warm: 3, cold: 3 }, sampleIds: pairIds, workload: { alternatingPairs: 8, physicalLinesPerMessage: 40, compressionRatio: 0.05 }, ...summary, requestProofScope: "The normal request hook exposes safe input-item hashes/counts and request-bound usage. The direct compaction planner transport does not re-emit that extension hook; no hidden suffix telemetry is invented. One persisted compaction boundary per retained session and native cache-hit telemetry are separately verified.", conclusion: overlap ? "Warm and cold ranges overlap; do not claim a decisive latency benefit despite the median." : "No retained warm/cold latency overlap; this run supports a warm latency benefit, subject to provider variance." },
  failures: ["Scenario A first attempt disabled the extension tool with --no-tools and timed out; preserved privately, corrected final session used an extension-only allowlist.", "Malformed warm planner output occurred in pair 2's initial attempt, a pair 3 attempt, and pair 1's first payload-proof attempt; preserved panes/events identify each and retries used the identical declared workload without relabeling.", "Payload-proof rollout initially expected a second extension hook from direct compaction transport; successful superseded samples and the mistaken criterion are preserved. Retained samples use available normal-request scalar proofs only.", "Retry collection replaced failed session directories after preserving panes/events, so provider-generated diagnostic JSON named in those panes is not retained; no diagnostic content or outcome is reconstructed."],
};
writeFileSync(join(root, "public/results.json"), JSON.stringify(results, null, 2) + "\n");
