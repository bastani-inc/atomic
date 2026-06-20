import type { IncomingMessage, ServerResponse } from "node:http";
import type { UiProxyRequestBody, UiProxyResult } from "./types.ts";

const MAX_BODY_SIZE = 2 * 1024 * 1024;

export async function parseBody(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<UiProxyRequestBody<Record<string, unknown>> | null> {
  try {
    const body = await readBody(req);
    if (!body || typeof body !== "object") {
      sendJson(res, 400, { ok: false, error: "Invalid request body" });
      return null;
    }
    return body as UiProxyRequestBody<Record<string, unknown>>;
  } catch (error) {
    sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : "Invalid body" });
    return null;
  }
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
      } catch (error) {
        reject(error);
      }
    });

    req.on("error", reject);
  });
}

export function validateTokenQuery(url: URL, expected: string, res: ServerResponse): boolean {
  const token = url.searchParams.get("session");
  if (token !== expected) {
    sendJson(res, 403, { ok: false, error: "Invalid session" });
    return false;
  }
  return true;
}

export function validateTokenBody(
  body: UiProxyRequestBody<Record<string, unknown>>,
  expected: string,
  res: ServerResponse,
): boolean {
  if (body.token !== expected) {
    sendJson(res, 403, { ok: false, error: "Invalid session" });
    return false;
  }
  return true;
}

export function sendJson<T>(
  res: ServerResponse,
  status: number,
  payload: UiProxyResult<T>,
): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}
