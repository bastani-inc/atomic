/** @jsxImportSource @opentui/react */
/**
 * CompactSwitcher — a lightweight popup that lists all agents for quick
 * direct-jump navigation. Opened with "/" from any view mode.
 */

import { useStore, useGraphTheme, useStoreVersion } from "./orchestrator-panel-contexts.ts";
import { statusIcon, statusColor, fmtDuration } from "./status-helpers.ts";
import { lerpColor } from "./color-utils.ts";

export interface CompactSwitcherProps {
  selectedIndex: number;
}

export function CompactSwitcher({ selectedIndex }: CompactSwitcherProps) {
  const store = useStore();
  const theme = useGraphTheme();
  useStoreVersion(store);

  const agents = store.sessions;
  const headerHint = "\u2191\u2193 select \u00B7 \u21B5 jump \u00B7 Esc close";

  return (
    <box
      position="absolute"
      bottom={1}
      left={0}
      width={44}
      border
      borderStyle="rounded"
      borderColor={theme.borderActive}
      backgroundColor={theme.backgroundElement}
      flexDirection="column"
    >
      {/* Header */}
      <box height={1} flexDirection="row" paddingLeft={1} paddingRight={1}>
        <text fg={theme.textDim}>stages</text>
        <box flexGrow={1} />
        <text fg={theme.textDim}>{headerHint}</text>
      </box>

      {/* Agent list */}
      {agents.map((agent, i) => {
        const isSelected = i === selectedIndex;
        const icon = statusIcon(agent.status);
        const iconColor = statusColor(agent.status, theme);
        const rowBackground = isSelected
          ? lerpColor(theme.backgroundElement, theme.primary, 0.12)
          : theme.backgroundElement;
        const duration =
          agent.startedAt !== null
            ? fmtDuration((agent.endedAt ?? Date.now()) - agent.startedAt)
            : "\u2014";

        return (
          <box
            key={agent.name}
            height={1}
            flexDirection="row"
            paddingLeft={1}
            paddingRight={1}
            backgroundColor={rowBackground}
          >
            <text>
              <span fg={theme.textDim} bg={rowBackground}>{String(i + 1).padStart(2)} </span>
              <span fg={iconColor} bg={rowBackground}>{icon} </span>
              <span fg={isSelected ? theme.text : theme.textMuted} bg={rowBackground}>{agent.name}</span>
            </text>
            <box flexGrow={1} />
            <text>
              <span fg={theme.textDim} bg={rowBackground}>{duration}</span>
            </text>
          </box>
        );
      })}
    </box>
  );
}
