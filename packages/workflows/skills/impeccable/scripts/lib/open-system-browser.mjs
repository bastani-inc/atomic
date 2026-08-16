import { spawn } from 'node:child_process';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

/**
 * Validate the URL before handing it to an operating-system browser opener.
 * The opener is only used for local question/review pages; accepting a remote
 * URL here would turn a convenience helper into an outbound navigation sink.
 */
export function validateBrowserUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || CONTROL_CHARACTERS.test(value)) return null;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.username || parsed.password) return null;
  if (!LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) return null;
  return parsed;
}

export function browserOpenCommand(url, { platform = process.platform } = {}) {
  if (!validateBrowserUrl(url)) return null;
  if (platform === 'darwin') return { command: 'open', args: [url] };
  // `start` is a cmd.exe built-in and would expose the URL to shell parsing.
  // Explorer accepts a URL as an argv value and is a fixed non-shell target.
  if (platform === 'win32') return { command: 'explorer.exe', args: [url] };
  return { command: 'xdg-open', args: [url] };
}

/**
 * Open a validated loopback URL with a fixed executable and argv. Synchronous
 * spawn failures return false; asynchronous child failures are consumed so a
 * browser that is unavailable cannot crash the serving question process.
 */
export function openSystemBrowser(url, {
  platform = process.platform,
  spawnImpl = spawn,
} = {}) {
  const command = browserOpenCommand(url, { platform });
  if (!command) return false;
  try {
    const child = spawnImpl(command.command, command.args, {
      stdio: 'ignore',
      detached: true,
      shell: false,
    });
    child.once('error', () => {});
    if (typeof child.unref === 'function') child.unref();
    return true;
  } catch {
    return false;
  }
}
