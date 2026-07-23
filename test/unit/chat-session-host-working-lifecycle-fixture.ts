// @ts-nocheck
import type { EditorTheme } from "@earendil-works/pi-tui";
import {
  ChatSessionHost,
  type ChatSessionHostOpts,
  type ChatSessionHostStyle,
} from "../../packages/coding-agent/src/index.ts";

export const plainStyle: ChatSessionHostStyle = {
  dim: String,
  text: String,
  textMuted: String,
  accent: String,
  accentBold: String,
  rule: (_hex, text) => text,
  cursor: () => "▌",
  blank: (width) => " ".repeat(width),
  editorRuleColor: () => "#ffffff",
};

export const editorTheme = {
  borderColor: String,
  selectList: {
    selectedPrefix: String,
    selectedText: String,
    description: String,
    scrollInfo: String,
    noMatch: String,
    normal: String,
  },
} as EditorTheme;

export function makeLifecycleHost(
  overrides: Partial<ChatSessionHostOpts> = {},
): ChatSessionHost<never> {
  return new ChatSessionHost<never>({
    style: plainStyle,
    editorTheme,
    ...overrides,
  });
}

export function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

export function rawWorkingLine(host: ChatSessionHost<never>): string | undefined {
  return host.renderWorkingStatus(64)[1]?.trimEnd();
}

export function workingLine(host: ChatSessionHost<never>): string | undefined {
  const line = rawWorkingLine(host);
  return line === undefined ? undefined : stripAnsi(line);
}

interface CapturedTimer {
  readonly callback: () => void;
  readonly delay: number;
}

interface ScheduledTimer extends CapturedTimer {
  readonly handle: { unref(): void };
  readonly repeat: boolean;
  readonly order: number;
  nextAt: number;
}

export interface LifecycleFakeClock {
  advanceBy(milliseconds: number): void;
  animationTick(): void;
  flushEventRender(): void;
  intervalCount(): number;
  activeIntervalDelays(): readonly number[];
  timeoutCount(): number;
  capturedAnimationCallbacks(): readonly (() => void)[];
  capturedEventRenderCallbacks(): readonly (() => void)[];
  intervalDelays(): readonly number[];
  timeoutDelays(): readonly number[];
  restore(): void;
}

export function installLifecycleFakeClock(): LifecycleFakeClock {
  const previousSetInterval = globalThis.setInterval;
  const previousClearInterval = globalThis.clearInterval;
  const previousSetTimeout = globalThis.setTimeout;
  const previousClearTimeout = globalThis.clearTimeout;
  const scheduled = new Map<object, ScheduledTimer>();
  const capturedIntervals: CapturedTimer[] = [];
  const capturedTimeouts: CapturedTimer[] = [];
  let now = 0;
  let nextOrder = 0;

  const install = (
    callback: () => void,
    delayValue: number | undefined,
    repeat: boolean,
  ): object => {
    const delay = Number(delayValue ?? 0);
    const handle = { unref() {} };
    const timer = {
      callback,
      delay,
      handle,
      repeat,
      order: nextOrder,
      nextAt: now + delay,
    };
    nextOrder += 1;
    scheduled.set(handle, timer);
    (repeat ? capturedIntervals : capturedTimeouts).push({ callback, delay });
    return handle;
  };

  globalThis.setInterval = ((callback: () => void, delay?: number) =>
    install(callback, delay, true)) as typeof setInterval;
  globalThis.clearInterval = ((handle: object) => {
    scheduled.delete(handle);
  }) as typeof clearInterval;
  globalThis.setTimeout = ((callback: () => void, delay?: number) =>
    install(callback, delay, false)) as typeof setTimeout;
  globalThis.clearTimeout = ((handle: object) => {
    scheduled.delete(handle);
  }) as typeof clearTimeout;

  const runTimer = (timer: ScheduledTimer): void => {
    if (!scheduled.has(timer.handle)) return;
    if (timer.repeat) timer.nextAt += timer.delay;
    else scheduled.delete(timer.handle);
    timer.callback();
  };

  return {
    advanceBy: (milliseconds) => {
      const target = now + milliseconds;
      while (true) {
        const due = [...scheduled.values()]
          .filter((timer) => timer.nextAt <= target)
          .sort((left, right) => left.nextAt - right.nextAt || left.order - right.order)[0];
        if (!due) break;
        now = due.nextAt;
        runTimer(due);
      }
      now = target;
    },
    animationTick: () => {
      for (const timer of [...scheduled.values()].filter((candidate) => candidate.repeat)) {
        runTimer(timer);
      }
    },
    flushEventRender: () => {
      for (const timer of [...scheduled.values()].filter((candidate) => !candidate.repeat)) {
        runTimer(timer);
      }
    },
    intervalCount: () => [...scheduled.values()].filter((timer) => timer.repeat).length,
    activeIntervalDelays: () => [...scheduled.values()].filter((timer) => timer.repeat).map(({ delay }) => delay),
    timeoutCount: () => [...scheduled.values()].filter((timer) => !timer.repeat).length,
    capturedAnimationCallbacks: () => capturedIntervals.map(({ callback }) => callback),
    capturedEventRenderCallbacks: () => capturedTimeouts.map(({ callback }) => callback),
    intervalDelays: () => capturedIntervals.map(({ delay }) => delay),
    timeoutDelays: () => capturedTimeouts.map(({ delay }) => delay),
    restore: () => {
      globalThis.setInterval = previousSetInterval;
      globalThis.clearInterval = previousClearInterval;
      globalThis.setTimeout = previousSetTimeout;
      globalThis.clearTimeout = previousClearTimeout;
    },
  };
}
