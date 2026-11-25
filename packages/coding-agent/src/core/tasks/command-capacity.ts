/**
 * The most shell commands one session's task owner runs at once, its subagents' shells included. Commands have no
 * time limit by default, so this bounds what a runaway loop of launches can leave running. Codex keeps the same
 * number of live processes (`MAX_UNIFIED_EXEC_PROCESSES`), but evicts the least recently used one at the cap; Atomic
 * refuses the new launch instead, because a running command here is visible work (a dev server, a long build, a
 * subagent's test run) that only the user or the model should stop.
 */
export const MAX_LIVE_COMMANDS = 64;

/** Why a command launch was refused at {@link MAX_LIVE_COMMANDS}, in the words the model and the user read. */
export const LIVE_COMMAND_LIMIT_MESSAGE = `${MAX_LIVE_COMMANDS} commands are already running in this session, the most it runs at once. Stop one you no longer need with kill or /tasks, or wait for one to finish, then run this command again.`;
