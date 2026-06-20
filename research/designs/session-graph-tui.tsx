/** @jsxImportSource @opentui/react */
/**
 * Atomic — Session Graph TUI
 *
 * OpenTUI React prototype of the orchestrator session graph view.
 * Run: bun run research/designs/session-graph-tui.tsx
 * Exit: q or Esc
 *
 * Design: Critique-inspired semantic theming · Catppuccin Mocha
 * Rounded borders · Neovim-style statusline · braille spinner
 */

import { createCliRenderer, ScrollBoxRenderable } from "@opentui/core";
import {
  createRoot,
  useKeyboard,
  useTerminalDimensions,
  useRenderer,
} from "@opentui/react";
import { useState, useEffect, useMemo, useCallback, useRef } from "react";

// ─── Theme ──────────────────────────────────────

import {
  ERR_H,
  H_GAP,
  NODE_H,
  NODE_W,
  PAD,
  SESSIONS,
  V_GAP,
  buildConnector,
  color,
  computeLayout,
  fmtDur,
  icon,
  label,
  theme,
  type ConnectorResult,
  type Session,
} from "./session-graph-data.js";
function NodeCard({
  node,
  focused,
  pulsePhase,
  displayH,
}: {
  node: LayoutNode;
  focused: boolean;
  pulsePhase: number;
  displayH: number;
}) {
  const statusColor = color(node.status);
  const isPending = node.status === "pending";
  const isRunning = node.status === "running";
  const nodeIcon = icon(node.status);

  // Border: running nodes smoothly pulse, others show status color
  let borderCol: string;
  if (isRunning) {
    const t = (Math.sin((pulsePhase / 32) * Math.PI * 2 - Math.PI / 2) + 1) / 2;
    borderCol = focused
      ? lerpColor(theme.warning, "#ffffff", 0.2)
      : lerpColor(theme.border, theme.warning, t);
  } else if (isPending) {
    borderCol = focused ? statusColor : theme.borderActive;
  } else {
    borderCol = statusColor;
  }

  // Background: focused nodes get a subtle status-colored tint
  const bgCol = focused
    ? lerpColor(theme.background, statusColor, 0.12)
    : "transparent";

  // Text hierarchy: focused nodes get full brightness, pending recedes
  const nameCol = focused ? "#ffffff" : (isPending ? theme.textDim : theme.text);
  const metaCol = isPending ? theme.textDim : theme.textMuted;
  const durCol  = isPending ? theme.textDim : statusColor;

  return (
    <box
      position="absolute"
      left={node.x}
      top={node.y}
      width={NODE_W}
      height={displayH}
      border
      borderStyle="rounded"
      borderColor={borderCol}
      backgroundColor={bgCol}
      flexDirection="column"
      justifyContent="center"
      title={` ${node.name} `}
      titleAlignment="center"
    >
      {/* Duration only — border color conveys status */}
      <box alignItems="center">
        <text fg={durCol}>{node.duration}</text>
      </box>
    </box>
  );
}

function Edge({ text, col, row, width, height, color: edgeColor }: ConnectorResult) {
  return (
    <box position="absolute" left={col} top={row} width={width} height={height}>
      <text fg={edgeColor}>{text}</text>
    </box>
  );
}

function Header({
  sessions,
}: {
  sessions: Session[];
}) {
  const counts: Record<string, number> = { complete: 0, running: 0, pending: 0, error: 0 };
  for (const s of sessions) counts[s.status] = (counts[s.status] ?? 0) + 1;

  return (
    <box
      height={1}
      backgroundColor={theme.backgroundElement}
      flexDirection="row"
      paddingRight={2}
      alignItems="center"
    >
      <text><span fg={theme.backgroundElement} bg={theme.info}><strong> Orchestrator </strong></span></text>

      <box flexGrow={1} justifyContent="flex-end" flexDirection="row" gap={2}>
        {counts.complete > 0 ? (
          <text><span fg={theme.success}>✓ {counts.complete}</span></text>
        ) : null}
        {counts.running > 0 ? (
          <text><span fg={theme.warning}>● {counts.running}</span></text>
        ) : null}
        {counts.pending > 0 ? (
          <text><span fg={theme.textDim}>○ {counts.pending}</span></text>
        ) : null}
        {counts.error > 0 ? (
          <text><span fg={theme.error}>✗ {counts.error}</span></text>
        ) : null}
      </box>
    </box>
  );
}

