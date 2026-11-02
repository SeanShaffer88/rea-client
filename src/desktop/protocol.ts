import type { ToolScopeName } from "../config.js";
import type { CheckResult } from "../doctor.js";
import type { BinarySessionSummary, McpToolDefinition, ProviderAvailability } from "../mcp/types.js";
import type { AgentDoneReason } from "../agent/events.js";
import type { TokenUsage } from "../llm/types.js";

export type DesktopSession = Omit<BinarySessionSummary, "raw">;
export interface ToolSummary {
  name: string;
  title: string;
  description: string;
  family: string;
  readOnly: boolean;
  destructive: boolean;
}
export interface CatalogSnapshot {
  total: number;
  families: Array<{ id: string; label: string; count: number; tools?: string[] }>;
  scope: { name: ToolScopeName; count: number; missing: string[]; names?: string[] };
  entries?: ToolSummary[];
}
export interface ToolDetail {
  tool: McpToolDefinition;
  family: string;
  inScope: boolean;
}
export interface TargetSnapshot {
  ok: boolean;
  observation?: string;
  open?: string;
  overview?: string | null;
  /** Set when the target opened but REA's overview provider was unavailable. */
  overviewError?: string;
  session: DesktopSession | null;
}
export interface TranscriptSnapshot {
  messages: Array<{ role: string; content: string | null }>;
  estimatedTokens?: number;
}
export interface AskSnapshot {
  content: string;
  reason: AgentDoneReason;
  error?: string;
  iterations: number;
  toolCallsExecuted: number;
  usage: TokenUsage | null;
  transcriptLength: number;
}
export interface DesktopConfig {
  model: string;
  baseUrl: string;
  contextWindow: number;
  maxIterations: number;
  toolScope: ToolScopeName;
  customTools: string[];
  allowNonLoopback: boolean;
  workspaceDir: string;
  configPath: string;
  transport: string;
}
export interface Bootstrap {
  token: string;
  mode: "desktop" | "browser";
  version: string;
  platform: string;
  config: DesktopConfig;
}
export interface DesktopEvent {
  id: number;
  method: string;
  params: Record<string, unknown>;
  time: string;
}
export interface EngineStatus {
  ok: boolean;
  version: string;
  pid: number;
  connected: boolean;
  running: boolean;
}
export interface DoctorSnapshot {
  healthy: boolean;
  checks: CheckResult[];
  catalogSize?: number;
  serverVersion?: string;
  providers?: Array<Pick<ProviderAvailability, "id" | "available">>;
}
