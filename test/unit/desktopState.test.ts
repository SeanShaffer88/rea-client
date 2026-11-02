import { describe, expect, it } from "vitest";
import { chatReducer, initialChat, messagesFromTranscript } from "../../desktop/ui/state.js";
import type { DesktopEvent } from "../../src/desktop/protocol.js";

function event(id: number, type: string, data: Record<string, unknown>): DesktopEvent {
  return {
    id,
    method: "agent.event",
    params: { requestId: "req-1", type, data },
    time: new Date(1_700_000_000_000 + id * 1000).toISOString(),
  };
}

describe("chatReducer", () => {
  it("accumulates deltas and tool activity only for the active request", () => {
    let state = chatReducer(initialChat, { type: "ask", id: "req-1", question: "Inspect it", time: new Date(0).toISOString() });
    expect(state.running).toBe(true);
    expect(state.messages).toHaveLength(2);

    state = chatReducer(state, { type: "event", event: event(1, "assistant_delta", { text: "Look" }) });
    state = chatReducer(state, { type: "event", event: event(2, "assistant_delta", { text: "ing." }) });
    state = chatReducer(state, { type: "event", event: event(3, "tool_call_started", { id: "t1", name: "binary_overview", arguments: {} }) });
    state = chatReducer(state, { type: "event", event: event(4, "tool_call_finished", { id: "t1", ok: true, elapsedMs: 12, preview: "ok", truncated: false }) });
    state = chatReducer(state, {
      type: "event",
      event: { id: 5, method: "agent.event", params: { requestId: "other", type: "assistant_delta", data: { text: "IGNORED" } }, time: new Date().toISOString() },
    });

    const answer = state.messages[1];
    expect(answer?.content).toBe("Looking.");
    expect(answer?.activities).toHaveLength(1);
    expect(answer?.activities[0]?.finish?.ok).toBe(true);
  });

  it("finishes, fails, and resets turns without retaining stale state", () => {
    let state = chatReducer(initialChat, { type: "ask", id: "req-1", question: "Q", time: new Date(0).toISOString() });
    state = chatReducer(state, { type: "event", event: event(1, "assistant_delta", { text: "partial" }) });
    state = chatReducer(state, { type: "complete", id: "req-1", content: "Final answer", reason: "final_answer", iterations: 3 });
    expect(state.running).toBe(false);
    expect(state.messages[1]).toMatchObject({ content: "Final answer", reason: "final_answer", iterations: 3, streaming: false });

    let failed = chatReducer(initialChat, { type: "ask", id: "req-2", question: "Q", time: new Date(0).toISOString() });
    failed = chatReducer(failed, { type: "fail", id: "req-2", error: "model offline" });
    expect(failed.messages[1]).toMatchObject({ reason: "failed", error: "model offline", streaming: false });

    expect(chatReducer(state, { type: "reset" })).toEqual(initialChat);
  });

  it("keeps the engine's failure explanation when a turn ends as failed", () => {
    let state = chatReducer(initialChat, { type: "ask", id: "req-1", question: "Q", time: new Date(0).toISOString() });
    state = chatReducer(state, {
      type: "complete",
      id: "req-1",
      content: "",
      reason: "failed",
      error: "Could not reach the local model server at http://127.0.0.1:8080/v1/chat/completions: fetch failed",
      iterations: 1,
    });
    expect(state.running).toBe(false);
    expect(state.messages[1]).toMatchObject({
      reason: "failed",
      streaming: false,
      content: "",
    });
    expect(state.messages[1]?.error).toContain("Could not reach the local model server");
  });

  it("interrupts an in-flight turn when the engine disconnects", () => {
    let state = chatReducer(initialChat, { type: "ask", id: "req-1", question: "Q", time: new Date(0).toISOString() });
    state = chatReducer(state, { type: "event", event: event(1, "assistant_delta", { text: "half an ans" }) });
    state = chatReducer(state, { type: "interrupt", error: "The REA engine stopped." });
    expect(state.running).toBe(false);
    expect(state.messages[1]).toMatchObject({ content: "half an ans", streaming: false, reason: "failed", error: "The REA engine stopped." });

    // An interrupt with no active turn is a no-op rather than a state reset.
    expect(chatReducer(initialChat, { type: "interrupt", error: "ignored" })).toEqual(initialChat);
  });

  it("rebuilds the visible conversation from the engine transcript", () => {
    const restored = messagesFromTranscript([
      { role: "system", content: "You are REA." },
      { role: "user", content: "What is open?" },
      { role: "assistant", content: null },
      { role: "tool", content: "observation", tool_call_id: "c1" },
      { role: "assistant", content: "A binary." },
      { role: "assistant", content: "   " },
    ] as Array<{ role: string; content: string | null }>);
    expect(restored.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(restored[1]?.content).toBe("A binary.");
    expect(restored[0]?.time).toBe("");

    const hydrated = chatReducer(initialChat, { type: "hydrate", messages: restored });
    expect(hydrated.messages).toHaveLength(2);
    // Hydration must never clobber an in-flight turn or clear an empty history.
    const running = chatReducer(initialChat, { type: "ask", id: "req-1", question: "Q", time: "" });
    expect(chatReducer(running, { type: "hydrate", messages: restored })).toBe(running);
    expect(chatReducer(initialChat, { type: "hydrate", messages: [] })).toBe(initialChat);
  });
});
