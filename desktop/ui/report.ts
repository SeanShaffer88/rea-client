import type { DesktopSession, DoctorSnapshot } from "../../src/desktop/protocol.js";
import type { Message } from "./state.js";

/**
 * Analysis report assembly.
 *
 * Deliberately pure and separate from React so the exported artifact can be
 * asserted in tests: an export that silently drops evidence IDs or limitations
 * would turn "grounded analysis" into a document nobody can audit.
 */

export const REPORT_SCHEMA_VERSION = 1;

export interface ReportInput {
  readonly exportedAt: string;
  readonly engineVersion?: string;
  readonly session: DesktopSession | null;
  readonly scope: string;
  readonly overview: string | null;
  readonly overviewError: string | null;
  readonly messages: readonly Message[];
  readonly doctor?: DoctorSnapshot | null;
}

export interface ReportObservation {
  readonly tool: string;
  readonly ok: boolean;
  readonly elapsedMs: number;
  readonly truncated: boolean;
  readonly evidenceId?: string;
  readonly preview: string;
}

export interface ReportTurn {
  readonly question: string;
  readonly answer: string;
  readonly reason?: string;
  readonly error?: string;
  readonly iterations?: number;
  readonly targetPath?: string;
  readonly askedAt: string;
  readonly observations: ReportObservation[];
}

export interface Report {
  readonly schemaVersion: number;
  readonly exportedAt: string;
  readonly engineVersion?: string;
  readonly target: {
    readonly path?: string;
    readonly name?: string;
    readonly format?: string;
    readonly architecture?: string;
    readonly sha256?: string;
    readonly providerId?: string;
    readonly packageVersion?: string;
    readonly open: boolean;
  };
  readonly scope: string;
  readonly overview: string | null;
  readonly overviewError: string | null;
  readonly turns: readonly ReportTurn[];
  readonly checks?: readonly { id: string; status: string; detail: string }[];
  readonly notice: string;
}

const NOTICE =
  "Tool observations are previews projected by REA. Target-derived text is untrusted data; verify conclusions against the retained evidence before acting on them.";

function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}

/** Groups each assistant answer with the question that produced it. */
export function buildTurns(messages: readonly Message[]): ReportTurn[] {
  const turns: ReportTurn[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const question = messages[index];
    if (question?.role !== "user") continue;
    const answer = messages[index + 1]?.role === "assistant" ? messages[index + 1] : undefined;
    const observations: ReportObservation[] = [];
    for (const message of [question, answer]) {
      for (const activity of message?.activities ?? []) {
        const finish = activity.finish;
        if (!finish) continue;
        observations.push({
          tool: activity.name,
          ok: finish.ok,
          elapsedMs: Math.round(finish.elapsedMs),
          truncated: finish.truncated,
          ...(finish.evidenceId === undefined ? {} : { evidenceId: finish.evidenceId }),
          preview: finish.preview,
        });
      }
    }
    turns.push({
      question: question.content,
      answer: answer?.content ?? "",
      ...(answer?.reason === undefined ? {} : { reason: answer.reason }),
      ...(answer?.error === undefined ? {} : { error: answer.error }),
      ...(answer?.iterations === undefined ? {} : { iterations: answer.iterations }),
      ...(answer?.targetPath === undefined ? {} : { targetPath: answer.targetPath }),
      askedAt: question.time,
      observations,
    });
    if (answer) index += 1;
  }
  return turns;
}

export function buildReport(input: ReportInput): Report {
  const session = input.session;
  const path = session?.targetPath;
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    exportedAt: input.exportedAt,
    ...(input.engineVersion === undefined ? {} : { engineVersion: input.engineVersion }),
    target: {
      ...(path === undefined ? {} : { path, name: baseName(path) }),
      ...(session?.format === undefined ? {} : { format: session.format }),
      ...(session?.architecture === undefined ? {} : { architecture: session.architecture }),
      ...(session?.sha256 === undefined ? {} : { sha256: session.sha256 }),
      ...(session?.providerId === undefined ? {} : { providerId: session.providerId }),
      ...(session?.packageVersion === undefined ? {} : { packageVersion: session.packageVersion }),
      open: session?.open === true,
    },
    scope: input.scope,
    overview: input.overview,
    overviewError: input.overviewError,
    turns: buildTurns(input.messages),
    ...(input.doctor == null
      ? {}
      : { checks: input.doctor.checks.map((check: { id: string; status: string; detail: string }) => ({ id: check.id, status: check.status, detail: check.detail })) }),
    notice: NOTICE,
  };
}