function Statusline({
  focusedNode,
  attachMsg,
}: {
  focusedNode: LayoutNode | undefined;
  attachMsg: string;
}) {
  const nodeIcon = focusedNode ? icon(focusedNode.status) : "";
  const nodeColor = focusedNode ? color(focusedNode.status) : theme.textDim;

  return (
    <box height={1} flexDirection="row" backgroundColor={theme.backgroundElement}>
      <box backgroundColor={theme.primary} paddingLeft={1} paddingRight={1} alignItems="center">
        <text fg={theme.backgroundElement}><strong>GRAPH</strong></text>
      </box>

      {focusedNode ? (
        <box backgroundColor="transparent" paddingLeft={1} paddingRight={1} alignItems="center">
          <text>
            <span fg={nodeColor}>{nodeIcon} </span>
            <span fg={theme.text}>{focusedNode.name}</span>
            <span fg={theme.textMuted}> · {label(focusedNode.status)}</span>
            <span fg={theme.textDim}> · tmux {focusedNode.tmux}</span>
          </text>
        </box>
      ) : null}

      <box flexGrow={1} />

      <box paddingRight={2} alignItems="center">
        {attachMsg ? (
          <text fg={theme.text}><strong>{attachMsg}</strong></text>
        ) : (
          <text>
            <span fg={theme.text}>↑ ↓ ← →</span>
            <span fg={theme.textMuted}> navigate</span>
            <span fg={theme.textDim}> · </span>
            <span fg={theme.text}>↵</span>
            <span fg={theme.textMuted}> attach</span>
          </text>
        )}
      </box>
    </box>
  );
}

// ─── App ────────────────────────────────────────

