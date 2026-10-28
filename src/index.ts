/**
 * Public surface of the REA desktop engine.
 *
 * A native shell (Rust/egui, Slint, or the headless CLI) consumes these
 * exports. Everything below the `AgentSession` boundary is transport-agnostic,
 * so the same engine drives an in-process UI or a JSON-RPC bridge.
 */

export {
  DEFAULT_CONFIG,
  ConfigError,
  loadConfig,
  parseConfig,
  type AgentConfig,
  type LlmConfig,
  type PolicyConfig,
  type ReaClientConfig,
  type ReaServerConfig,
  type ReaTransportKind,
  type ToolScopeName,
} from "./config.js";

export {
  NetworkPolicyError,
  assertLoopbackUrl,
  isLoopbackHostname,
} from "./platform/net.js";

export {
  TargetPathError,
  canonicalizeTargetPath,
  isSameTarget,
  targetCacheKey,
  toFileUrl,
  type CanonicalizeOptions,
  type PathPlatform,
} from "./platform/paths.js";

export {
  McpCallError,
  ReaClient,
  describeError,
  type McpConnection,
  type ReaClientEvents,
  type ReaClientState,
} from "./mcp/ReaClient.js";

export {
  TOOL_FAMILIES,
  ToolCatalog,
  classifyTool,
  inventoryFingerprint,
  type ScopeResolution,
  type ToolFamily,
} from "./mcp/catalog.js";

export {
  ToolObservation,
  clampWithMarker,
  isEvidenceRecord,
  projectEvidence,
  projectToolResult,
  readEvidence,
  stringifyBounded,
  type EvidenceProjection,
  type ProjectionOptions,
} from "./mcp/evidence.js";

export {
  isUntrustedContent,
  parseReaError,
  renderReaError,
  type ReaErrorEnvelope,
} from "./mcp/errors.js";

export { readBinarySession } from "./mcp/session.js";

export type {
  BinarySessionSummary,
  EvidenceRecord,
  McpCallToolResult,
  McpToolDefinition,
  ProviderAvailability,
} from "./mcp/types.js";

export { AgentSession, createAgentSession, groupIntoUnits, parseArguments } from "./agent/AgentSession.js";
export { buildSystemPrompt, type PromptContext } from "./agent/prompt.js";
export { previewOf, type AgentDoneReason, type AgentEvents } from "./agent/events.js";

export { LlmRequestError, LlamaServerClient, type LlamaServerOptions } from "./llm/LlamaServerClient.js";
export { collectTurn, type CollectOptions } from "./llm/turn.js";
export {
  buildFunctionDefinitions,
  estimateSchemaTokens,
  toFunctionName,
  type MappedToolSet,
  type SchemaMapperOptions,
} from "./llm/toolSchema.js";
export type {
  AssistantToolCall,
  AssistantTurn,
  ChatMessage,
  ChatTransport,
  FunctionDefinition,
  StreamEvent,
  StreamingChatRequest,
  TokenUsage,
} from "./llm/types.js";

export { runDoctor, type CheckResult, type CheckStatus, type DoctorReport } from "./doctor.js";

// Packaging / supply chain
export {
  MANIFEST_SCHEMA_VERSION,
  ManifestError,
  assertManifestShape,
  buildManifest,
  parseManifest,
  serializeManifest,
  sha256,
  verifyManifest,
  type BuildManifestOptions,
  type ManifestFile,
  type VendorManifest,
  type VerifyResult,
} from "./packaging/manifest.js";
export {
  RegistryError,
  buildAnchoredManifest,
  compareDirectoryToTarball,
  downloadTarball,
  fetchPackument,
  manifestFilesFromTarball,
  readPackageIdentity,
  type Packument,
  type RegistryOptions,
  type TarballComparison,
  type TarballData,
} from "./packaging/registry.js";
export { TarError, normalizeEntryPath, readTarball, type TarEntry } from "./packaging/tar.js";
export { Emitter } from "./util/emitter.js";
