/** @jsxImportSource @opentui/react */

import React from "react";
import { lerpColor } from "./color-utils.ts";
import { useGraphTheme } from "./orchestrator-panel-contexts.ts";
import { statusColor, fmtDuration } from "./status-helpers.ts";
import { NODE_W, type LayoutNode } from "./layout.ts";

export const NodeCard = React.memo(function NodeCard({
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
  const theme = useGraphTheme();
  const sc = statusColor(node.status, theme);
  const isPending = node.status === "pending";
  const isRunning = node.status === "running";
  const isAwaitingInput = node.status === "awaiting_input";

  // Border: running nodes smoothly pulse, others show status color
  let borderCol: string;
  if (isRunning) {
    const t = (Math.sin((pulsePhase / 32) * Math.PI * 2 - Math.PI / 2) + 1) / 2;
    borderCol = focused
      ? lerpColor(theme.warning, theme.text, 0.2)
      : lerpColor(theme.border, theme.warning, t);
  } else if (isAwaitingInput) {
    const t = (Math.sin((pulsePhase / 32) * Math.PI * 2 - Math.PI / 2) + 1) / 2;
    borderCol = focused
      ? lerpColor(theme.info, theme.text, 0.2)
      : lerpColor(theme.border, theme.info, t);
  } else if (isPending) {
    borderCol = focused ? sc : theme.borderActive;
  } else {
    borderCol = sc;
  }

  // Keep the card interior aligned with the graph canvas; status color belongs to the border/text.
  const bgCol = theme.background;

  // Duration computed live from start/end timestamps
  const durCol = isPending ? theme.textDim : sc;
  const duration =
    node.startedAt !== null
      ? fmtDuration((node.endedAt ?? Date.now()) - node.startedAt)
      : "\u2014";

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
      <box alignItems="center">
        <text>
          <span fg={durCol} bg={bgCol}>{duration}</span>
        </text>
      </box>
      {isAwaitingInput && (
        <>
          <box alignItems="center">
            <text>
              <span fg={theme.info} bg={bgCol}>waiting for response</span>
            </text>
          </box>
          <box alignItems="center">
            <text>
              <span fg={theme.textDim} bg={bgCol}>↵ enter to respond</span>
            </text>
          </box>
        </>
      )}
    </box>
  );
});