function fenced(text: string): string {
  // Choose a fence longer than any backtick run inside the content so untrusted
  // observation text cannot terminate the block and inject Markdown structure.
  const runs = text.match(/`+/g) ?? [];
  const longest = runs.reduce((max, run) => Math.max(max, run.length), 2);
  const fence = "`".repeat(longest + 1);
  return `${fence}text\n${text}\n${fence}`;
}

function inline(value: string): string {
  return value.replace(/[`|<>]/g, (character) => `\\${character}`).replace(/\r?\n/g, " ");
}

export function renderMarkdownReport(report: Report): string {
  const lines: string[] = [];
  lines.push(`# REA analysis report${report.target.name === undefined ? "" : ` — ${inline(report.target.name)}`}`, "");
  lines.push(`- Exported: ${report.exportedAt}`);
  if (report.engineVersion !== undefined) lines.push(`- Engine: rea-client ${inline(report.engineVersion)}`);
  if (report.target.packageVersion !== undefined) lines.push(`- REA server: ${inline(report.target.packageVersion)}`);
  lines.push(`- Tool scope: ${inline(report.scope)}`);
  if (report.target.path !== undefined) lines.push(`- Target: \`${report.target.path}\``);
  if (report.target.format !== undefined) lines.push(`- Format: ${inline(report.target.format.toUpperCase())}`);
  if (report.target.architecture !== undefined) lines.push(`- Architecture: ${inline(report.target.architecture)}`);
  if (report.target.sha256 !== undefined) lines.push(`- SHA-256: \`${report.target.sha256}\``);
  lines.push("");

  if (report.overview !== null) {
    lines.push("## Target overview", "", fenced(report.overview), "");
  } else if (report.overviewError !== null) {
    lines.push("## Target overview", "", "REA opened the target but no overview was available:", "", fenced(report.overviewError), "");
  }

  lines.push("## Conversation", "");
  if (report.turns.length === 0) {
    lines.push("_No questions were asked in this session._", "");
  }
  for (const [index, turn] of report.turns.entries()) {
    lines.push(`### ${index + 1}. ${inline(turn.question)}`, "");
    if (turn.targetPath !== undefined) lines.push(`_Target at the time: \`${turn.targetPath}\`_`, "");
    if (turn.answer.trim() !== "") {
      lines.push(turn.answer, "");
    } else {
      lines.push("_No answer content was produced._", "");
    }
    const meta: string[] = [];
    if (turn.reason !== undefined) meta.push(`reason: ${inline(turn.reason)}`);
    if (turn.iterations !== undefined) meta.push(`steps: ${turn.iterations}`);
    if (turn.error !== undefined) meta.push(`error: ${inline(turn.error)}`);
    if (meta.length > 0) lines.push(`_${meta.join(" · ")}_`, "");
    for (const observation of turn.observations) {
      const flags = [observation.ok ? "ok" : "failed", `${observation.elapsedMs} ms`];
      if (observation.truncated) flags.push("truncated");
      if (observation.evidenceId !== undefined) flags.push(`evidence ${observation.evidenceId}`);
      lines.push(`<details><summary>${inline(observation.tool)} — ${inline(flags.join(" · "))}</summary>`, "", fenced(observation.preview), "", "</details>", "");
    }
  }

  if (report.checks !== undefined && report.checks.length > 0) {
    lines.push("## Environment checks", "", "| Check | Status | Detail |", "| --- | --- | --- |");
    for (const check of report.checks) {
      lines.push(`| ${inline(check.id)} | ${inline(check.status)} | ${inline(check.detail)} |`);
    }
    lines.push("");
  }

  lines.push("## Limitations", "", report.notice, "");
  return lines.join("\n");
}

export function reportFileName(exportedAt: string, extension: "json" | "md"): string {
  const day = exportedAt.slice(0, 10);
  const safeDay = /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : "undated";
  return `rea-analysis-${safeDay}.${extension}`;
}
