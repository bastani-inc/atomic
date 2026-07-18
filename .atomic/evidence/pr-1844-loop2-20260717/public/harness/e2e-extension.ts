import { appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Type } from "@earendil-works/pi-ai/compat";
import { spawnSync } from "node:child_process";
import { Text } from "@earendil-works/pi-tui";
import { defineTool, type ExtensionAPI } from "@bastani/atomic";

const logPath = process.env.PR1844_LOOP2_EVENT_LOG;
const signalPrefix = process.env.PR1844_LOOP2_SIGNAL_PREFIX;
const signal = (name: string): void => {
  if (!signalPrefix) return;
  spawnSync("tmux", ["wait-for", "-S", `${signalPrefix}-${name}`], { stdio: "ignore" });
};
const localWindow = Number(process.env.PR1844_LOOP2_LOCAL_WINDOW ?? "0");
const emit = (record: Record<string, unknown>): void => {
  if (!logPath) return;
  appendFileSync(logPath, `${JSON.stringify({ atNs: process.hrtime.bigint().toString(), ...record })}\n`, { mode: 0o600 });
};

const hashJson = (value: object): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const payloadProof = (payload: unknown): Record<string, unknown> => {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return { inputItems: 0, inputProofAvailable: false };
  const input = (payload as Record<string, unknown>).input;
  if (!Array.isArray(input)) return { inputItems: 0, inputProofAvailable: false };
  const itemHashes = input.map(item => hashJson({ item }));
  const counts = new Map<string, number>();
  for (const hash of itemHashes) counts.set(hash, (counts.get(hash) ?? 0) + 1);
  return {
    inputProofAvailable: true,
    inputItems: input.length,
    inputBytes: Buffer.byteLength(JSON.stringify(input)),
    inputSha256: hashJson({ input }),
    prefixExcludingLastSha256: hashJson({ input: input.slice(0, -1) }),
    lastItemSha256: itemHashes.at(-1),
    uniqueItemHashes: counts.size,
    repeatedItemHashKinds: [...counts.values()].filter(count => count > 1).length,
  };
};

function blob(lines: number, width: number): string {
  let state = 0x1844cafe >>> 0;
  const rows: string[] = [];
  for (let index = 1; index <= lines; index++) {
    let body = "";
    while (body.length < width) {
      state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
      body += (state >>> 0).toString(16).padStart(8, "0");
    }
    rows.push(`${String(index).padStart(6, "0")}:${body.slice(0, width)}`);
  }
  return rows.join("\n");
}

const tool = defineTool({
  name: "e2e_blob",
  label: "E2E blob",
  description: "Generate deterministic numbered non-secret text. Call exactly once when requested.",
  parameters: Type.Object({
    lines: Type.Integer({ minimum: 1, maximum: 20000 }),
    width: Type.Integer({ minimum: 8, maximum: 128 }),
  }),
  maxResultSizeChars: Infinity,
  async execute(_id, params) {
    const text = blob(params.lines, params.width);
    const sha256 = createHash("sha256").update(text).digest("hex");
    emit({ type: "blob", lines: params.lines, width: params.width, chars: text.length, sha256 });
    signal("blob");
    return { content: [{ type: "text" as const, text }], details: { lines: params.lines, chars: text.length, sha256 } };
  },
  renderCall(args, theme) {
    return new Text(theme.fg("toolTitle", `e2e_blob lines=${args.lines} width=${args.width}`), 0, 0);
  },
  renderResult(result, _options, theme) {
    const d = result.details as { lines?: number; chars?: number; sha256?: string } | undefined;
    return new Text(theme.fg("success", `generated lines=${d?.lines} chars=${d?.chars} sha256=${d?.sha256}`), 0, 0);
  },
});

export default function extension(pi: ExtensionAPI): void {
  pi.registerTool(tool);
  pi.on("before_provider_request", async (event) => {
    emit({ type: "provider_request", ...payloadProof(event.payload) });
  });
  pi.on("session_start", async (_event, ctx) => {
    if (localWindow > 0 && ctx.model) ctx.model.contextWindow = localWindow;
    emit({ type: "session_start", localWindow: ctx.model?.contextWindow, provider: ctx.model?.provider, model: ctx.model?.id, api: ctx.model?.api });
    signal("session-start");
  });
  pi.on("turn_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return;
    const usage = event.message.usage;
    emit({ type: "turn_end", turn: event.turnIndex, stopReason: event.message.stopReason,
      input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite,
      totalTokens: usage.totalTokens, contextUsage: ctx.getContextUsage() });
    signal(`turn-${event.turnIndex}`);
  });
  pi.on("session_before_compact", async (event) => {
    emit({ type: "before_compact", reason: event.reason, lines: event.preparation.region.lines.length,
      tokensBefore: event.preparation.tokensBefore, format: "format" in event.preparation ? event.preparation.format : undefined });
    signal("before-compact");
  });
  pi.on("session_compact", async (event) => {
    emit({ type: "session_compact", reason: event.reason, format: event.result.format,
      promptVersion: event.result.promptVersion, rung: event.result.rung, backupPath: event.result.backupPath,
      stats: event.result.stats, cache: event.result.cache });
    signal("compacted");
  });
}
