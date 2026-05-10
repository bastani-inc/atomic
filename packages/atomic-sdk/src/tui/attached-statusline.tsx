/**
 * JSX equivalent of the attached-mode footer, authored against the
 * tui sub-package's `<Box>`, `<Text>`, and `<Footer>` intrinsics.
 * Compiles to a tmux/psmux format string via `renderFooter`.
 *
 * Two top-level variants:
 *   - workflow (no agentType): a single tmux conditional that picks
 *     between an orchestrator branch (GRAPH badge + bg-task counter +
 *     graph-mode hints) and an agent branch (agent-mode hints) based
 *     on `#{window_name}`. Mirrors the catppuccin-theme pattern that
 *     is known to render correctly on psmux 3.3.3 — no nested
 *     conditionals; reactive content rides single-option indirection
 *     (`#{@atomic-bg-tasks}`).
 *   - chat (agentType set): single-window session, no conditional —
 *     just the agent-type pill + detach hint.
 */

import type { ReactNode } from "react";

import { Box, Footer, Text } from "./components.tsx";
import type { GraphTheme } from "../components/graph-theme.ts";
import type { AgentType } from "../types.ts";

const AGENT_PILL_COLOR: Record<AgentType, keyof GraphTheme> = {
  claude: "warning",
  copilot: "success",
  opencode: "mauve",
};

const DOT = "·";

/** Window name used by `runtime/tmux.ts:createSession` for the orchestrator. */
export const ORCHESTRATOR_WINDOW_NAME = "orchestrator";

/**
 * Max characters of `#{window_name}` rendered in the agent-branch
 * pill. Anything longer is truncated with an ellipsis via tmux's
 * `#{=/N/T:variable}` modifier (so a workflow with a 40-char stage
 * name doesn't overflow the pill into the bg-tasks counter).
 */
const STAGE_NAME_MAX = 16;

/**
 * Suffix of the `@atomic-…` user-option the orchestrator panel pushes
 * the pre-styled background-tasks indicator into. The orchestrator
 * branch of the status-line references it via `#{@atomic-bg-tasks}`,
 * which psmux substitutes at render time without needing a nested
 * `#{?…}` conditional. See `backgroundTasksValue` for the value shape.
 */
export const BACKGROUND_TASKS_OPTION = "bg-tasks";

/**
 * Pre-formatted tmux markup for the bg-tasks indicator. Empty when the
 * count is zero so the status line collapses cleanly. Style attributes
 * are space-separated to keep psmux 3.3.3's render parser happy
 * (commas inside `#[…]` inside `#{?…}` leak fragments across branches).
 */
export function backgroundTasksValue(count: number, theme: GraphTheme): string {
  if (count <= 0) return "";
  const bg = theme.backgroundElement;
  return ` #[fg=${theme.warning} bg=${bg}]◆ #[fg=${theme.textMuted} bg=${bg}]${count} background`;
}

/**
 * Wrap two ReactNodes in a single tmux conditional that selects
 * between them based on whether the active window is the orchestrator
 * window. The compiler emits children sequentially as strings, so the
 * result has the shape
 * `#{?#{==:#{window_name},orchestrator},<orch>,<agent>}`.
 *
 * Pure — no side effects. The cond's only comma is inside the
 * brace-balanced `#{==:…}` substitution, which tmux's parser handles
 * correctly. Branch content uses space-separated style attributes
 * (see `compiler/styles.ts`) so the only commas at the conditional's
 * top level are its two separators.
 */
function whenOrchestrator(orch: ReactNode, agent: ReactNode): ReactNode {
  return [
    `#{?#{==:#{window_name},${ORCHESTRATOR_WINDOW_NAME}},`,
    orch,
    ",",
    agent,
    "}",
  ];
}

