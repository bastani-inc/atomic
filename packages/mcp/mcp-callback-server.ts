/**
 * MCP OAuth Callback Server
 * 
 * HTTP server that handles OAuth callbacks from the authorization server.
 * Uses Node.js http module for compatibility.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "http"
import {
  OAUTH_CALLBACK_PATH,
  getConfiguredOAuthCallbackPort,
  getOAuthCallbackPort,
  setOAuthCallbackPort,
} from "./mcp-oauth-provider.js"
import { logger } from "./logger.js"

// HTML templates for callback responses
const HTML_SUCCESS = `<!DOCTYPE html>
<html>
<head>
  <title>Pi - Authorization Successful</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #1a1a2e; color: #eee; }
    .container { text-align: center; padding: 2rem; }
    h1 { color: #4ade80; margin-bottom: 1rem; }
    p { color: #aaa; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Authorization Successful</h1>
    <p>You can close this window and return to Pi.</p>
  </div>
  <script>setTimeout(() => window.close(), 2000);</script>
</body>
</html>`

export const renderCallbackErrorHtml = () => `<!DOCTYPE html>
<html>
<head>
  <title>Pi - Authorization Failed</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #1a1a2e; color: #eee; }
    .container { text-align: center; padding: 2rem; }
    h1 { color: #f87171; margin-bottom: 1rem; }
    p { color: #aaa; }
    .error { color: #fca5a5; font-family: monospace; margin-top: 1rem; padding: 1rem; background: rgba(248,113,113,0.1); border-radius: 0.5rem; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Authorization Failed</h1>
    <p>An error occurred during authorization.</p>
    <div class="error">Return to Atomic and try again.</div>
  </div>
</body>
</html>`

/** Pending authorization request */
interface PendingAuth {
  resolve: (code: string) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

/** Serialized callback-server ownership prevents startup/teardown publication races. */
let server: Server | undefined
let serverTransition: Promise<void> = Promise.resolve()
const pendingAuths = new Map<string, PendingAuth>()

/** Timeout for callback completion (5 minutes) */
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000

const MAX_PORT_SCAN_ATTEMPTS = 25

interface EnsureCallbackServerOptions {
  strictPort?: boolean
}

/**
 * Handle incoming HTTP requests to the callback server.
 */
export function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url || "/", `http://${req.headers.host}`)

  // Only handle the callback path
  if (url.pathname !== OAUTH_CALLBACK_PATH) {
    res.writeHead(404, { "Content-Type": "text/plain" })
    res.end("Not found")
    return
  }

  const code = url.searchParams.get("code")
  const state = url.searchParams.get("state")
  const error = url.searchParams.get("error")
  const errorDescription = url.searchParams.get("error_description")

  // Enforce state parameter presence for CSRF protection
  if (!state) {
    logger.debug("OAuth callback rejected: missing state parameter")
    res.writeHead(400, { "Content-Type": "text/html" })
    res.end(renderCallbackErrorHtml())
    return
  }

  // Handle OAuth errors
  if (error) {
    const errorMsg = errorDescription || error
    // Send HTTP response first before rejecting promise
    res.writeHead(200, { "Content-Type": "text/html" })
    res.end(renderCallbackErrorHtml())
    // Reject only after the response is sent.
    if (pendingAuths.has(state)) {
      rejectPendingCallback(state, new Error(errorMsg))
    }
    return
  }

  // Require authorization code
  if (!code) {
    res.writeHead(400, { "Content-Type": "text/html" })
    res.end(renderCallbackErrorHtml())
    return
  }

  // Validate state parameter
  if (!pendingAuths.has(state)) {
    logger.debug("OAuth callback rejected: invalid or expired state parameter")
    res.writeHead(400, { "Content-Type": "text/html" })
    res.end(renderCallbackErrorHtml())
    return
  }

  const pending = pendingAuths.get(state)!

  // Clear timeout and resolve the pending promise
  clearTimeout(pending.timeout)
  pendingAuths.delete(state)
  pending.resolve(code)

  res.writeHead(200, { "Content-Type": "text/html" })
  res.end(HTML_SUCCESS)
}

/**
 * Ensure the callback server is running.
 * If strictPort is true, requires binding on the configured callback port.
 * If strictPort is false, scans forward for an available local port.
 */
export function ensureCallbackServer(options: EnsureCallbackServerOptions = {}): Promise<void> {
  return enqueueServerTransition(() => ensureCallbackServerNow(options))
}

