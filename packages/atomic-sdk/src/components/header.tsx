/** @jsxImportSource @opentui/react */

import { useContext, useEffect, useMemo, useState } from "react";
import type { SessionStatus } from "./orchestrator-panel-types.ts";
import {
  useStore,
  useGraphTheme,
  useStoreVersion,
  TmuxSessionContext,
} from "./orchestrator-panel-contexts.ts";
import { fmtDuration } from "./status-helpers.ts";

function CountBadge({
  color,
  icon,
  count,
  backgroundColor,
}: {
  color: string;
  icon: string;
  count: number;
  backgroundColor: string;
}) {
  if (count <= 0) return null;
  return (
    <text>
      <span fg={color} bg={backgroundColor}>{icon} {count}</span>
    </text>
  );
}

export function Header() {
  const store = useStore();
  const theme = useGraphTheme();
  const tmuxSession = useContext(TmuxSessionContext);
  const storeVersion = useStoreVersion(store);

  // Exclude the synthetic orchestrator entry from status counts — it's
  // workflow-timing bookkeeping, not a user-defined stage, and surfaces
  // separately as the workflow duration on the right.
  const counts = useMemo(() => {
    const c: Record<SessionStatus, number> = { complete: 0, running: 0, pending: 0, error: 0, awaiting_input: 0, offloaded: 0, resuming: 0 };
    for (const s of store.sessions) {
      if (s.name === "orchestrator") continue;
      c[s.status]++;
    }
    return c;
  }, [storeVersion]);

  const isFailed = store.fatalError !== null;
  const isDone = store.completionInfo !== null;
  const isRunning = !isFailed && !isDone;
  const badgeColor = isFailed ? theme.error : isDone ? theme.success : theme.info;
  const badgeText = isFailed
    ? " \u2717 Failed "
    : isDone
      ? ` \u2713 ${store.workflowName} `
      : " Orchestrator ";

  // Workflow duration — derived from the orchestrator session's timing
  // (startedAt set on workflow start, endedAt set on completion/failure).
  // While running, a 1s ticker drives re-renders so the display stays live;
  // when terminal, the value freezes at endedAt and the ticker stops.
  const orchestrator = useMemo(
    () => store.sessions.find((s) => s.name === "orchestrator"),
    [storeVersion],
  );
  const [tickNow, setTickNow] = useState(() => Date.now());
  useEffect(() => {
    if (!isRunning || !orchestrator?.startedAt) return;
    const id = setInterval(() => setTickNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isRunning, orchestrator?.startedAt]);

  const durationText = useMemo(() => {
    if (!orchestrator?.startedAt) return "";
    const end = orchestrator.endedAt ?? tickNow;
    return fmtDuration(end - orchestrator.startedAt);
  }, [orchestrator?.startedAt, orchestrator?.endedAt, tickNow]);
  const durationColor = isFailed
    ? theme.error
    : isDone
      ? theme.success
      : theme.textMuted;

  return (
    <box
      height={1}
      backgroundColor={theme.backgroundElement}
      flexDirection="row"
      paddingRight={2}
      alignItems="center"
    >
      <text>
        <span fg={theme.backgroundElement} bg={badgeColor}>
          <strong>{badgeText}</strong>
        </span>
      </text>

      {tmuxSession ? (
        <box paddingLeft={1} alignItems="center">
          <text>
            <span fg={theme.text} bg={theme.backgroundElement}>
              <strong>{tmuxSession}</strong>
            </span>
          </text>
        </box>
      ) : null}

      <box flexGrow={1} justifyContent="flex-end" flexDirection="row" gap={2} alignItems="center">
        <CountBadge color={theme.success} backgroundColor={theme.backgroundElement} icon={"\u2713"} count={counts.complete} />
        <CountBadge color={theme.warning} backgroundColor={theme.backgroundElement} icon={"\u25CF"} count={counts.running} />
        <CountBadge color={theme.info} backgroundColor={theme.backgroundElement} icon={"?"} count={counts.awaiting_input} />
        <CountBadge color={theme.textDim} backgroundColor={theme.backgroundElement} icon={"\u25CB"} count={counts.pending} />
        <CountBadge color={theme.error} backgroundColor={theme.backgroundElement} icon={"\u2717"} count={counts.error} />
        <CountBadge color={theme.textDim} backgroundColor={theme.backgroundElement} icon={"\u25cc"} count={counts.offloaded} />
        <CountBadge color={theme.warning} backgroundColor={theme.backgroundElement} icon={"\u25d0"} count={counts.resuming} />
        {durationText ? (
          <text>
            <span fg={durationColor} bg={theme.backgroundElement}>{durationText}</span>
          </text>
        ) : null}
      </box>
    </box>
  );
}
