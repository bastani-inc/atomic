import type { Socket } from "net";

/** JSON values at the framing boundary, before protocol-specific validation. */
export type JsonWireValue = string | number | boolean | null | JsonWireValue[] | { [key: string]: JsonWireValue };

/**
 * Write a length-prefixed message to a socket.
 * Format: 4-byte big-endian length + JSON payload
 */
export function writeMessage(socket: Socket, msg: unknown, callback?: (error?: Error | null) => void): void {
  const json = JSON.stringify(msg);
  const payload = Buffer.from(json, "utf-8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length, 0);
  const frame = Buffer.concat([header, payload]);
  if (callback === undefined) socket.write(frame);
  else socket.write(frame, callback);
}

/**
 * Create a message reader that handles partial reads.
 * Calls onMessage for each complete message received.
 * Protocol or handler errors are reported to onError so the caller can close the socket.
 */
export function createMessageReader(
  onMessage: (msg: JsonWireValue) => void,
  onError: (error: Error) => void,
) {
  let buffer = Buffer.alloc(0);
  // Chunks of a frame still arriving: joined once the frame is complete, not on every
  // chunk, so a large frame costs linear rather than quadratic copying.
  let pending: Buffer[] = [];
  let pendingLength = 0;
  let awaitedLength = 0;

  return (data: Buffer) => {
    if (pendingLength + data.length < awaitedLength) {
      pending.push(data);
      pendingLength += data.length;
      return;
    }
    buffer = pending.length === 0 ? Buffer.concat([buffer, data]) : Buffer.concat([...pending, data]);
    pending = [];
    pendingLength = 0;
    awaitedLength = 0;

    while (buffer.length >= 4) {
      const length = buffer.readUInt32BE(0);
      
      if (buffer.length < 4 + length) {
        pending = [buffer];
        pendingLength = buffer.length;
        awaitedLength = 4 + length;
        buffer = Buffer.alloc(0);
        break;
      }

      const payload = buffer.subarray(4, 4 + length);
      buffer = buffer.subarray(4 + length);

      let msg: JsonWireValue;
      try {
        msg = JSON.parse(payload.toString("utf-8"));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        onError(new Error(`Failed to parse intercom message: ${message}`, { cause: error }));
        return;
      }

      try {
        onMessage(msg);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        onError(new Error(`Failed to handle intercom message: ${message}`, { cause: error }));
        return;
      }
    }
  };
}
