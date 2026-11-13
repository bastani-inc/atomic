// Minimal OpenAI-compatible streaming mock. Logs every request with a timestamp.
// First turn of a prompt containing "SETUP:<cmd>" answers with one bash tool call running <cmd>;
// any request whose last message is a tool result, or any other prompt, answers with text.
import http from "node:http";
import { appendFileSync } from "node:fs";
const port = Number(process.env.MOCK_PORT ?? 18555);
const log = process.env.MOCK_LOG ?? "/fast/tmp/resume-perf/mock-requests.jsonl";
let n = 0;
function sse(res, obj) { res.write(`data: ${JSON.stringify(obj)}\n\n`); }
http.createServer((req, res) => {
  if (req.method === "GET") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ data: [{ id: "mock-1", object: "model" }] })); return; }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const t = Date.now();
    let parsed = {};
    try { parsed = JSON.parse(body); } catch {}
    const msgs = parsed.messages ?? [];
    const last = msgs[msgs.length - 1] ?? {};
    const text = typeof last.content === "string" ? last.content : Array.isArray(last.content) ? last.content.map((c) => c.text ?? "").join("") : "";
    appendFileSync(log, JSON.stringify({ t, url: req.url, role: last.role, text: text.slice(0, 200) }) + "\n");
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const id = `chatcmpl-${++n}`;
    const base = { id, object: "chat.completion.chunk", created: Math.floor(t / 1000), model: "mock-1" };
    const m = /SETUP:(.*)$/s.exec(text);
    if (last.role === "user" && m) {
      sse(res, { ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `call_${n}`, type: "function", function: { name: "bash", arguments: "" } }] } }] });
      sse(res, { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ command: m[1].trim() }) } }] } }] });
      sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
    } else {
      sse(res, { ...base, choices: [{ index: 0, delta: { role: "assistant", content: "ok" } }] });
      sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } });
    }
    res.write("data: [DONE]\n\n");
    res.end();
  });
}).listen(port, "127.0.0.1", () => console.log(`mock on ${port}`));
