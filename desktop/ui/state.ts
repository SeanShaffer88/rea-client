import type { AgentDoneReason, ToolCallFinished, ToolCallStarted } from "../../src/agent/events.js";
import type { DesktopEvent } from "../../src/desktop/protocol.js";

export interface ToolActivity extends ToolCallStarted {
  finish?: ToolCallFinished;
  time: string;
}
export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  streaming?: boolean;
  activities: ToolActivity[];
  reason?: AgentDoneReason;
  error?: string;
  iterations?: number;
  time: string;
}
export interface ChatState { messages: Message[]; running: boolean; requestId: string | null }
export type ChatAction =
  | { type: "ask"; id: string; question: string; time: string }
  | { type: "event"; event: DesktopEvent }
  | { type: "complete"; id: string; content: string; reason: AgentDoneReason; error?: string; iterations: number }
  | { type: "fail"; id: string; error: string }
  | { type: "reset" };

export const initialChat: ChatState = { messages: [], running: false, requestId: null };
export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  if (action.type === "reset") return initialChat;
  if (action.type === "ask") return {
    running: true, requestId: action.id,
    messages: [...state.messages,
      { id: action.id, role: "user", content: action.question, activities: [], time: action.time },
      { id: `${action.id}:answer`, role: "assistant", content: "", streaming: true, activities: [], time: action.time },
    ],
  };
  if (action.type === "fail" || action.type === "complete") {
    if (state.requestId !== action.id) return state;
    return { ...state, running: false, messages: state.messages.map((message) => {
      if (message.id !== `${action.id}:answer`) return message;
      const finished: Message = { ...message, streaming: false };
      if (action.type === "complete") {
        finished.content = action.content;
        finished.reason = action.reason;
        finished.iterations = action.iterations;
      } else {
        finished.reason = "failed";
      }
      if (action.error) finished.error = action.error;
      return finished;
    }) };
  }
  if (!state.running || action.event.method !== "agent.event" || action.event.params.requestId !== state.requestId) return state;
  const { type, data } = action.event.params as { type: string; data: Record<string, unknown> };
  return { ...state, messages: state.messages.map((message) => {
    if (message.id !== `${state.requestId}:answer`) return message;
    if (type === "assistant_delta") return { ...message, content: message.content + String(data.text ?? "") };
    if (type === "tool_call_started") return { ...message, activities: [...message.activities, { ...data as unknown as ToolCallStarted, time: action.event.time }] };
    if (type === "tool_call_finished") return { ...message, activities: message.activities.map((activity) => activity.id === data.id ? { ...activity, finish: data as unknown as ToolCallFinished } : activity) };
    if (type === "error" && data.recoverable === false) return { ...message, error: String(data.message ?? "The model request failed.") };
    return message;
  }) };
}
