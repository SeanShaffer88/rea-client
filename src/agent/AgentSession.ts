/**
 * The ReAct loop.
 *
 *   user prompt
 *     -> model stream (text + tool_call fragments)
 *     -> execute each call against REA over MCP
 *     -> project the Evidence result into a bounded observation
 *     -> feed observations back
 *     -> repeat until the model answers without calling a tool
 *
 * Design notes that matter in practice:
 *
 *  - A failed call is returned to the model as a `TOOL_ERROR` observation
 *    instead of aborting the turn. Local models routinely recover from a bad
 *    address if they can read the error; aborting wastes the whole turn.
 *  - Tool-call arguments are parsed per call, and an unparseable argument object
 *    is reported back the same way, because a 14B model will occasionally emit
 *    trailing prose inside the JSON.
 *  - The transcript is pruned by *unit* (a user turn plus everything it caused),
 *    never by individual message, so an assistant `tool_calls` message is never
 *    separated from its `tool` results.
 */

import type { ReaClientConfig } from "../config.js";
import type { ToolCatalog, ScopeResolution } from "../mcp/catalog.js";
import { ToolObservation, projectToolResult } from "../mcp/evidence.js";
import type { McpConnection } from "../mcp/ReaClient.js";
import { buildFunctionDefinitions, type MappedToolSet } from "../llm/toolSchema.js";
import { collectTurn } from "../llm/turn.js";
import type {
  AssistantToolCall,
  ChatMessage,
  ChatTransport,
  FunctionDefinition,
  TokenUsage,
} from "../llm/types.js";
import { Emitter } from "../util/emitter.js";
import { previewOf, type AgentDoneReason, type AgentEvents } from "./events.js";
import {
  DEFAULT_GUARD_LIMITS,
  checkToolArguments,
  type ArgumentGuardLimits,
} from "./argumentGuard.js";

export interface AgentSessionOptions {
  readonly connection: McpConnection;
  readonly chat: ChatTransport;
  readonly catalog: ToolCatalog;
  readonly scope: ScopeResolution;
  readonly model: string;
  readonly maxIterations: number;
  readonly maxToolResultChars: number;
  readonly temperature: number;
  readonly maxTokens: number;
  readonly contextWindow: number;
  readonly systemPrompt: string;
  /** Per-tool-call budget. Analysis of a large binary can legitimately be slow. */
  readonly toolTimeoutMs?: number;
  /** Extra function definitions beyond the REA catalog (local utilities). */
  readonly extraTools?: readonly FunctionDefinition[];
  /**
   * Bounds on outbound tool arguments. Defaults are conservative; see
   * `argumentGuard.ts` for why they exist.
   */
  readonly argumentLimits?: ArgumentGuardLimits;
}

export interface AskOptions {
  readonly signal?: AbortSignal;
}

export interface AgentResult {
  readonly content: string;
  readonly reason: AgentDoneReason;
  readonly iterations: number;
  readonly toolCallsExecuted: number;
  readonly usage: TokenUsage | undefined;
}

const APPROX_CHARS_PER_TOKEN = 3.5;
const DEFAULT_TOOL_TIMEOUT_MS = 300_000;

export class AgentSession extends Emitter<AgentEvents> {
  private readonly options: AgentSessionOptions;
  private readonly messages: ChatMessage[] = [];
  private readonly mapped: MappedToolSet;
  private running = false;

  public constructor(options: AgentSessionOptions) {
    super();
    this.options = options;
    this.mapped = buildFunctionDefinitions(options.scope.tools);
    this.messages.push({ role: "system", content: options.systemPrompt });
  }

  /** Advertised tool set for this session, including the schema mapping. */
  public get toolSet(): MappedToolSet {
    return this.mapped;
  }

  public get advertisedToolCount(): number {
    return this.mapped.definitions.length;
  }

