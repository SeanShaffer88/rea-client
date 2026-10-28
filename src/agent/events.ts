/**
 * The event surface a UI tier subscribes to.
 *
 * The Rust/egui shell in the blueprint renders four panes that all need live
 * data: the agent console (streaming text), the code viewer (tool results), the
 * status bar (analysis state), and the diagnostics panel (stderr and tool
 * timings). This union is that interface. It is transport-agnostic on purpose:
 * the same events can be forwarded over a stdio JSON-RPC bridge, a loopback
 * WebSocket, or handled in-process.
 */

export interface ToolCallStarted {
  readonly id: string;
  readonly name: string;
  readonly mcpName: string;
  readonly arguments: Record<string, unknown>;
  readonly iteration: number;
}

export interface ToolCallFinished {
  readonly id: string;
  readonly name: string;
  readonly mcpName: string;
  readonly ok: boolean;
  readonly elapsedMs: number;
  readonly truncated: boolean;
  readonly evidenceId: string | undefined;
  /** First ~400 characters of the observation, for an inline preview. */
  readonly preview: string;
}

export interface AgentEvents {
  /** Model text, streamed. Append to the console as it arrives. */
  assistant_delta: { readonly text: string; readonly iteration: number };
  /** A complete assistant message for this turn. */
  assistant_message: { readonly content: string; readonly iteration: number };
  tool_call_started: ToolCallStarted;
  tool_call_finished: ToolCallFinished;
  /** Progress for the status bar. */
  iteration: { readonly index: number; readonly max: number };
  /** Fired when the transcript is pruned to stay inside the context budget. */
  context_pruned: { readonly droppedMessages: number; readonly estimatedTokens: number };
  done: { readonly reason: AgentDoneReason; readonly iterations: number };
  error: { readonly message: string; readonly recoverable: boolean };
}

export type AgentDoneReason =
  | "final_answer"
  | "max_iterations"
  | "cancelled"
  | "failed";

export const PREVIEW_LENGTH = 400;

export function previewOf(observation: string): string {
  return observation.length <= PREVIEW_LENGTH
    ? observation
    : `${observation.slice(0, PREVIEW_LENGTH)}…`;
}
