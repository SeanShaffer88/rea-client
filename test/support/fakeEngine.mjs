/**
 * Minimal stand-in for `rea-client serve`, used only by the desktop bridge
 * tests. It speaks the same newline-delimited JSON-RPC framing as the real CLI
 * so the supervisor's spawning, framing, timeout, and shutdown paths can be
 * exercised without starting REA.
 */
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const result = (id, value) => send({ jsonrpc: "2.0", id, result: value });

send({ jsonrpc: "2.0", method: "engine.ready", params: { fixture: true } });

for await (const line of rl) {
  const text = line.trim();
  if (!text) continue;
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    process.stdout.write("{this is not json}\n");
    continue;
  }
  const { id, method, params } = message;
  if (method === "engine.ping") {
    result(id, { ok: true, pid: process.pid, running: true });
  } else if (method === "engine.shutdown") {
    result(id, { ok: true });
    break;
  } else if (method === "echo") {
    result(id, { params });
  } else if (method === "notify") {
    send({ jsonrpc: "2.0", method: "agent.event", params: { type: "assistant_delta", data: { text: "hi" } } });
    result(id, { ok: true });
  } else if (method === "badjson") {
    process.stdout.write("{this is not json}\n");
    result(id, { ok: true });
  } else if (method === "stderr") {
    process.stderr.write("fixture diagnostic line\n");
    result(id, { ok: true });
  } else if (method === "slow") {
    setTimeout(() => result(id, { ok: true }), 400);
  } else if (method === "fail") {
    send({ jsonrpc: "2.0", id, error: { message: "fixture failure" } });
  } else if (method === "oversized") {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result: { text: "x".repeat(4096) } })}\n`);
  } else {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method ${method}` } });
  }
}

process.exit(0);
