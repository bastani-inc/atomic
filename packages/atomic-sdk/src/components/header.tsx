/** @jsxImportSource @opentui/react */

import { useContext, useMemo } from "react";
import type { SessionStatus } from "./orchestrator-panel-types.ts";
import {
  useStore,
  useGraphTheme,
  useStoreVersion,
  TmuxSessionContext,
} from "./orchestrator-panel-contexts.ts";

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

  const counts = useMemo(() => {
    const c: Record<SessionStatus, number> = { complete: 0, running: 0, pending: 0, error: 0, awaiting_input: 0, offloaded: 0, resuming: 0 };
    for (const s of store.sessions) c[s.status]++;
    return c;
  }, [storeVersion]);

  const isFailed = store.fatalError !== null;
  const isDone = store.completionInfo !== null;
  const badgeColor = isFailed ? theme.error : isDone ? theme.success : theme.info;
  const badgeText = isFailed
    ? " \u2717 Failed "
    : isDone
      ? ` \u2713 ${store.workflowName} `
      : " Orchestrator ";

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

      <box flexGrow={1} justifyContent="flex-end" flexDirection="row" gap={2}>
        <CountBadge color={theme.success} backgroundColor={theme.backgroundElement} icon={"\u2713"} count={counts.complete} />
        <CountBadge color={theme.warning} backgroundColor={theme.backgroundElement} icon={"\u25CF"} count={counts.running} />
        <CountBadge color={theme.info} backgroundColor={theme.backgroundElement} icon={"?"} count={counts.awaiting_input} />
        <CountBadge color={theme.textDim} backgroundColor={theme.backgroundElement} icon={"\u25CB"} count={counts.pending} />
        <CountBadge color={theme.error} backgroundColor={theme.backgroundElement} icon={"\u2717"} count={counts.error} />
      </box>
    </box>
  );
}