function enqueueServerTransition<T>(operation: () => Promise<T>): Promise<T> {
  const result = serverTransition.then(operation, operation)
  serverTransition = result.then(() => undefined, () => undefined)
  return result
}

async function closeServer(target: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    target.close(() => resolve())
  })
}

async function stopPublishedServer(): Promise<void> {
  const target = server
  if (!target) return
  server = undefined
  await closeServer(target)
}

async function listen(candidate: Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      candidate.off("error", onError)
      reject(error)
    }
    const onListening = (): void => {
      candidate.off("error", onError)
      resolve()
    }
    candidate.once("error", onError)
    candidate.listen(port, "localhost", onListening)
  })
}

async function ensureCallbackServerNow(options: EnsureCallbackServerOptions): Promise<void> {
  const configuredPort = getConfiguredOAuthCallbackPort()
  const strictPort = options.strictPort === true

  if (server) {
    if (!strictPort || getOAuthCallbackPort() === configuredPort) return
    if (pendingAuths.size > 0) {
      throw new Error(
        `OAuth callback server is running on port ${getOAuthCallbackPort()}, but strict callback port ${configuredPort} is required and cannot be switched while authorizations are pending`,
      )
    }
    await stopPublishedServer()
    setOAuthCallbackPort(configuredPort)
  }

  const maxAttempts = strictPort ? 1 : MAX_PORT_SCAN_ATTEMPTS
  let lastError: Error | undefined
  for (let offset = 0; offset < maxAttempts; offset++) {
    const candidatePort = configuredPort + offset
    const candidateServer = createServer(handleRequest)
    try {
      await listen(candidateServer, candidatePort)
      server = candidateServer
      candidateServer.unref()
      setOAuthCallbackPort(candidatePort)
      return
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException
      await closeServer(candidateServer)
      if (nodeError.code !== "EADDRINUSE") throw error
      lastError = error instanceof Error ? error : new Error(String(error))
    }
  }

  if (strictPort) {
    throw new Error(
      `OAuth callback port ${configuredPort} is already in use. Pre-registered OAuth clients require an exact redirect URI; set MCP_OAUTH_CALLBACK_PORT to your registered port or free port ${configuredPort}`,
      { cause: lastError },
    )
  }
  throw new Error(
    `OAuth callback port ${configuredPort} is already in use and no free port was found in range ${configuredPort}-${configuredPort + MAX_PORT_SCAN_ATTEMPTS - 1}`,
    { cause: lastError },
  )
}

/**
 * Wait for a callback with the given OAuth state.
 * Returns a promise that resolves with the authorization code.
 */
export function waitForCallback(oauthState: string): Promise<string> {
  const promise = new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (pendingAuths.has(oauthState)) {
        pendingAuths.delete(oauthState)
        reject(new Error("OAuth callback timeout - authorization took too long"))
      }
    }, CALLBACK_TIMEOUT_MS)

    pendingAuths.set(oauthState, { resolve, reject, timeout })
  })
  void promise.catch(() => undefined)
  return promise
}

/**
 * Cancel a pending authorization by state.
 */
function rejectPendingCallback(oauthState: string, error: Error): boolean {
  const pending = pendingAuths.get(oauthState)
  if (!pending) return false
  pendingAuths.delete(oauthState)
  clearTimeout(pending.timeout)
  pending.reject(error)
  return true
}

export function cancelPendingCallback(
  oauthState: string,
  error = new Error("Authorization cancelled"),
): void {
  rejectPendingCallback(oauthState, error)
}

/** Reject and remove every callback waiter before lifecycle cleanup settles. */
export function cancelAllPendingCallbacks(error: Error): void {
  for (const oauthState of Array.from(pendingAuths.keys())) {
    rejectPendingCallback(oauthState, error)
  }
}

/**
 * Stop the callback server and reject all pending authorizations.
 */
export function stopCallbackServer(
  error = new Error("OAuth callback server stopped"),
): Promise<void> {
  cancelAllPendingCallbacks(error)
  return enqueueServerTransition(async () => {
    // A producer can register its waiter while an earlier startup is publishing.
    cancelAllPendingCallbacks(error)
    await stopPublishedServer()
    setOAuthCallbackPort(getConfiguredOAuthCallbackPort())
  })
}

/**
 * Check if the callback server is running.
 */
export function isCallbackServerRunning(): boolean {
  return server !== undefined
}

/**
 * Get the number of pending authorizations.
 */
export function getPendingAuthCount(): number {
  return pendingAuths.size
}
