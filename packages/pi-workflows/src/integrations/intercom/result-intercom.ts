/**
 * pi-intercom result routing: subagent:control-intercom → UI/store callbacks.
 *
 * Responsibilities:
 *  Subscribes to `pi.events.on("subagent:control-intercom", ...)` (the channel
 *  pi-subagents uses when a child calls `contact_supervisor`).  When a child
 *  sub-agent of a workflow stage escalates, this module routes the event to
 *  the appropriate callback:
 *    - `onNeedDecision` → surfaces a blocking confirm dialog (ctx.ui.confirm)
 *    - `onNotify`       → surfaces a non-blocking notice in the workflow overlay
 *
 * No-op when the events bus or subscription method is absent.
 *
 * cross-ref: pi-subagents src/intercom/result-intercom.ts
 * cross-ref: spec §5.10 Integration with pi-intercom, §8.1 Phase G
 */

// ---------------------------------------------------------------------------
// Minimal structural types
// ---------------------------------------------------------------------------

/** Minimal pi events bus surface used by this module. */
export interface PiEventBus {
  on?: (event: string, handler: (payload: unknown) => void) => void;
}

/** Minimal ExtensionAPI surface expected by result-intercom module. */
export interface PiResultIntercomExtensionAPI {
  events?: PiEventBus;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Intercom control event payload
// ---------------------------------------------------------------------------

/**
 * Shape of the `subagent:control-intercom` event payload emitted by
 * pi-subagents when a child calls `contact_supervisor`.
 *
 * Both `type` and `message` are required. Additional fields are forwarded
 * opaquely to callbacks.
 */
export interface IntercomControlPayload {
  /** Escalation kind: a blocking decision request or an informational notice. */
  type: "need_decision" | "notify" | string;
  /** Human-readable message from the child agent. */
  message: string;
  /** Originating run/stage context if the child is inside a workflow. */
  runId?: string;
  stageId?: string;
  /** The child agent's identifier (pi-subagents populates this). */
  agentId?: string;
  /** Arbitrary extra fields forwarded from pi-subagents. */
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Callback types
// ---------------------------------------------------------------------------

/**
 * Called when the child requests a blocking decision from the user.
 * Implementors should display `ctx.ui.confirm`-style UI.
 */
export type OnNeedDecision = (payload: IntercomControlPayload) => void | Promise<void>;

/**
 * Called for non-blocking notifications (e.g. status updates from the child).
 * Implementors should surface these in the workflow overlay.
 */
export type OnNotify = (payload: IntercomControlPayload) => void | Promise<void>;

/** Callback bag passed to `subscribeIntercomControl`. */
export interface IntercomControlCallbacks {
  onNeedDecision?: OnNeedDecision;
  onNotify?: OnNotify;
  /**
   * Fallback called for unknown `type` values — useful for forward
   * compatibility as pi-subagents adds new escalation kinds.
   */
  onUnknown?: (payload: IntercomControlPayload) => void | Promise<void>;
}

// ---------------------------------------------------------------------------
// Subscription
// ---------------------------------------------------------------------------

/**
 * Subscribes to `subagent:control-intercom` events on `pi.events` and routes
 * each incoming payload to the appropriate callback.
 *
 * - No-op when `pi.events?.on` is absent (events bus not supported).
 * - Each individual callback error is caught and re-thrown asynchronously so
 *   one bad callback cannot prevent others from running.
 *
 * @returns A cleanup / unsubscribe function. Call it to stop routing.
 *          Returns `null` when the subscription could not be established.
 */
export function subscribeIntercomControl(
  pi: PiResultIntercomExtensionAPI,
  callbacks: IntercomControlCallbacks,
): (() => void) | null {
  if (typeof pi.events?.on !== "function") return null;

  let active = true;

  const handler = (rawPayload: unknown): void => {
    if (!active) return;

    // Coerce to typed payload — we trust pi-subagents' contract but guard
    // defensively against malformed emissions.
    const payload = rawPayload as IntercomControlPayload;

    if (!payload || typeof payload !== "object" || typeof payload.type !== "string") return;

    const dispatch = (): Promise<void> => {
      switch (payload.type) {
        case "need_decision":
          return Promise.resolve(callbacks.onNeedDecision?.(payload));
        case "notify":
          return Promise.resolve(callbacks.onNotify?.(payload));
        default:
          return Promise.resolve(callbacks.onUnknown?.(payload));
      }
    };

    dispatch().catch((err) => {
      // Surface errors without breaking the event loop.
      Promise.reject(
        new Error(
          `pi-workflows intercom callback error (type=${payload.type}): ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    });
  };

  pi.events!.on!("subagent:control-intercom", handler);

  return () => {
    active = false;
  };
}
