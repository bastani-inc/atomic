/**
 * Intercom routing: builds IntercomControlCallbacks that wire store/ui/emit.
 *
 * `buildIntercomCallbacks` is the pure factory consumed by extension/index.ts.
 * Keeping it separate makes unit testing trivial (no full pi surface needed).
 *
 * cross-ref: spec §5.10, RFC §8.1 Phase G
 */

import type { Store } from "../../store.js";
import type { NoticeLevel } from "../../store-types.js";
import type { IntercomControlCallbacks, IntercomControlPayload } from "./result-intercom.js";

// ---------------------------------------------------------------------------
// Dependency surface
// ---------------------------------------------------------------------------

/**
 * Minimal deps injected by the extension factory.
 * Separating them makes the logic independently testable.
 */
export interface IntercomRoutingDeps {
  /** Workflow store — for recordNotice / ackNotice. */
  store: Store;
  /**
   * Raw pi events emit — used to fire `subagent:control-intercom:response`.
   * `undefined` when pi.events.emit is not available.
   */
  emit: ((event: string, payload: Record<string, unknown>) => void) | undefined;
  /**
   * Pi confirm dialog with separate title + message args.
   * `undefined` when pi.ui.confirm is absent.
   */
  confirm: ((title: string, message: string) => Promise<boolean>) | undefined;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toNoticeLevel(raw: unknown): NoticeLevel {
  if (raw === "warning" || raw === "error") return raw;
  return "info";
}

function makeId(): string {
  // crypto.randomUUID() is available globally in Bun and Node ≥ 16.
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// Callback builder
// ---------------------------------------------------------------------------

/**
 * Builds `IntercomControlCallbacks` wired to the given deps.
 *
 * - `need_decision`:
 *     1. Record a notice with `requiresAck: true` (level: "warning").
 *     2. Surface `pi.ui.confirm("Subagent needs decision", payload.message)`.
 *     3. Emit `subagent:control-intercom:response` with
 *        `{ requestId, runId, stageId, accepted }`.
 *     4. Ack the notice.
 *
 * - `notify`:
 *     Record a notice at `payload.level` (info/warning/error, defaults to info).
 *
 * - unknown / malformed:
 *     Record a warning notice. No ack, no emit.
 */
export function buildIntercomCallbacks(deps: IntercomRoutingDeps): IntercomControlCallbacks {
  const { store, emit, confirm } = deps;

  return {
    async onNeedDecision(payload: IntercomControlPayload): Promise<void> {
      const noticeId = makeId();

      store.recordNotice({
        id: noticeId,
        runId: payload.runId,
        stageId: payload.stageId,
        level: "warning",
        message: payload.message,
        createdAt: Date.now(),
        requiresAck: true,
      });

      const accepted: boolean =
        typeof confirm === "function"
          ? await confirm("Subagent needs decision", payload.message).catch(() => false)
          : false;

      emit?.("subagent:control-intercom:response", {
        requestId: payload.requestId ?? "",
        runId: payload.runId ?? "",
        stageId: payload.stageId ?? "",
        accepted,
      });

      store.ackNotice(noticeId);
    },

    onNotify(payload: IntercomControlPayload): void {
      store.recordNotice({
        id: makeId(),
        runId: payload.runId,
        stageId: payload.stageId,
        level: toNoticeLevel(payload.level),
        message: payload.message,
        createdAt: Date.now(),
      });
    },

    onUnknown(payload: IntercomControlPayload): void {
      store.recordNotice({
        id: makeId(),
        runId: payload.runId,
        stageId: payload.stageId,
        level: "warning",
        message: `Unknown intercom type "${payload.type}": ${payload.message}`,
        createdAt: Date.now(),
      });
    },
  };
}
