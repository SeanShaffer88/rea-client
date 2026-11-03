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
/**
 * One retained REA evidence record, as reported by the engine's
 * `get_evidence_bundle` summary. Absent fields mean REA did not report them;
 * they are not filled in with guesses.
 */
export interface RetainedEvidenceSummary {
  evidenceId: string;
  operation?: string;
  subjectName?: string;
  subjectSha256?: string;
  subjectFormat?: string;
  providerId?: string;
  confidence?: string;
  authority?: string;
  retention?: string;
  limitationCount?: number;
}
export interface EvidenceInventorySnapshot {
  ok: boolean;
  /** Present when the engine could not read the bundle. */
  error?: string;
  totalRetained: number;
  matching: number;
  unknownRevisions: number;
  records: RetainedEvidenceSummary[];
}
export interface EvidenceRecordSnapshot {
  ok: boolean;
  evidenceId: string;
  /** Pretty-printed retained record; untrusted target-derived content. */
  text: string;
  truncated: boolean;
  untrusted: boolean;
  error?: string;
}
export interface EvidenceExportSnapshot {
  ok: boolean;
  /** Absolute path of the canonical bundle the engine wrote. */
  path?: string;
  bytes?: number;
  records?: number;
  unknowns?: number;
  error?: string;
}
/** A file written into a saved case folder. */
export interface CaseFile {
  name: string;
  bytes: number;
}
/**
 * A finished analysis persisted in the workspace: the Markdown and JSON report,
 * plus REA's own canonical bundle when the engine could write one.
 */
export interface CaseSnapshot {
  ok: boolean;
  name?: string;
  /** Absolute folder the bridge created. */
  directory?: string;
  files: CaseFile[];
  /** Result of the automatic bundle export; `ok: false` explains why it is missing. */
  evidence?: { ok: boolean; path?: string; bytes?: number; records?: number; unknowns?: number; error?: string };
  /** Present when the save was refused (for example an existing case name). */
  error?: string;
}
export interface CaseTargetSummary {
  name?: string;
  path?: string;
  format?: string;
  architecture?: string;
  sha256?: string;
}
/** What a saved `analysis.json` says about itself, as far as it can be read. */
export interface CaseSummary {
  schemaVersion?: number;
  exportedAt?: string;
  engineVersion?: string;
  scope?: string;
  target: CaseTargetSummary;
  turns: number;
  observations: number;
  evidenceReferences: number;
}
export interface SavedCase {
  name: string;
  directory: string;
  savedAt: string;
  files: CaseFile[];
  summary?: CaseSummary;
}
/** A saved case read back from disk. */
export interface CaseOpenSnapshot {
  ok: boolean;
  name: string;
  directory?: string;
  savedAt?: string;
  files: CaseFile[];
  summary?: CaseSummary;
  /** Saved Markdown report; absent if the folder had none. */
  report?: string;
  reportTruncated?: boolean;
  reportJson?: string;
  jsonTruncated?: boolean;
  bundle?: { path: string; bytes: number; records?: number; unknowns?: number };
  error?: string;
}
export interface CaseListSnapshot {
  ok: boolean;
  casesRoot: string;
  cases: SavedCase[];
  total: number;
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
