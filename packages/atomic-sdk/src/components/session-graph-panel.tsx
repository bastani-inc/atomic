/** @jsxImportSource @opentui/react */
/**
 * Main graph component — renders the navigable session tree with
 * keyboard navigation, scroll management, and live animations.
 */

import type { ScrollBoxRenderable } from "@opentui/core";
import {
  useKeyboard,
  useTerminalDimensions,
  useRenderer,
} from "@opentui/react";
import {
  useState,
  useEffect,
  useMemo,
  useCallback,
  useRef,
  useContext,
} from "react";
import {
  useStore,
  useGraphTheme,
  useStoreVersion,
  TmuxSessionContext,
  useOffloadManager,
} from "./orchestrator-panel-contexts.ts";
import { errorMessage } from "../errors.ts";
import { computeLayout, NODE_W, NODE_H, type LayoutNode } from "./layout.ts";
import { buildConnector, buildMergeConnector } from "./connectors.ts";
import type { ConnectorResult } from "./connectors.ts";
import { NodeCard } from "./node-card.tsx";
import { Edge } from "./edge.tsx";
import { Header } from "./header.tsx";
import { CompactSwitcher } from "./compact-switcher.tsx";
import { ToastStack } from "./toast.tsx";
import type { ViewMode } from "./orchestrator-panel-types.ts";

/** Interval (ms) between pulse animation frames — ~60fps feel. */
const PULSE_INTERVAL_MS = 60;
/** Total frames in one pulse cycle (~2s at 60ms/frame). */
const PULSE_FRAME_COUNT = 32;
/** Timeout (ms) for "gg" double-tap to jump to root node. */
const GG_DOUBLE_TAP_MS = 300;

// ─── RFC §5.5 pure decision helper ───────────────────────────────────────────

/**
 * Decide what action to take when the user attempts to attach to a session.
 * Pure function — no side effects, fully testable in isolation.
 *
 * Returns:
 *   { kind: "skip" }              — node not found or session pending
 *   { kind: "graphView" }         — id === "orchestrator"
 *   { kind: "resume" }            — session is offloaded or resuming
 *   { kind: "switchClient" }      — session is alive; issue switch-client
 */
export type AttachDecision =
  | { kind: "skip" }
  | { kind: "graphView" }
  | { kind: "resume" }
  | { kind: "switchClient" };

export function decideAttachAction(
  id: string,
  offloadStatus: "alive" | "offloaded" | "resuming",
): AttachDecision {
  if (id === "orchestrator") return { kind: "graphView" };
  if (offloadStatus === "offloaded" || offloadStatus === "resuming") return { kind: "resume" };
  return { kind: "switchClient" };
}

