/**
 * Closing a Windows console window. Windows tells the processes attached to the console one at a time, newest first,
 * and reports it to Node and Bun as SIGHUP, which it sends for nothing else. A process with a listener is given
 * {@link CONSOLE_CLOSE_TIMEOUT_MS} from its own notice before Windows ends it with {@link CONSOLE_CLOSED_EXIT_CODE}.
 */

/** STATUS_CONTROL_C_EXIT: the status Windows gives a process it ends when its console is closed. */
export const CONSOLE_CLOSED_EXIT_CODE = 0xc000013a;
/** How long Windows lets a process run after its console was closed before it ends the process itself. */
export const CONSOLE_CLOSE_TIMEOUT_MS = 5_000;
/**
 * Once the console is closed, the longest a shutdown may take: the process then ends its children and exits, leaving
 * the rest of Windows's timeout for its own exit.
 */
export const CONSOLE_CLOSED_SHUTDOWN_MS = CONSOLE_CLOSE_TIMEOUT_MS - 1_000;