function SessionGraph() {
  const renderer = useRenderer();
  const { width: termW, height: termH } = useTerminalDimensions();

  const layout = useMemo(() => computeLayout(SESSIONS), []);
  const nodeList = useMemo(() => Object.values(layout.map), [layout]);

  const connectors = useMemo(() => {
    const result: ConnectorResult[] = [];
    for (const n of nodeList) {
      const conn = buildConnector(n, layout.rowH);
      if (conn) result.push(conn);
    }
    return result;
  }, [nodeList, layout.rowH]);

  // Focus
  const [focusedId, setFocusedId] = useState(SESSIONS[0]?.id ?? "");

  // Smooth pulse phase for running nodes (sine wave, 2s cycle)
  const [pulsePhase, setPulsePhase] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setPulsePhase((p: number) => (p + 1) % 32), 60);
    return () => clearInterval(id);
  }, []);

  // Live timers (1s)
  const [durations, setDurations] = useState<Record<string, string>>(() => {
    const d: Record<string, string> = {};
    SESSIONS.forEach(s => { d[s.id] = s.duration; });
    return d;
  });

  const timerSecsRef = useMemo(() => {
    const t: Record<string, number | null> = {};
    SESSIONS.forEach(s => { t[s.id] = parseDur(s.duration); });
    return t;
  }, []);

  useEffect(() => {
    const id = setInterval(() => {
      let changed = false;
      for (const s of SESSIONS) {
        if (s.status === "running" && timerSecsRef[s.id] !== null) {
          timerSecsRef[s.id] = (timerSecsRef[s.id] ?? 0) + 1;
          changed = true;
        }
      }
      if (changed) {
        setDurations((prev: Record<string, string>) => {
          const next = { ...prev };
          for (const s of SESSIONS) {
            if (s.status === "running") next[s.id] = fmtDur(timerSecsRef[s.id] ?? null);
          }
          return next;
        });
      }
    }, 1000);
    return () => clearInterval(id);
  }, [timerSecsRef]);

  // Attach flash message
  const [attachMsg, setAttachMsg] = useState("");
  const attachTimerRef = useMemo(() => ({ id: null as ReturnType<typeof setTimeout> | null }), []);

  const doAttach = useCallback((id: string) => {
    const n = layout.map[id];
    if (!n) return;
    if (attachTimerRef.id) clearTimeout(attachTimerRef.id);
    setAttachMsg(`→ ${n.name} · ${n.tmux}`);
    attachTimerRef.id = setTimeout(() => setAttachMsg(""), 2400);
  }, [layout.map, attachTimerRef]);

  // Spatial navigation
  const navigate = useCallback((dir: "left" | "right" | "up" | "down") => {
    const cur = layout.map[focusedId];
    if (!cur) return;
    const cx = cur.x + NODE_W / 2;
    const cy = cur.y + NODE_H / 2;
    let best: LayoutNode | null = null;
    let bestDist = Infinity;

    for (const n of nodeList) {
      if (n.id === focusedId) continue;
      const nx = n.x + NODE_W / 2;
      const ny = n.y + NODE_H / 2;
      const dx = nx - cx;
      const dy = ny - cy;

      let valid = false;
      if (dir === "left"  && dx < -1) valid = true;
      if (dir === "right" && dx >  1) valid = true;
      if (dir === "up"    && dy < -1) valid = true;
      if (dir === "down"  && dy >  1) valid = true;
      if (!valid) continue;

      const dist = (dir === "left" || dir === "right")
        ? Math.abs(dx) + Math.abs(dy) * 3
        : Math.abs(dy) + Math.abs(dx) * 3;
      if (dist < bestDist) { bestDist = dist; best = n; }
    }

    if (best) setFocusedId(best.id);
  }, [focusedId, layout.map, nodeList]);

  // gg double-tap tracking
  const lastKeyRef = useMemo(() => ({ key: "", time: 0 }), []);

  // Keyboard
  useKeyboard((key) => {
    // Arrows + hjkl
    if (key.name === "left"  || key.name === "h") navigate("left");
    if (key.name === "right" || key.name === "l") navigate("right");
    if (key.name === "up"    || key.name === "k") navigate("up");
    if (key.name === "down"  || key.name === "j") navigate("down");
    if (key.name === "tab") navigate(key.shift ? "left" : "right");

    // Enter: attach to focused node
    if (key.name === "return") {
      setFocusedId((prev: string) => { doAttach(prev); return prev; });
    }

    // G: focus deepest leaf (rightmost in DFS order)
    if (key.name === "g" && key.shift) {
      let deepest: LayoutNode | null = null;
      for (const n of nodeList) {
        if (!deepest || n.depth > deepest.depth || (n.depth === deepest.depth && n.x > deepest.x)) {
          deepest = n;
        }
      }
      if (deepest) setFocusedId(deepest.id);
      return;
    }

    // gg: focus root (double-tap within 300ms)
    if (key.name === "g" && !key.shift) {
      const now = Date.now();
      if (lastKeyRef.key === "g" && now - lastKeyRef.time < 300) {
        setFocusedId(SESSIONS[0]?.id ?? "");
        lastKeyRef.key = "";
      } else {
        lastKeyRef.key = "g";
        lastKeyRef.time = now;
      }
      return;
    }

    if (key.name === "q" || key.name === "escape") renderer.destroy();
  });

  // Scrollbox ref for programmatic scrolling
  const scrollboxRef = useRef<ScrollBoxRenderable | null>(null);

  // Auto-scroll to keep focused node visible
  const focused = layout.map[focusedId];
  useEffect(() => {
    const sb = scrollboxRef.current;
    if (!sb || !focused) return;
    const targetX = Math.max(0, focused.x + NODE_W / 2 - Math.floor(termW / 2));
    const targetY = Math.max(0, focused.y + NODE_H / 2 - Math.floor((termH - 2) / 2));
    sb.scrollTo({ x: targetX, y: targetY });
  }, [focusedId, focused, termW, termH]);

  return (
    <box width="100%" height="100%" flexDirection="column" backgroundColor={theme.background}>
      <Header sessions={SESSIONS} />

      {/* Graph canvas — scrollable both axes */}
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
            showArrows: false,
            trackOptions: {
              foregroundColor: theme.borderActive,
              backgroundColor: theme.background,
            },
          },
        }}
      >
        <box
          width={layout.width}
          height={layout.height}
          position="relative"
        >
          {/* Connectors */}
          {connectors.map((conn, i) => (
            <Edge key={`e${i}`} {...conn} />
          ))}

          {/* Node cards */}
          {nodeList.map(n => (
            <NodeCard
              key={n.id}
              node={{ ...n, duration: durations[n.id] ?? n.duration }}
              focused={n.id === focusedId}
              pulsePhase={pulsePhase}
              displayH={layout.rowH[n.depth] ?? NODE_H}
            />
          ))}
        </box>
      </scrollbox>

      <Statusline focusedNode={focused} attachMsg={attachMsg} />
    </box>
  );
}

// ─── Entry ──────────────────────────────────────

const renderer = await createCliRenderer({ exitOnCtrlC: false });
createRoot(renderer).render(<SessionGraph />);