export function SessionGraphPanel() {
  const store = useStore();
  const theme = useGraphTheme();
  const tmuxSession = useContext(TmuxSessionContext);
  const offloadManager = useOffloadManager();
  useRenderer();
  const { width: termW, height: termH } = useTerminalDimensions();

  const storeVersion = useStoreVersion(store);

  // Compute layout from current session data
  const layout = useMemo(() => computeLayout(store.sessions), [storeVersion]);
  const nodeList = useMemo(() => Object.values(layout.map), [layout]);

  const connectors = useMemo(() => {
    const result: ConnectorResult[] = [];
    for (const n of nodeList) {
      // Fan-out: parent → children
      const conn = buildConnector(n, layout.rowH, theme);
      if (conn) result.push(conn);
      // Fan-in: multiple parents → merge child
      if (n.parents.length > 1) {
        const mergeConn = buildMergeConnector(n, layout.rowH, layout.map, theme);
        if (mergeConn) result.push(mergeConn);
      }
    }
    return result;
  }, [nodeList, layout.rowH, theme]);

  // Focus tracking
  const [focusedId, setFocusedId] = useState("");
  const focusedIdRef = useRef(focusedId);
  focusedIdRef.current = focusedId;

  // Compact switcher state
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [switcherSel, setSwitcherSel] = useState(0);

  // Update focus when sessions first appear
  useEffect(() => {
    if (store.sessions.length > 0 && !layout.map[focusedId]) {
      setFocusedId(store.sessions[0]!.name);
    }
  }, [storeVersion]);

  // Pulse animation for running nodes — paused when nothing is running
  const hasRunning = useMemo(
    () => store.sessions.some((s) => s.status === "running" || s.status === "awaiting_input"),
    [storeVersion],
  );
  const [pulsePhase, setPulsePhase] = useState(0);
  // Pulse animation doubles as a live timer refresh — 60ms updates keep
  // both the pulse animation and duration displays current, so a separate
  // 1s tick interval is unnecessary.
  useEffect(() => {
    if (!hasRunning) return;
    const pulseId = setInterval(
      () => setPulsePhase((p: number) => (p + 1) % PULSE_FRAME_COUNT),
      PULSE_INTERVAL_MS,
    );
    return () => clearInterval(pulseId);
  }, [hasRunning]);

  const doAttach = useCallback(
    async (id: string) => {
      const n = layout.map[id];
      if (!n) return;
      // Only attach to started sessions (not pending)
      const session = store.sessions.find((s) => s.name === id);
      if (!session || session.status === "pending") return;

      // Orchestrator = the graph view itself
      if (id === "orchestrator") {
        store.setViewMode("graph");
        return;
      }

      setFocusedId(id);

      // RFC §5.5 — gate switch-client on resume completion when offloaded.
      const status = offloadManager.getStatus(id);
      if (status === "offloaded" || status === "resuming") {
        store.setViewMode("resuming", id);
        try {
          await offloadManager.requestResume(id);
          store.setViewMode("attached", id);
          // Resume succeeded — OffloadManager already issued selectWindow.
        } catch (err) {
          // OffloadManager already setSessionStatus(name, "offloaded") + emitted event.
          store.showToast(`Failed to resume ${id}: ${errorMessage(err)}`);
          // Stay on graph; do NOT issue switch-client against a dead window.
          store.setViewMode("graph");
        }
        return;
      }

      store.setViewMode("attached", id);
    },
    [layout.map, tmuxSession, offloadManager],
  );

  const returnToGraph = useCallback(() => {
    store.setViewMode("graph");
  }, []);

  const openSwitcher = useCallback(() => {
    // Pre-select the current agent or focused node
    const currentId = store.viewMode === "attached" ? store.activeAgentId : focusedIdRef.current;
    const idx = store.sessions.findIndex((s) => s.name === currentId);
    setSwitcherSel(Math.max(0, idx));
    setSwitcherOpen(true);
  }, []);

  const closeSwitcher = useCallback(() => {
    setSwitcherOpen(false);
    setSwitcherSel(0);
  }, []);

  // Spatial navigation
  const navigate = useCallback(
    (dir: "left" | "right" | "up" | "down") => {
      const cur = layout.map[focusedIdRef.current];
      if (!cur) return;
      const cx = cur.x + NODE_W / 2;
      const cy = cur.y + NODE_H / 2;
      let best: LayoutNode | null = null;
      let bestDist = Infinity;

      for (const n of nodeList) {
        if (n.name === focusedIdRef.current) continue;
        const nx = n.x + NODE_W / 2;
        const ny = n.y + NODE_H / 2;
        const dx = nx - cx;
        const dy = ny - cy;

        let valid = false;
        if (dir === "left" && dx < -1) valid = true;
        if (dir === "right" && dx > 1) valid = true;
        if (dir === "up" && dy < -1) valid = true;
        if (dir === "down" && dy > 1) valid = true;
        if (!valid) continue;

        // Weight: prefer movement along the intended axis
        const dist =
          dir === "left" || dir === "right"
            ? Math.abs(dx) + Math.abs(dy) * 3
            : Math.abs(dy) + Math.abs(dx) * 3;
        if (dist < bestDist) {
          bestDist = dist;
          best = n;
        }
      }

      if (best) setFocusedId(best.name);
    },
    [layout.map, nodeList],
  );

  // gg double-tap tracking (graph mode only)
  const lastKeyRef = useRef({ key: "", time: 0 });

  // Keyboard handling — with Ctrl+G return-to-graph and auto-reset
  useKeyboard((key) => {
    // ── Switcher open: intercept all keys ──
    if (switcherOpen) {
      if (key.name === "escape") {
        closeSwitcher();
        return;
      }
      if (key.name === "up" || key.name === "k") {
        setSwitcherSel((s) => Math.max(0, s - 1));
        return;
      }
      if (key.name === "down" || key.name === "j") {
        setSwitcherSel((s) => Math.min(store.sessions.length - 1, s + 1));
        return;
      }
      if (key.name === "return") {
        const agent = store.sessions[switcherSel];
        closeSwitcher();
        if (agent) void doAttach(agent.name);
        return;
      }
      return; // Swallow all other keys while switcher is open
    }

    // ── Global: Ctrl+C or q quits ──
    if ((key.ctrl && key.name === "c") || key.name === "q") {
      store.requestQuit();
      return;
    }

    // ── Auto-reset: receiving keys while "attached" means user returned to the orchestrator window ──
    if (store.viewMode === "attached") {
      returnToGraph();
      // Fall through to process the key in graph mode
    }

    // ── / opens agent switcher ──
    if (key.sequence === "/") {
      openSwitcher();
      return;
    }

    // ── Graph view navigation ──
    // Arrow keys + hjkl
    if (key.name === "left" || key.name === "h") {
      navigate("left");
      return;
    }
    if (key.name === "right" || key.name === "l") {
      navigate("right");
      return;
    }
    if (key.name === "up" || key.name === "k") {
      navigate("up");
      return;
    }
    if (key.name === "down" || key.name === "j") {
      navigate("down");
      return;
    }
    // Enter: attach to focused node's tmux window
    if (key.name === "return") {
      void doAttach(focusedIdRef.current);
      return;
    }

    // G: focus deepest leaf (rightmost in DFS order)
    if (key.name === "g" && key.shift) {
      let deepest: LayoutNode | null = null;
      for (const n of nodeList) {
        if (
          !deepest ||
          n.depth > deepest.depth ||
          (n.depth === deepest.depth && n.x > deepest.x)
        ) {
          deepest = n;
        }
      }
      if (deepest) setFocusedId(deepest.name);
      return;
    }

    // gg: focus root (double-tap within 300ms)
    if (key.name === "g" && !key.shift) {
      const now = Date.now();
      if (lastKeyRef.current.key === "g" && now - lastKeyRef.current.time < GG_DOUBLE_TAP_MS) {
        setFocusedId(store.sessions[0]?.name ?? "");
        lastKeyRef.current.key = "";
      } else {
        lastKeyRef.current.key = "g";
        lastKeyRef.current.time = now;
      }
      return;
    }
  });

  // Auto-scroll to keep focused node visible
  const scrollboxRef = useRef<ScrollBoxRenderable | null>(null);
  const focused = layout.map[focusedId];

  // Center the graph when it's smaller than the viewport.
  // viewportH = terminal height minus the panel's own header row (1).
  // The tmux status line at the very bottom is reserved by tmux outside
  // this pane, so it isn't subtracted here.
  const viewportH = Math.max(0, termH - 1);
  const padX = Math.max(0, Math.floor((termW - layout.width) / 2));
  const padY = Math.max(0, Math.floor((viewportH - layout.height) / 2));
  const canvasW = Math.max(layout.width, termW) + padX;
  const canvasH = Math.max(layout.height, viewportH) + padY;

  useEffect(() => {
    const sb = scrollboxRef.current;
    if (!sb || !focused) return;

    // Node bounds in canvas coordinates (with centering offset)
    const nodeLeft = focused.x + padX;
    const nodeTop = focused.y + padY;
    const nodeRight = nodeLeft + NODE_W;
    const nodeBottom = nodeTop + (layout.rowH[focused.depth] ?? NODE_H);

    // Current visible viewport bounds
    const curX = sb.scrollLeft;
    const curY = sb.scrollTop;
    const margin = 2;

    let targetX = curX;
    let targetY = curY;

    // Only scroll if the node extends outside the visible area
    if (nodeLeft - margin < curX) {
      targetX = Math.max(0, nodeLeft - margin);
    } else if (nodeRight + margin > curX + termW) {
      targetX = Math.max(0, nodeRight + margin - termW);
    }

    if (nodeTop - margin < curY) {
      targetY = Math.max(0, nodeTop - margin);
    } else if (nodeBottom + margin > curY + viewportH) {
      targetY = Math.max(0, nodeBottom + margin - viewportH);
    }

    if (targetX !== curX || targetY !== curY) {
      sb.scrollTo({ x: targetX, y: targetY });
    }
  }, [focusedId, focused, termW, termH, padX, padY, viewportH, layout.rowH]);


  return (
    <box width="100%" height="100%" flexDirection="column" backgroundColor={theme.background}>
      <Header />

      {/* Graph canvas — scrollable both axes, centered when smaller than viewport */}
      <scrollbox
        ref={scrollboxRef}
        scrollX
        scrollY
        focused
        style={{
          flexGrow: 1,
          rootOptions: {
            backgroundColor: theme.background,
            border: false,
          },
          contentOptions: {
            minHeight: 0,
            minWidth: 0,
          },
          scrollbarOptions: {
            visible: false,
            showArrows: false,
            trackOptions: {
              foregroundColor: theme.borderActive,
              backgroundColor: theme.background,
            },
          },
          horizontalScrollbarOptions: {
            visible: false,
            showArrows: false,
            trackOptions: {
              foregroundColor: theme.borderActive,
              backgroundColor: theme.background,
            },
          },
        }}
      >
        <box width={canvasW} height={canvasH} position="relative" backgroundColor={theme.background}>
          {/* Offset all content by padding to center the graph */}
          <box
            position="absolute"
            left={padX}
            top={padY}
            width={layout.width}
            height={layout.height}
            backgroundColor={theme.background}
          >
            {/* Connectors (rendered behind nodes) */}
            {connectors.map((conn, i) => (
              <Edge key={`e${i}`} {...conn} />
            ))}

            {/* Node cards */}
            {nodeList.map((n) => (
              <NodeCard
                key={n.name}
                node={n}
                focused={n.name === focusedId}
                pulsePhase={pulsePhase}
                displayH={layout.rowH[n.depth] ?? NODE_H}
              />
            ))}
          </box>
        </box>
      </scrollbox>

      {/* Compact agent switcher overlay */}
      {switcherOpen ? <CompactSwitcher selectedIndex={switcherSel} /> : null}

      {/* Toast notifications — top-right, auto-dismiss (RFC §5.5) */}
      <ToastStack />
    </box>
  );
}