export function attachedStatusline(args: {
  theme: GraphTheme;
  agentType?: AgentType;
  name?: string;
}): ReactNode {
  const { theme, agentType, name } = args;

  if (agentType) {
    const pillBg = theme[AGENT_PILL_COLOR[agentType]];
    return (
      <Footer
        position="bottom"
        bg={theme.backgroundElement}
        fg={theme.text}
      >
        <Footer.Left>
          <Box bg={pillBg} paddingLeft={1} paddingRight={1}>
            <Text fg={theme.backgroundElement} bold>
              {agentType.toUpperCase()}
            </Text>
          </Box>
        </Footer.Left>
        <Footer.Right>
          <Box paddingRight={2}>
            <Text fg={theme.textMuted}>?  </Text>
            <Text fg={theme.text}>{`/atomic <question>`}</Text>
            {name ? (
              <>
                <Text fg={theme.textDim}>{` ${DOT} `}</Text>
                <Text fg={theme.textMuted}>{name}</Text>
              </>
            ) : null}
            <Text fg={theme.textDim}>{` ${DOT} `}</Text>
            <Text fg={theme.text}>ctrl+b d</Text>
            <Text fg={theme.textMuted}> detach</Text>
          </Box>
        </Footer.Right>
      </Footer>
    );
  }

  // The pill itself always renders, but its label switches: GRAPH on
  // the orchestrator window, the live stage name on agent windows
  // (so the user always knows which stage they're attached to). The
  // name is truncated via tmux's `#{=/N/T:…}` modifier to keep the
  // pill from ballooning when stage names are verbose. The bg-task
  // counter only renders on the orchestrator window because
  // background stages can only be interacted with from the graph
  // view; surfacing the count from an agent pane would just be
  // noise. Both conditionals here are sibling (not nested) to the
  // right-side one, so the psmux 3.3.3 nested-`#{?…}` bug doesn't
  // apply.
  const left: ReactNode = (
    <>
      <Box bg={theme.primary} paddingLeft={1} paddingRight={1}>
        <Text fg={theme.backgroundElement} bold>
          {whenOrchestrator(
            "GRAPH",
            `#{=/${STAGE_NAME_MAX}/...:window_name}`,
          )}
        </Text>
      </Box>
      {whenOrchestrator(`#{@atomic-${BACKGROUND_TASKS_OPTION}}`, "")}
    </>
  );

  const orchRight = (
    <Box paddingRight={2}>
      <Text fg={theme.text}>{"↑↓←→"}</Text>
      <Text fg={theme.textMuted}> navigate</Text>
      <Text fg={theme.textDim}>{` ${DOT} `}</Text>
      <Text fg={theme.text}>{"↵"}</Text>
      <Text fg={theme.textMuted}> attach</Text>
      <Text fg={theme.textDim}>{` ${DOT} `}</Text>
      <Text fg={theme.text}>/</Text>
      <Text fg={theme.textMuted}> stages</Text>
      <Text fg={theme.textDim}>{` ${DOT} `}</Text>
      <Text fg={theme.text}>ctrl+b d</Text>
      <Text fg={theme.textMuted}> detach</Text>
      <Text fg={theme.textDim}>{` ${DOT} `}</Text>
      <Text fg={theme.text}>q</Text>
      <Text fg={theme.textMuted}> quit</Text>
    </Box>
  );
  const agentRight = (
    <Box paddingRight={2}>
      <Text fg={theme.text}>ctrl+g</Text>
      <Text fg={theme.textMuted}> graph</Text>
      <Text fg={theme.textDim}>{` ${DOT} `}</Text>
      <Text fg={theme.text}>ctrl+\</Text>
      <Text fg={theme.textMuted}> next</Text>
    </Box>
  );

  return (
    <Footer position="bottom" bg={theme.backgroundElement} fg={theme.text}>
      <Footer.Left>{left}</Footer.Left>
      <Footer.Right>{whenOrchestrator(orchRight, agentRight)}</Footer.Right>
    </Footer>
  );
}