  /** Copy of the live transcript, for rendering or persistence. */
  public transcript(): readonly ChatMessage[] {
    return [...this.messages];
  }

  public reset(): void {
    const system = this.messages[0];
    this.messages.length = 0;
    if (system !== undefined) this.messages.push(system);
  }

  /** Approximate token count of the current transcript. */
  public estimatedTranscriptTokens(): number {
    return Math.ceil(this.serializedChars() / APPROX_CHARS_PER_TOKEN);
  }

  private serializedChars(): number {
    let total = 0;
    for (const message of this.messages) {
      total += (message.content ?? "").length;
      for (const call of message.tool_calls ?? []) {
        total += call.function.name.length + call.function.arguments.length;
      }
    }
    for (const definition of this.mapped.definitions) {
      total += JSON.stringify(definition).length;
    }
    return total;
  }

  /**
   * Runs one user turn to completion.
   *
   * @throws when the model transport fails unrecoverably; tool failures are
   * surfaced to the model instead.
   */
  public async ask(userMessage: string, askOptions: AskOptions = {}): Promise<AgentResult> {
    if (this.running) {
      throw new Error("AgentSession.ask() is already running; await the previous turn.");
    }
    this.running = true;

    let iterations = 0;
    let toolCallsExecuted = 0;
    let usage: TokenUsage | undefined;
    let content = "";

    this.messages.push({ role: "user", content: userMessage });

    try {
      for (let iteration = 0; iteration < this.options.maxIterations; iteration += 1) {
        if (isAborted(askOptions.signal)) {
          this.emit("done", { reason: "cancelled", iterations });
          return { content, reason: "cancelled", iterations, toolCallsExecuted, usage };
        }

        iterations = iteration + 1;
        this.emit("iteration", { index: iterations, max: this.options.maxIterations });
        this.pruneIfNeeded();

        const turn = await collectTurn(
          this.options.chat.streamChat(this.buildRequest(), {
            ...(askOptions.signal === undefined ? {} : { signal: askOptions.signal }),
          }),
          {
            onTextDelta: (text) => {
              this.emit("assistant_delta", { text, iteration: iterations });
            },
          },
        );

        if (turn.usage !== undefined) usage = turn.usage;

        if (turn.toolCalls.length === 0) {
          content = turn.content;
          this.messages.push({ role: "assistant", content });
          this.emit("assistant_message", { content, iteration: iterations });
          this.emit("done", { reason: "final_answer", iterations });
          return { content, reason: "final_answer", iterations, toolCallsExecuted, usage };
        }

        // Record the assistant's tool-calling message before its results, in the
        // order the protocol requires.
        this.messages.push({
          role: "assistant",
          content: turn.content === "" ? null : turn.content,
          tool_calls: turn.toolCalls,
        });
        if (turn.content.trim() !== "") {
          this.emit("assistant_message", { content: turn.content, iteration: iterations });
        }

        for (const call of turn.toolCalls) {
          if (isAborted(askOptions.signal)) {
            this.emit("done", { reason: "cancelled", iterations });
            return { content, reason: "cancelled", iterations, toolCallsExecuted, usage };
          }
          const observation = await this.executeCall(call, iterations, askOptions);
          this.messages.push({
            role: "tool",
            content: observation.text,
            tool_call_id: call.id,
            name: call.function.name,
          });
          toolCallsExecuted += 1;
        }
      }

      const exhausted = [
        "I stopped after reaching the analysis step limit without a final answer.",
        "Partial findings from the completed tool calls are in the transcript above;",
        "narrow the question or raise `agent.maxIterations` to continue.",
      ].join(" ");
      this.messages.push({ role: "assistant", content: exhausted });
      this.emit("assistant_message", { content: exhausted, iteration: iterations });
      this.emit("done", { reason: "max_iterations", iterations });
      return { content: exhausted, reason: "max_iterations", iterations, toolCallsExecuted, usage };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isAborted(askOptions.signal)) {
        this.emit("done", { reason: "cancelled", iterations });
        return { content, reason: "cancelled", iterations, toolCallsExecuted, usage };
      }
      this.emit("error", { message, recoverable: false });
      this.emit("done", { reason: "failed", iterations });
      return { content, reason: "failed", iterations, toolCallsExecuted, usage };
    } finally {
      this.running = false;
    }
  }

  private buildRequest() {
    const tools: FunctionDefinition[] = [
      ...this.mapped.definitions,
      ...(this.options.extraTools ?? []),
    ];
    return {
      model: this.options.model,
      messages: [...this.messages],
      ...(tools.length === 0 ? {} : { tools, toolChoice: "auto" as const }),
      temperature: this.options.temperature,
      maxTokens: this.options.maxTokens,
    };
  }

  private async executeCall(
    call: AssistantToolCall,
    iteration: number,
    askOptions: AskOptions,
  ): Promise<ToolObservation> {
    const functionName = call.function.name;
    const mcpName = this.mapped.mcpNameFor.get(functionName) ?? functionName;

    const parsed = parseArguments(call.function.arguments);
    if (!parsed.ok) {
      this.emit("tool_call_finished", {
        id: call.id,
        name: functionName,
        mcpName,
        ok: false,
        elapsedMs: 0,
        truncated: false,
        evidenceId: undefined,
        preview: parsed.message,
      });
      return ToolObservation.fromError(parsed.message);
    }

    if (!this.options.catalog.has(mcpName)) {
      const suggestion = this.closestNames(functionName);
      const message =
        `Unknown tool "${functionName}". It is not in this REA build's catalog. ` +
        `Call one of the advertised tools instead${suggestion.length > 0 ? ` (e.g. ${suggestion.join(", ")})` : ""}.`;
      this.emit("tool_call_finished", {
        id: call.id,
        name: functionName,
        mcpName,
        ok: false,
        elapsedMs: 0,
        truncated: false,
        evidenceId: undefined,
        preview: message,
      });
      return ToolObservation.fromError(message);
    }

    // Bound the payload before it reaches the server's validator. A hostile
    // target can steer the model into emitting a huge array; this is where that
    // stops.
    const guard = checkToolArguments(
      parsed.value,
      this.options.argumentLimits ?? DEFAULT_GUARD_LIMITS,
    );
    if (!guard.ok) {
      this.emit("tool_call_finished", {
        id: call.id,
        name: functionName,
        mcpName,
        ok: false,
        elapsedMs: 0,
        truncated: false,
        evidenceId: undefined,
        preview: guard.message,
      });
      return ToolObservation.fromError(guard.message);
    }

    this.emit("tool_call_started", {
      id: call.id,
      name: functionName,
      mcpName,
      arguments: parsed.value,
      iteration,
    });

    const startedAt = performance.now();
    let observation: ToolObservation;
    try {
      const result = await this.options.connection.callTool(mcpName, parsed.value, {
        timeoutMs: this.options.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
        ...(askOptions.signal === undefined ? {} : { signal: askOptions.signal }),
      });
      observation = projectToolResult(result, {
        maxChars: this.options.maxToolResultChars,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      observation = ToolObservation.fromError(message);
    }

    this.emit("tool_call_finished", {
      id: call.id,
      name: functionName,
      mcpName,
      ok: !observation.text.startsWith(ToolObservation.errorPrefix),
      elapsedMs: Math.round(performance.now() - startedAt),
      truncated: observation.truncated,
      evidenceId: observation.evidenceId,
      preview: previewOf(observation.text),
    });

    return observation;
  }

  /** Suggestions for a mistyped tool name, based on token overlap. */
  private closestNames(requested: string): string[] {
    const wanted = new Set(requested.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
    const scored = this.options.scope.tools.map((tool) => {
      const tokens = tool.name.toLowerCase().split(/[^a-z0-9]+/);
      let score = 0;
      for (const token of tokens) if (wanted.has(token)) score += 1;
      return { name: tool.name, score };
    });
    return scored
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map((entry) => entry.name);
  }

  /**
   * Drops the oldest conversational units until the transcript fits.
   *
   * The system message and the most recent unit are always retained, even if
   * that exceeds the budget — better to send an oversized turn than an empty
   * conversation with no question in it.
   */
  private pruneIfNeeded(): void {
    const budgetChars = this.options.contextWindow * APPROX_CHARS_PER_TOKEN;
    if (this.serializedChars() <= budgetChars) return;

    const units = groupIntoUnits(this.messages);
    let dropped = 0;

    // Keep units[0] if it is the system message; always keep the last unit.
    const startIndex = this.messages[0]?.role === "system" ? 1 : 0;
    while (units.length > 1 && this.serializedChars() > budgetChars) {
      if (units.length <= (startIndex === 1 ? 2 : 1)) break;
      const removed = units[startIndex];
      if (removed === undefined) break;
      units.splice(startIndex, 1);
      dropped += removed.length;
    }

    if (dropped > 0) {
      const system = this.messages[0]?.role === "system" ? [this.messages[0]] : [];
      this.messages.length = 0;
      this.messages.push(...system, ...units.flat());
      this.emit("context_pruned", {
        droppedMessages: dropped,
        estimatedTokens: this.estimatedTranscriptTokens(),
      });
    }
  }
}

/**
 * Splits a transcript into units that must move together: a user message plus
 * every assistant/tool message up to the next user message.
 */
export function groupIntoUnits(messages: readonly ChatMessage[]): ChatMessage[][] {
  const units: ChatMessage[][] = [];
  let current: ChatMessage[] | undefined;

  for (const message of messages) {
    if (message.role === "system") {
      if (current !== undefined) units.push(current);
      units.push([message]);
      current = undefined;
      continue;
    }
    if (message.role === "user" || current === undefined) {
      if (current !== undefined) units.push(current);
      current = [message];
      continue;
    }
    current.push(message);
  }
  if (current !== undefined) units.push(current);
  return units;
}

type ParseResult =
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly message: string };

/** Parses tool-call arguments, tolerating the empty string and JSON `null`. */
export function parseArguments(raw: string): ParseResult {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, value: {} };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    return {
      ok: false,
      message:
        `The arguments for this call were not valid JSON (${(error as Error).message}). ` +
        `Retry with a single JSON object, for example {"procedure":"0x1400010a0"}.`,
    };
  }

  if (parsed === null) return { ok: true, value: {} };
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      message: "Tool arguments must be a JSON object, not an array or scalar. Retry with an object.",
    };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

/**
 * Reads `signal.aborted` through a function boundary.
 *
 * Direct property checks let TypeScript narrow the property to `false` for the
 * remainder of the function, which then reports later checks as impossible.
 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/** Convenience builder used by the CLI and by tests. */
export function createAgentSession(
  config: ReaClientConfig,
  parts: {
    readonly connection: McpConnection;
    readonly chat: ChatTransport;
    readonly catalog: ToolCatalog;
    readonly scope: ScopeResolution;
    readonly systemPrompt: string;
  },
): AgentSession {
  return new AgentSession({
    connection: parts.connection,
    chat: parts.chat,
    catalog: parts.catalog,
    scope: parts.scope,
    systemPrompt: parts.systemPrompt,
    model: config.llm.model,
    maxIterations: config.agent.maxIterations,
    maxToolResultChars: config.agent.maxToolResultChars,
    argumentLimits: {
      maxArrayItems: config.agent.maxArgumentArrayItems,
      maxBytes: config.agent.maxArgumentBytes,
    },
    temperature: config.llm.temperature,
    maxTokens: config.llm.maxTokens,
    contextWindow: config.llm.contextWindow,
  });
}
