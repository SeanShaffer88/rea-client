import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Activity, ArrowDownToLine, ArrowRight, ArrowUp, Blocks, BookOpen, Box, Braces,
  Check, CheckCircle2, ChevronDown, ChevronRight, CircleHelp, CircleStop, Clock3,
  Code2, Cpu, Database, FileArchive, FileCode2, FileSearch, FolderOpen, HardDrive,
  Layers3, LayoutDashboard, LoaderCircle, LockKeyhole, MessageSquare, MoreHorizontal,
  Network, Plus, RefreshCw, Search, Settings2, ShieldCheck, SlidersHorizontal,
  Sparkles, SquareTerminal, Stethoscope, Trash2, Upload, Workflow, X, AlertCircle,
} from 'lucide-react';
import { bootstrap, readStored, rpc, store, subscribeEvents, uploadBinary } from './api';
import { Badge, Button, CodePanel, CopyButton, EmptyState, ErrorNotice, Modal, ToolActivityView, fileName, formatBytes } from './components';
import { chatReducer, initialChat, messagesFromTranscript, type Message } from './state';
import { buildReport, renderMarkdownReport, reportFileName } from './report';
import { planDrop } from './drop';
import { describeEvidenceExport, describeRetainedCounts, evidenceExportConflict, filterRetainedRecords, relativeToWorkspace, shortEvidenceId } from './evidence';
import { caseDownloadName, caseLocation, describeCaseDeletion, filterSavedCases, caseNameConflict, caseNameProblem, defaultCaseName, describeCaseSave, describeCaseStats, describeCaseTarget, describeSavedCase, shortDigest } from './cases';
import type { AskSnapshot, Bootstrap, CaseDeleteSnapshot, CaseListSnapshot, CaseOpenSnapshot, CaseSnapshot, CatalogSnapshot, DesktopEvent, DesktopSession, DoctorSnapshot, EngineStatus, EvidenceExportSnapshot, EvidenceInventorySnapshot, EvidenceRecordSnapshot, TargetSnapshot, ToolDetail, TranscriptSnapshot } from '../../src/desktop/protocol';
import type { ToolScopeName } from '../../src/config';

type Page = 'workspace' | 'tools' | 'evidence' | 'diagnostics' | 'settings';
const PAGE_NAMES: Record<Page, string> = { workspace: 'Analysis workspace', tools: 'Tool catalog', evidence: 'Evidence explorer', diagnostics: 'Diagnostics', settings: 'Settings' };
const NAV = [
  { id: 'workspace' as const, label: 'Workspace', icon: LayoutDashboard },
  { id: 'tools' as const, label: 'Tool catalog', icon: Blocks },
  { id: 'evidence' as const, label: 'Evidence', icon: Database },
  { id: 'diagnostics' as const, label: 'Diagnostics', icon: Stethoscope },
];
const PROMPTS = [
  { icon: FileSearch, title: 'Understand this binary', text: 'Give me an evidence-backed overview of this binary. What does it do, and what should I investigate first?' },
  { icon: Workflow, title: 'Trace the entry point', text: 'Trace the main entry point and explain the important function calls. Cite the evidence you use.' },
  { icon: ShieldCheck, title: 'Find interesting behavior', text: 'Look for security-relevant behavior in this binary. Distinguish verified findings from unknowns.' },
];
const shortScope = (scope: string): string => scope === 'binary-core' ? 'Binary core' : scope === 'binary-extended' ? 'Extended' : scope === 'full' ? 'Full catalog' : 'Custom';

export default function App() {
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [bootError, setBootError] = useState('');
  const [page, setPage] = useState<Page>('workspace');
  const [engine, setEngine] = useState<EngineStatus | null>(null);
  const [connected, setConnected] = useState(false);
  const [session, setSession] = useState<DesktopSession | null>(null);
  const [catalog, setCatalog] = useState<CatalogSnapshot | null>(null);
  const [doctor, setDoctor] = useState<DoctorSnapshot | null>(null);
  const [checking, setChecking] = useState(false);
  const [opening, setOpening] = useState(false);
  const [overview, setOverview] = useState<string | null>(null);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [targetTab, setTargetTab] = useState<'conversation' | 'overview'>('conversation');
  const [openDialog, setOpenDialog] = useState(false);
  const [help, setHelp] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [events, setEvents] = useState<DesktopEvent[]>([]);
  const [chat, dispatch] = useReducer(chatReducer, initialChat);
  const [question, setQuestion] = useState('');
  const [scope, setScope] = useState<ToolScopeName>('binary-core');
  const [instructions, setInstructions] = useState(() => readStored<string>('instructions', ''));
  const [recent, setRecent] = useState<string[]>(() => { const value = readStored<unknown>('recent', []); return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').slice(0, 5) : []; });
  const [confirm, setConfirm] = useState<'reset' | 'close' | null>(null);
  const [scopePending, setScopePending] = useState<ToolScopeName | null>(null);
  const [toolQuery, setToolQuery] = useState('');
  const [toolFamily, setToolFamily] = useState('all');
  const [scopedOnly, setScopedOnly] = useState(false);
  const [selectedTool, setSelectedTool] = useState<string | null>(null);
  const [toolDetail, setToolDetail] = useState<ToolDetail | null>(null);
  const [toolLoading, setToolLoading] = useState(false);
  const [toolError, setToolError] = useState('');
  const [evidenceQuery, setEvidenceQuery] = useState('');
  const [retained, setRetained] = useState<EvidenceInventorySnapshot | null>(null);
  const [retainedBusy, setRetainedBusy] = useState(false);
  const [retainedError, setRetainedError] = useState('');
  const [openEvidenceId, setOpenEvidenceId] = useState<string | null>(null);
  const [record, setRecord] = useState<EvidenceRecordSnapshot | null>(null);
  const [recordBusy, setRecordBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportConflict, setExportConflict] = useState(false);
  const [cases, setCases] = useState<CaseListSnapshot | null>(null);
  const [casesBusy, setCasesBusy] = useState(false);
  const [caseError, setCaseError] = useState('');
  const [savingCase, setSavingCase] = useState(false);
  const [caseConflict, setCaseConflict] = useState<string | null>(null);
  const [caseDialog, setCaseDialog] = useState(false);
  const [caseName, setCaseName] = useState('');
  const [caseBundle, setCaseBundle] = useState(true);
  const [caseNameError, setCaseNameError] = useState('');
  const [openedCase, setOpenedCase] = useState<CaseOpenSnapshot | null>(null);
  const [openingCase, setOpeningCase] = useState<string | null>(null);
  const [caseJsonShown, setCaseJsonShown] = useState(false);
  const [caseQuery, setCaseQuery] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deletingCase, setDeletingCase] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [dropping, setDropping] = useState(false);
  const chatEnd = useRef<HTMLDivElement>(null);
  const questionRef = useRef<HTMLTextAreaElement>(null);
  const toolSearchRef = useRef<HTMLInputElement>(null);
  const seenEvents = useRef(new Set<number>());
  const booting = useRef(false);
  const doctorRequested = useRef(false);

  const initialize = useCallback(async () => {
    if (booting.current) return;
    booting.current = true;
    setBootError('');
    try {
      const result = await bootstrap();
      setBoot(result);
      setScope(result.config.toolScope);
      const [tools, target] = await Promise.all([rpc<CatalogSnapshot>('tools.list', { includeDetails: true }), rpc<TargetSnapshot>('target.session')]);
      const status = await rpc<EngineStatus>('engine.ping');
      setCatalog(tools); setSession(target.session); setEngine(status); setConnected(true);
      // A reload keeps the engine alive; restore what was already discussed.
      const transcript = await rpc<TranscriptSnapshot>('agent.transcript').catch(() => null);
      const restored = transcript ? messagesFromTranscript(transcript.messages) : [];
      if (restored.length > 0) {
        dispatch({ type: 'hydrate', messages: restored });
        setToast('Previous conversation restored from the engine');
      }
    } catch (cause) {
      const message = (cause as Error).message;
      setBootError(message);
      // When bootstrap already succeeded, the shell is rendered and the error
      // notice is the only place the failure is visible.
      setError(message);
    }
    finally { booting.current = false; }
  }, []);

  useEffect(() => { void initialize(); }, [initialize]);
  useEffect(() => {
    if (!boot) return;
    const controller = new AbortController();
    void subscribeEvents(controller.signal, (event) => {
      if (seenEvents.current.has(event.id)) return;
      seenEvents.current.add(event.id);
      if (seenEvents.current.size > 1000) seenEvents.current.delete(Math.min(...seenEvents.current));
      setEvents((previous) => [...previous, event].slice(-300));
      dispatch({ type: 'event', event });
      if (event.method === 'engine.disconnected') { setConnected(false); setError(String(event.params.message)); dispatch({ type: 'interrupt', error: 'The REA engine stopped before this turn finished. Reconnect to continue.' }); }
    }, setConnected);
    return () => controller.abort();
  }, [boot]);

  const runDoctor = useCallback(async (skipLlm = false) => {
    doctorRequested.current = true;
    setChecking(true);
    try { const result = await rpc<DoctorSnapshot>('engine.doctor', { skipLlm }); setDoctor(result); return result; }
    catch (cause) { setError((cause as Error).message); return null; }
    finally { setChecking(false); }
  }, []);
  useEffect(() => { if (boot && connected && !doctor && !checking && !doctorRequested.current) void runDoctor(); }, [boot, connected, doctor, checking, runDoctor]);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(''), 3500); return () => clearTimeout(timer); }, [toast]);
  useEffect(() => { const end = chatEnd.current; if (typeof end?.scrollIntoView === 'function') end.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [chat.messages]);
  useEffect(() => {
    const dragging = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes('Files');
    const onDragOver = (event: DragEvent) => { if (dragging(event)) { event.preventDefault(); setDropping(true); } };
    const onDragLeave = (event: DragEvent) => { if (event.relatedTarget === null) setDropping(false); };
    const onDrop = (event: DragEvent) => {
      if (!dragging(event)) return;
      event.preventDefault();
      setDropping(false);
      const file = event.dataTransfer?.files?.[0];
      if (!file) return;
      void acceptDrop(file);
    };
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [boot?.mode, opening, chat.running, session?.targetPath]);

  async function acceptDrop(file: File): Promise<void> {
    if (!boot) return;
    if (chat.running) { setToast('Wait for the current turn to finish before opening another target.'); return; }
    if (opening) return;
    const path = boot.mode === 'desktop' ? window.reaDesktop?.pathForFile?.(file) ?? null : null;
    const plan = planDrop({ mode: boot.mode, singleFile: true, size: file.size, path });
    if (plan.kind === 'reject') { setError(plan.reason); return; }
    setOpening(true); setError('');
    try {
      if (plan.kind === 'upload') {
        const uploaded = await uploadBinary(file);
        setOpening(false);
        await openTarget(uploaded.path);
        return;
      }
      setOpening(false);
      await openTarget(plan.path);
    } catch (cause) { setError((cause as Error).message); }
    finally { setOpening(false); }
  }

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'o') { event.preventDefault(); if (!chat.running) setOpenDialog(true); }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setPage('tools'); setTimeout(() => toolSearchRef.current?.focus(), 50); }
    };
    window.addEventListener('keydown', keydown); return () => window.removeEventListener('keydown', keydown);
  }, [chat.running]);
  useEffect(() => {
    if (!selectedTool) { setToolDetail(null); return; }
    let active = true;
    setToolLoading(true); setToolError('');
    rpc<ToolDetail>('tools.describe', { name: selectedTool }).then((detail) => { if (active) setToolDetail(detail); }).catch((cause: Error) => { if (active) setToolError(cause.message); }).finally(() => { if (active) setToolLoading(false); });
    return () => { active = false; };
  }, [selectedTool]);

  const doctorChecks = Array.isArray(doctor?.checks) ? doctor.checks : [];
  const llmCheck = doctorChecks.find((check) => check.id === 'llm');
  const modelReady = llmCheck?.status === 'ok';
  const activityEntries = useMemo(
    () => chat.messages.flatMap((message) => message.activities.filter((activity) => activity.finish !== undefined).map((activity) => ({ activity, targetPath: message.targetPath }))),
    [chat.messages],
  );
  const loadRetained = useCallback(async (): Promise<EvidenceInventorySnapshot | null> => {
    setRetainedBusy(true); setRetainedError('');
    try {
      const result = await rpc<EvidenceInventorySnapshot>('evidence.list');
      setRetained(result);
      if (!result.ok) setRetainedError(result.error ?? 'REA could not read its retained evidence.');
      return result;
    } catch (cause) {
      setRetainedError((cause as Error).message);
      return null;
    } finally { setRetainedBusy(false); }
  }, []);

  // Reload when the evidence page opens, after each completed turn, and when a
  // different target is opened: those are the only moments the bundle changes.
  const completedTurns = chat.messages.filter((message) => message.role === 'assistant' && message.reason !== undefined).length;
  const retainedKey = useRef('');
  useEffect(() => {
    if (page !== 'evidence' || !connected) return;
    const key = `${session?.sha256 ?? 'no-target'}:${completedTurns}`;
    if (retainedKey.current === key) return;
    retainedKey.current = key;
    void loadRetained();
  }, [page, connected, session?.sha256, completedTurns, loadRetained]);

  async function toggleRecord(evidenceId: string): Promise<void> {
    if (openEvidenceId === evidenceId) { setOpenEvidenceId(null); setRecord(null); return; }
    setOpenEvidenceId(evidenceId); setRecord(null); setRecordBusy(true);
    try {
      const result = await rpc<EvidenceRecordSnapshot>('evidence.get', { evidenceId });
      setRecord(result);
    } catch (cause) {
      setRecord({ ok: false, evidenceId, text: '', truncated: false, untrusted: true, error: (cause as Error).message });
    } finally { setRecordBusy(false); }
  }

  async function exportBundle(overwrite = false): Promise<void> {
    if (exporting) return;
    setExporting(true); setError(''); setExportConflict(false);
    try {
      // The engine chooses the directory inside the workspace; the renderer
      // never names a path outside it.
      const result = await rpc<EvidenceExportSnapshot>('evidence.export', overwrite ? { overwrite: true } : {});
      if (!result.ok) {
        const message = result.error ?? 'REA could not export the evidence bundle.';
        setError(message);
        setExportConflict(evidenceExportConflict(message));
        return;
      }
      setToast(describeEvidenceExport(result, boot?.config.workspaceDir ?? ''));
    } catch (cause) {
      const message = (cause as Error).message;
      setError(message);
      setExportConflict(evidenceExportConflict(message));
    } finally { setExporting(false); }
  }

  const loadCases = useCallback(async (): Promise<CaseListSnapshot | null> => {
    setCasesBusy(true);
    try {
      const result = await rpc<CaseListSnapshot>('case.list');
      setCases(result);
      return result;
    } catch (cause) {
      setCaseError((cause as Error).message);
      return null;
    } finally { setCasesBusy(false); }
  }, []);

  useEffect(() => {
    if (page !== 'evidence' || !connected) return;
    void loadCases();
  }, [page, connected, loadCases]);

  function openCaseDialog(): void {
    if (!boot) return;
    setCaseName(defaultCaseName(session?.targetPath));
    setCaseNameError(''); setCaseError(''); setCaseConflict(null);
    setCaseBundle(true);
    setCaseDialog(true);
  }

  async function saveCase(overwriteName?: string): Promise<void> {
    if (savingCase) return;
    const name = (overwriteName ?? caseName).trim();
    const problem = caseNameProblem(name);
    if (problem !== null) { setCaseNameError(problem); return; }
    setSavingCase(true); setError(''); setCaseError(''); setCaseConflict(null); setCaseNameError('');
    try {
      const report = buildAnalysisReport();
      const result = await rpc<CaseSnapshot>('case.save', {
        ...(overwriteName === undefined ? {} : { overwrite: true }),
        name,
        report: renderMarkdownReport(report),
        reportJson: JSON.stringify(report, null, 2),
        includeEvidence: caseBundle,
      });
      if (!result.ok) {
        const message = result.error ?? 'The case could not be saved.';
        setCaseError(message);
        if (overwriteName === undefined && caseNameConflict(message)) setCaseConflict(name);
        return;
      }
      setCaseDialog(false);
      setToast(describeCaseSave(result, boot?.config.workspaceDir ?? ''));
      setCaseError(result.evidence?.ok === false && result.evidence.error ? `The report was saved, but REA could not write the evidence bundle: ${result.evidence.error}` : '');
      await loadCases();
    } catch (cause) {
      setCaseError((cause as Error).message);
    } finally { setSavingCase(false); }
  }

  async function viewCase(name: string): Promise<void> {
    if (openingCase !== null) return;
    setOpeningCase(name); setCaseError(''); setCaseJsonShown(false);
    try {
      const result = await rpc<CaseOpenSnapshot>('case.open', { name });
      setOpenedCase({ ...result, files: Array.isArray(result.files) ? result.files : [] });
    } catch (cause) {
      setOpenedCase({ ok: false, name, files: [], error: (cause as Error).message });
    } finally { setOpeningCase(null); }
  }

  function downloadCaseJson(): void {
    const snapshot = openedCase;
    if (snapshot?.reportJson === undefined) return;
    const url = URL.createObjectURL(new Blob([snapshot.reportJson], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = caseDownloadName(snapshot.name);
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    setToast(`${caseDownloadName(snapshot.name)} downloaded`);
  }

  async function deleteCase(name: string): Promise<void> {
    if (deletingCase) return;
    setDeletingCase(true); setError(''); setCaseError('');
    try {
      const result = await rpc<CaseDeleteSnapshot>('case.delete', { name });
      if (!result.ok) { setCaseError(result.error ?? 'The case could not be deleted.'); return; }
      setDeleteTarget(null);
      setOpenedCase(null);
      setToast(`${name} deleted from the workspace`);
      await loadCases();
    } catch (cause) {
      setCaseError((cause as Error).message);
    } finally { setDeletingCase(false); }
  }

  const evidence = useMemo(() => [
    ...(overview && !overviewError && session?.open ? [{ id: 'target-overview', name: 'binary_overview', text: overview, target: session.targetPath ?? 'Current target', time: '', evidenceId: undefined as string | undefined, ok: true }] : []),
    ...activityEntries.map(({ activity, targetPath }) => ({ id: activity.id, name: activity.name, text: activity.finish!.preview, target: targetPath ?? 'Target not recorded', time: activity.time, evidenceId: activity.finish!.evidenceId, ok: activity.finish!.ok })),
  ].filter((entry) => `${entry.name} ${entry.text} ${entry.evidenceId ?? ''}`.toLowerCase().includes(evidenceQuery.toLowerCase())), [activityEntries, overview, session, evidenceQuery]);

  async function openTarget(path: string): Promise<void> {
    if (!path.trim() || opening || chat.running) return;
    setOpening(true); setError('');
    try {
      const result = await rpc<TargetSnapshot>('target.probe', { path: path.trim() });
      setSession(result.session);
      if (!result.ok) { setError(result.open ?? result.observation ?? 'REA could not open this target.'); return; }
      setOverview(result.overview ?? null); setOverviewError(result.overviewError ?? null); setOpenDialog(false); setTargetTab('conversation'); setPage('workspace');
      const actualPath = result.session?.targetPath ?? path;
      setRecent((previous) => { const next = [actualPath, ...previous.filter((item) => item !== actualPath)].slice(0, 5); store('recent', next); return next; });
      setToast(`${fileName(actualPath)} is ready to analyze`);
      setConnected(true);
    } catch (cause) { setError((cause as Error).message); }
    finally { setOpening(false); }
  }
  async function closeTarget(): Promise<void> {
    setConfirm(null);
    try { const result = await rpc<TargetSnapshot>('target.close'); setSession(result.session); setOverview(null); setOverviewError(null); if (!result.ok) setError(result.observation ?? 'Could not close target.'); else setToast('Target closed. Conversation history is preserved.'); }
    catch (cause) { setError((cause as Error).message); }
  }
  async function ask(text = question): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed || chat.running || !connected) return;
    setError(''); setQuestion(''); setTargetTab('conversation');
    const id = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    dispatch({ type: 'ask', id, question: trimmed, time: new Date().toISOString(), ...(session?.targetPath === undefined ? {} : { targetPath: session.targetPath }) });
    try {
      const result = await rpc<AskSnapshot>('agent.ask', { question: trimmed, scope, extraInstructions: instructions, clientRequestId: id });
      dispatch({ type: 'complete', id, ...result });
      const status = await rpc<EngineStatus>('engine.ping'); setEngine(status);
    } catch (cause) { dispatch({ type: 'fail', id, error: (cause as Error).message }); }
  }
  async function resetChat(): Promise<void> {
    setConfirm(null);
    try { await rpc('agent.reset', { scope }); dispatch({ type: 'reset' }); setToast('New conversation started'); }
    catch (cause) { setError((cause as Error).message); }
  }
  async function changeScope(next: ToolScopeName): Promise<void> {
    setScopePending(null);
    try { await rpc('agent.reset', { scope: next }); setScope(next); dispatch({ type: 'reset' }); setCatalog(await rpc<CatalogSnapshot>('tools.list', { includeDetails: true })); setToast(`${shortScope(next)} scope applied. Conversation reset.`); }
    catch (cause) { setError((cause as Error).message); }
  }
  async function reconnect(): Promise<void> {
    setChecking(true); setError('');
    try {
      // A restarted gateway issues a new session token, so re-bootstrap before
      // retrying authenticated calls.
      const fresh = await bootstrap();
      setBoot(fresh); setScope(fresh.config.toolScope);
      const [tools, target] = await Promise.all([rpc<CatalogSnapshot>('tools.list', { includeDetails: true }), rpc<TargetSnapshot>('target.session')]);
      const status = await rpc<EngineStatus>('engine.ping');
      setCatalog(tools); setSession(target.session); setEngine(status); setConnected(true);
      await runDoctor(); setToast('Engine connection restored');
    } catch (cause) { setError((cause as Error).message); }
    finally { setChecking(false); }
  }
  function buildAnalysisReport() {
    const exportedAt = new Date().toISOString();
    return buildReport({ exportedAt, ...(engine?.version === undefined ? {} : { engineVersion: engine.version }), session, scope, overview, overviewError, messages: chat.messages, doctor });
  }
  function downloadReport(format: 'md' | 'json'): void {
    const report = buildAnalysisReport();
    const body = format === 'md' ? renderMarkdownReport(report) : JSON.stringify(report, null, 2);
    const type = format === 'md' ? 'text/markdown;charset=utf-8' : 'application/json';
    const url = URL.createObjectURL(new Blob([body], { type }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = reportFileName(report.exportedAt, format);
    anchor.click();
    // Revoke late enough for the download to start in every browser.
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    setToast(format === 'md' ? 'Markdown report exported' : 'JSON report exported');
  }

  if (!boot) return <div className="boot-screen"><div className="brand-mark large"><Braces size={32} /></div><h1>REA Workspace</h1>{bootError ? <><ErrorNotice>{bootError}</ErrorNotice><Button onClick={() => void initialize()}><RefreshCw size={16} />Retry connection</Button><p className="muted">Start the local service with <code>npm run desktop:web</code>.</p></> : <><LoaderCircle className="spin" size={22} /><p>Connecting to your local engine…</p></>}</div>;

  // The bridge is a separate process; treat its snapshot as untrusted input and
  // degrade rather than crash if a field is missing.
  const catalogTools = Array.isArray(catalog?.entries) ? catalog.entries : [];
  const catalogFamilies = Array.isArray(catalog?.families) ? catalog.families : [];
  const scopeNames = Array.isArray(catalog?.scope?.names) ? catalog.scope.names : [];
  const scopeCount = typeof catalog?.scope?.count === 'number' ? catalog.scope.count : null;
  const catalogTotal = typeof catalog?.total === 'number' ? catalog.total : null;
  const filteredTools = catalogTools.filter((tool) => (toolFamily === 'all' || tool.family === toolFamily) && (!scopedOnly || scopeNames.includes(tool.name)) && `${tool.name} ${tool.title} ${tool.description}`.toLowerCase().includes(toolQuery.toLowerCase()));
  const targetName = session?.open && session.targetPath ? fileName(session.targetPath) : null;

  return <div className="app-shell">
    <aside className="sidebar">
      <a className="brand" href="#workspace" onClick={(event) => { event.preventDefault(); setPage('workspace'); }}><span className="brand-mark"><Braces size={24} strokeWidth={2.3} /></span><span className="brand-word">rea<span className="brand-period">.</span></span><span className="brand-tag">WORKSPACE</span></a>
      <div className="workspace-switch"><span className="workspace-avatar"><SquareTerminal size={17} /></span><div><strong>Local workspace</strong><span>Personal environment</span></div><LockKeyhole size={13} /></div>
      <div className="nav-section-label">WORKBENCH</div>
      <nav aria-label="Main navigation">{NAV.map(({ id, label, icon: Icon }) => <button key={id} className={`nav-item ${page === id ? 'active' : ''}`} onClick={() => setPage(id)} aria-current={page === id ? 'page' : undefined}><Icon size={18} strokeWidth={1.7} /><span>{label}</span>{id === 'tools' && catalogTotal !== null && <span className="nav-count">{catalogTotal}</span>}{id === 'evidence' && evidence.length > 0 && <span className="nav-count">{evidence.length}</span>}{id === 'diagnostics' && doctorChecks.some((check) => check.status === 'fail') && <span className="nav-alert" />}</button>)}</nav>
      <div className="sidebar-recents"><div className="nav-section-label">RECENT TARGETS <button aria-label="Open a recent target" className="tiny-icon" onClick={() => setOpenDialog(true)} disabled={chat.running}><Plus size={14} /></button></div>{recent.length ? recent.slice(0, 3).map((path) => <button className="recent-item" key={path} onClick={() => void openTarget(path)} disabled={opening || chat.running} title={path}><FileCode2 size={15} /><span>{fileName(path)}</span></button>) : <p className="no-recents">Your analyzed binaries<br />will appear here.</p>}</div>
      <div className="sidebar-bottom"><div className="local-card"><span className="local-card-icon"><ShieldCheck size={19} /></span><strong>Local by design</strong><p>Your binaries stay yours.<br />No cloud. No compromises.</p><span className="local-card-status"><span className={`status-dot ${boot.config.allowNonLoopback ? 'amber' : ''}`} />{boot.config.allowNonLoopback ? 'Custom network policy' : 'Air-gap policy enabled'}</span></div><button className={`nav-item ${page === 'settings' ? 'active' : ''}`} onClick={() => setPage('settings')}><Settings2 size={18} /><span>Settings</span></button><button className="nav-item" onClick={() => setHelp(true)}><CircleHelp size={18} /><span>Help & shortcuts</span><span className="nav-count">?</span></button><div className="sidebar-version"><span>REA CLIENT</span><span>v{boot.version}</span></div></div>
    </aside>

    <div className="main-shell">
      <header className="topbar"><div className="breadcrumb"><span>Workspace</span><ChevronRight size={13} /><strong>{PAGE_NAMES[page]}</strong></div><div className="topbar-actions"><span className="private-session"><LockKeyhole size={13} />Private session</span><span className="topbar-divider" /><button className="icon-button" aria-label="Open help" onClick={() => setHelp(true)}><CircleHelp size={18} /></button><span className="user-avatar">L</span></div></header>
      <main className={`main-content page-${page}`}>
        <div className="page-heading"><div><div className="eyebrow">YOUR LOCAL REVERSE ENGINEERING WORKBENCH</div><h1>{PAGE_NAMES[page]}</h1><p>{page === 'workspace' ? 'Open a binary. Ask questions. Follow the evidence.' : page === 'tools' ? 'The right instrument for every layer of your investigation.' : page === 'evidence' ? 'Every observation, connected to the target it came from.' : page === 'diagnostics' ? 'A clear view of the engine, providers, and local model.' : 'Your environment. Your boundaries. Your way of working.'}</p></div><div className="heading-actions">{page === 'workspace' ? <><Button className="inspector-toggle" onClick={() => setInspectorOpen(!inspectorOpen)}><SlidersHorizontal size={16} />Inspector</Button><Button variant="primary" onClick={() => setOpenDialog(true)} disabled={opening || chat.running}><Plus size={17} />Open binary<span className="key-hint">⌘ O</span></Button></> : page === 'evidence' ? <><Button onClick={() => downloadReport('json')} disabled={!session && !chat.messages.length}><ArrowDownToLine size={16} />JSON</Button><Button onClick={() => downloadReport('md')} disabled={!session && !chat.messages.length}><FileCode2 size={16} />Export report</Button><Button variant="primary" onClick={openCaseDialog} disabled={savingCase}><HardDrive size={16} />Save case…</Button></> : page === 'diagnostics' ? <Button variant="primary" onClick={() => void runDoctor()} disabled={checking}><RefreshCw size={16} className={checking ? 'spin' : ''} />{checking ? 'Running checks…' : 'Run diagnostics'}</Button> : page === 'tools' ? <Badge tone="green"><span className="status-dot" />Live inventory</Badge> : null}</div></div>
        {error && <ErrorNotice onDismiss={() => setError('')}>{error}</ErrorNotice>}
        {!connected && <div className="connection-banner"><AlertCircle size={17} /><span>Engine disconnected. Your conversation is still here.</span><Button onClick={() => void reconnect()} disabled={checking}><RefreshCw size={14} className={checking ? 'spin' : ''} />Reconnect</Button></div>}

        {page === 'workspace' && <div className={`workspace-layout ${inspectorOpen ? 'inspector-visible' : ''}`}>
          <section className="analysis-panel">
            {targetName ? <div className="target-header"><div className="target-file-icon"><FileCode2 size={24} /></div><div className="target-heading"><div><h2>{targetName}</h2><Badge tone="green"><span className="status-dot" />Open</Badge></div><p title={session?.targetPath}>{session?.targetPath}</p></div><button className="icon-button" title="Close target" aria-label="Close target" disabled={chat.running} onClick={() => setConfirm('close')}><X size={17} /></button></div> : <div className="no-target-bar"><span><Box size={16} />No target opened</span><span>Start with a binary on your machine</span></div>}
            <div className="analysis-tabs"><div role="tablist" aria-label="Target view"><button role="tab" aria-selected={targetTab === 'conversation'} className={targetTab === 'conversation' ? 'selected' : ''} onClick={() => setTargetTab('conversation')}><MessageSquare size={15} />Conversation{chat.messages.length > 0 && <span className="tab-count">{chat.messages.filter((message) => message.role === 'user').length}</span>}</button><button role="tab" aria-selected={targetTab === 'overview'} className={targetTab === 'overview' ? 'selected' : ''} onClick={() => setTargetTab('overview')}><Layers3 size={15} />Target overview</button></div><button className="text-button new-chat" disabled={chat.running || !chat.messages.length} onClick={() => setConfirm('reset')}><Plus size={14} />New conversation</button></div>
            <div className="analysis-scroll">
              {targetTab === 'overview' ? <div className="overview-content">{overview ? <><div className="untrusted-note"><ShieldCheck size={16} /><span>Target-derived content is untrusted. Verify findings against retained evidence.</span></div><CodePanel text={overview} label="binary_overview" /></> : overviewError ? <div className="overview-failure"><span className="overview-failure-icon"><AlertCircle size={23} /></span><h3>Target opened, but no overview was available.</h3><p>REA opened the file and reported its format, but the active analysis provider could not run <code>binary_overview</code>. The target session stays open. Configure an available provider, then run Diagnostics.</p><CodePanel text={overviewError} label="binary_overview error" /><Button onClick={() => setPage('diagnostics')}><Stethoscope size={15} />Open diagnostics</Button></div> : <EmptyState icon={<Layers3 size={28} />} title="A closer look starts here">Open a binary to inspect its real format, architecture, and analysis surface.</EmptyState>}</div> : !targetName && !chat.messages.length ? <div className="welcome-content"><div className="welcome-art" aria-hidden="true"><div className="orbit orbit-one" /><div className="orbit orbit-two" /><span className="art-node node-one"><Code2 size={16} /></span><span className="art-node node-two"><Database size={15} /></span><span className="art-node node-three"><ShieldCheck size={16} /></span><div className="welcome-art-core"><FileSearch size={37} strokeWidth={1.4} /></div><span className="art-spark spark-one" /><span className="art-spark spark-two" /></div><Badge tone="green"><Sparkles size={12} />POWERED BY LOCAL INTELLIGENCE</Badge><h2>Big questions.<br /><span>Binary-level answers.</span></h2><p>Turn complex binaries into clear, evidence-backed insights.<br className="desktop-break" />Your files and your models never have to leave your machine.</p><div className="welcome-actions"><Button variant="primary" onClick={() => setOpenDialog(true)} disabled={opening}><FolderOpen size={17} />Open a binary<ArrowRight size={16} /></Button><span>or explore the <button onClick={() => setPage('tools')}>tool catalog<ArrowRight size={12} /></button></span></div>{boot.mode === 'browser' && boot.platform !== 'win32' && <button className="sample-link" onClick={() => void openTarget('/usr/bin/ls')} disabled={opening}>{opening ? <LoaderCircle size={13} className="spin" /> : <SquareTerminal size={13} />}Try with a system binary <code>/usr/bin/ls</code><ArrowRight size={12} /></button>}<div className="welcome-features"><span><ShieldCheck size={15} />Evidence-first</span><span><Cpu size={15} />Local models</span><span><LockKeyhole size={15} />Private by default</span></div></div> : !chat.messages.length ? <div className="ready-content"><div className="ready-label"><CheckCircle2 size={17} />Target ready. Let curiosity take it from here.</div><h2>What would you like to uncover?</h2><p>Start with a question, or take one of these paths.</p><div className="prompt-list">{PROMPTS.map(({ icon: Icon, title, text }) => <button key={title} onClick={() => { setQuestion(text); questionRef.current?.focus(); }}><span className="prompt-icon"><Icon size={20} /></span><span><strong>{title}</strong><span>{text}</span></span><ArrowRight size={17} /></button>)}</div>{!modelReady && <div className="model-hint"><Cpu size={17} /><span>{checking ? 'Checking your local model connection…' : 'Connect a local model to start the conversation.'}</span><button onClick={() => setPage('diagnostics')}>View setup<ArrowRight size={13} /></button></div>}</div> : <div className="messages" aria-label="Conversation" aria-live="polite" aria-busy={chat.running}>{chat.messages.map((message) => <ChatMessage key={message.id} message={message} />)}<div ref={chatEnd} /></div>}
            </div>
            <div className="composer-area">{!modelReady && targetName && chat.messages.length > 0 && <div className="composer-model-note"><AlertCircle size={13} />Local model unavailable.<button onClick={() => setPage('diagnostics')}>Check connection</button></div>}<form className={`composer ${chat.running ? 'composer-running' : ''}`} onSubmit={(event) => { event.preventDefault(); void ask(); }}><textarea ref={questionRef} aria-label="Ask a question about the binary" placeholder={targetName ? `Ask a question about ${targetName}…` : 'Open a binary to start your investigation…'} value={question} onChange={(event) => setQuestion(event.target.value)} rows={2} maxLength={32000} disabled={!targetName || chat.running} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void ask(); } }} /><div className="composer-bottom"><div className="composer-context"><span><Layers3 size={13} />{shortScope(scope)}</span><span className="composer-context-divider" /><span><LockKeyhole size={12} />Local model</span></div>{chat.running ? <Button variant="danger" type="button" onClick={() => void rpc('agent.cancel').catch((cause: Error) => setError(cause.message))}><CircleStop size={16} />Stop</Button> : <button className="send-button" type="submit" aria-label="Send question" disabled={!question.trim() || !targetName || !connected || !modelReady}><ArrowUp size={19} /></button>}</div></form><div className="composer-footnote"><span><ShieldCheck size={11} />AI can make mistakes. Verify important findings.</span><span>Enter to send · Shift + Enter for a new line</span></div></div>
          </section>
          <aside className="inspector"><div className="inspector-heading"><h3>Session inspector</h3><button className="icon-button" aria-label="Refresh session" onClick={() => void reconnect()} disabled={checking}><RefreshCw size={14} className={checking ? 'spin' : ''} /></button></div><div className="inspector-section"><div className="section-label">CURRENT TARGET{targetName && <span className="status-dot" />}</div>{targetName ? <><div className="inspector-file"><FileCode2 size={22} /><div><strong>{targetName}</strong><span>{session?.format?.toUpperCase() ?? 'Binary'} analysis</span></div></div><dl className="metadata"><div><dt>Architecture</dt><dd>{session?.architecture ?? 'Unknown'}</dd></div><div><dt>Provider</dt><dd>{session?.providerId ?? 'Built-in inspection'}</dd></div><div><dt>Session</dt><dd><span className="status-dot" />Active</dd></div></dl>{session?.sha256 && <div className="hash-field"><div className="field-caption">SHA-256<CopyButton text={session.sha256} label="Copy SHA-256" /></div><code>{session.sha256}</code></div>}</> : <div className="inspector-empty"><Box size={25} strokeWidth={1.3} /><p>No binary opened yet</p><button onClick={() => setOpenDialog(true)}>Select a target<ArrowRight size={12} /></button></div>}</div><div className="inspector-section"><div className="section-label">ANALYSIS CONFIGURATION<SlidersHorizontal size={13} /></div><label className="field-label" htmlFor="scope">Tool scope</label><div className="select-wrap"><select id="scope" value={scope} disabled={chat.running} onChange={(event) => { const next = event.target.value as ToolScopeName; if (chat.messages.length) setScopePending(next); else void changeScope(next); }}><option value="binary-core">Binary core</option><option value="binary-extended">Binary extended</option><option value="full">Full catalog</option>{boot.config.customTools.length > 0 && <option value="custom">Custom</option>}</select><ChevronDown size={14} /></div><p className="field-help">{scopeCount ?? '—'} tools available to the agent</p><dl className="metadata"><div><dt>Context window</dt><dd>{boot.config.contextWindow.toLocaleString()} tokens</dd></div><div><dt>Max. iterations</dt><dd>{boot.config.maxIterations} steps</dd></div><div><dt>Unscoped tools</dt><dd><LockKeyhole size={11} />Blocked</dd></div></dl></div><div className="inspector-section"><div className="section-label">CONNECTIONS<button onClick={() => setPage('diagnostics')} aria-label="View connection diagnostics"><ArrowRight size={13} /></button></div><div className="connection-row"><span className="connection-icon"><Network size={16} /></span><div><strong>REA engine</strong><span>{catalogTotal ?? '—'} tools discovered</span></div><span className={`status-dot ${connected ? '' : 'red'}`} /></div><div className="connection-row"><span className="connection-icon"><Cpu size={16} /></span><div><strong>Local model</strong><span>{modelReady ? 'Connected · loopback' : checking ? 'Checking connection' : 'Not connected'}</span></div><span className={`status-dot ${modelReady ? '' : 'amber'}`} /></div></div><div className="evidence-promise"><span><ShieldCheck size={20} /></span><strong>Grounded, not guessed.</strong><p>Evidence IDs and analysis limitations stay attached to every observation.</p><button onClick={() => setPage('evidence')}>Explore evidence<ArrowRight size={13} /></button></div></aside>
        </div>}

        {page === 'tools' && <div className="tools-page"><div className="catalog-stats"><div><span className="stat-icon"><Blocks size={20} /></span><span><strong>{catalog?.total ?? '—'}</strong><span>Discovered tools</span></span></div><div><span className="stat-icon"><Layers3 size={20} /></span><span><strong>{catalogFamilies.length}</strong><span>Tool families</span></span></div><div><span className="stat-icon"><ShieldCheck size={20} /></span><span><strong>{scopeCount ?? '—'}</strong><span>In active scope</span></span></div><p><InfoIcon />Tools are discovered from the live REA server.<br />Only scoped tools are available to the agent.</p></div><div className="catalog-toolbar"><div className="search-input"><Search size={17} /><input ref={toolSearchRef} placeholder="Search tools by name or capability…" aria-label="Search tools" value={toolQuery} onChange={(event) => setToolQuery(event.target.value)} />{toolQuery ? <button className="tiny-icon" onClick={() => setToolQuery('')} aria-label="Clear tool search"><X size={14} /></button> : <kbd>⌘ K</kbd>}</div><div className="select-wrap"><select aria-label="Filter by family" value={toolFamily} onChange={(event) => setToolFamily(event.target.value)}><option value="all">All families</option>{catalogFamilies.map((family) => <option key={family.id} value={family.id}>{family.label} ({family.count})</option>)}</select><ChevronDown size={14} /></div><label className="checkbox-label"><input type="checkbox" checked={scopedOnly} onChange={(event) => setScopedOnly(event.target.checked)} />Active scope only</label></div><div className={`catalog-layout ${selectedTool ? 'with-detail' : ''}`}><section className="tool-list"><div className="tool-list-header"><span>{filteredTools.length} TOOLS</span><span>LIVE CATALOG</span></div>{filteredTools.length ? filteredTools.map((tool) => <button key={tool.name} className={`tool-row ${selectedTool === tool.name ? 'selected' : ''}`} onClick={() => setSelectedTool(tool.name)}><span className="tool-row-icon"><Braces size={18} /></span><span className="tool-row-main"><strong>{tool.name}</strong><span>{tool.description}</span></span><span className="tool-row-meta">{scopeNames.includes(tool.name) && <span className="scope-indicator" title="In active scope"><ShieldCheck size={14} /></span>}<span>{catalogFamilies.find((family) => family.id === tool.family)?.label}</span><ChevronRight size={15} /></span></button>) : <EmptyState icon={<Search size={26} />} title="No matching tools">Try a different keyword or clear the family and scope filters.</EmptyState>}</section>{selectedTool && <aside className="tool-detail"><div className="tool-detail-heading"><span className="section-label">TOOL REFERENCE</span><button className="icon-button" aria-label="Close tool details" onClick={() => setSelectedTool(null)}><X size={17} /></button></div>{toolLoading ? <div className="loading-inline"><LoaderCircle size={20} className="spin" />Loading live schema…</div> : toolError ? <ErrorNotice>{toolError}</ErrorNotice> : toolDetail && <><div className="detail-tool-icon"><Braces size={26} /></div><h2>{toolDetail.tool.name}</h2><div className="detail-badges"><Badge tone={toolDetail.inScope ? 'green' : 'neutral'}>{toolDetail.inScope ? 'In active scope' : 'Outside active scope'}</Badge>{toolDetail.tool.annotations?.readOnlyHint === true && <Badge>Read-only</Badge>}{toolDetail.tool.annotations?.destructiveHint === true && <Badge tone="amber">Writes to target</Badge>}</div><p>{toolDetail.tool.description}</p><h4>Input schema</h4><SchemaProperties schema={toolDetail.tool.inputSchema} /><details className="raw-schema"><summary>View raw JSON schema<ChevronDown size={14} /></summary><CodePanel text={JSON.stringify(toolDetail.tool.inputSchema, null, 2)} label="inputSchema" /></details><div className="tool-reference-note"><ShieldCheck size={16} /><p>The agent validates scope and bounds arguments before dispatch. Browse here; invoke through a conversation.</p></div><Button variant="primary" onClick={() => { setQuestion(`Use ${toolDetail.tool.name} to inspect the current target. Explain the evidence and any limitations.`); setPage('workspace'); setTargetTab('conversation'); setTimeout(() => questionRef.current?.focus(), 50); }} disabled={!targetName}><MessageSquare size={15} />Ask about this tool</Button></>}</aside>}</div></div>}

        {page === 'evidence' && <div className="evidence-page"><div className="evidence-intro"><div className="evidence-intro-icon"><ShieldCheck size={28} /></div><div><h2>A trail you can trust.</h2><p>Observations retain their source, evidence references, and the engine’s limitations. Export your session to keep the research together.</p></div><Badge tone="green">{evidence.length} observations</Badge></div><section className="retained-panel" aria-labelledby="retained-heading"><header className="retained-heading"><div><div className="eyebrow">RETAINED BY REA</div><h2 id="retained-heading">Canonical evidence bundle</h2><p>{retained ? describeRetainedCounts(retained) : retainedBusy ? 'Reading the bundle…' : 'Not read yet.'}</p></div><div className="retained-actions"><Button onClick={() => void loadRetained()} disabled={retainedBusy}>{retainedBusy ? <LoaderCircle size={16} className="spin" /> : <RefreshCw size={16} />}Refresh</Button><Button variant="primary" onClick={() => void exportBundle()} disabled={exporting || retainedBusy}>{exporting ? <LoaderCircle size={16} className="spin" /> : <ArrowDownToLine size={16} />}{exporting ? 'Exporting…' : 'Export bundle'}</Button></div></header>{retainedError && <ErrorNotice>{retainedError}</ErrorNotice>}{exportConflict && <div className="retained-conflict"><span className="muted small">REA refused to replace an existing bundle. Overwrite it only if you mean to replace that file.</span><Button onClick={() => void exportBundle(true)} disabled={exporting}>Overwrite the existing bundle</Button></div>}{retained && retained.records.length > 0 && (() => { const rows = filterRetainedRecords(retained.records, evidenceQuery); return rows.length ? <div className="retained-list">{rows.map((entry) => <div className="retained-item" key={entry.evidenceId}><button className={`retained-row ${openEvidenceId === entry.evidenceId ? 'open' : ''}`} aria-expanded={openEvidenceId === entry.evidenceId} onClick={() => void toggleRecord(entry.evidenceId)}><ShieldCheck size={16} /><span className="retained-row-main"><strong>{entry.operation ?? 'Retained record'}</strong><span>{entry.subjectName ? fileName(entry.subjectName) : 'Subject not reported'}{entry.providerId ? ` · ${entry.providerId}` : ''}{entry.retention ? ` · retention ${entry.retention}` : ''}</span></span>{entry.confidence && <Badge>{entry.confidence}</Badge>}{entry.authority && <Badge tone="green">{entry.authority}</Badge>}<code className="retained-id" title={entry.evidenceId}>{shortEvidenceId(entry.evidenceId)}</code>{openEvidenceId === entry.evidenceId ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</button>{openEvidenceId === entry.evidenceId && <div className="retained-record">{recordBusy ? <div className="record-loading"><LoaderCircle size={16} className="spin" />Reading the retained record…</div> : record === null ? null : record.ok ? <><CodePanel text={record.text} label="Retained evidence record · untrusted target content" />{record.truncated && <p className="muted small">Shortened for display. Export the bundle to read the record in full.</p>}</> : <ErrorNotice>{record.error ?? 'The engine did not return this record.'}</ErrorNotice>}</div>}</div>)}</div> : <p className="muted small">No retained record matches this search.</p>; })()}{retained && retained.records.length === 0 && <EmptyState icon={<Database size={26} />} title="No evidence retained yet">Open a target and inspect it, or ask the agent a question, to create the first retained record.</EmptyState>}{!retained && retainedBusy && <div className="record-loading"><LoaderCircle size={16} className="spin" />Reading REA’s retained evidence…</div>}<p className="page-note"><LockKeyhole size={13} />REA writes this bundle itself, so the exported file matches the retained records. Exports stay inside <code>{relativeToWorkspace(`${boot.config.workspaceDir}/evidence`, boot.config.workspaceDir)}</code>.</p></section><section className="retained-panel cases-panel" aria-labelledby="cases-heading"><header className="retained-heading"><div><div className="eyebrow">SAVED IN THIS WORKSPACE</div><h2 id="cases-heading">Case folders</h2><p>{cases === null ? casesBusy ? 'Reading saved cases…' : 'Not read yet.' : cases.cases.length === 0 ? 'Nothing saved yet.' : `${cases.total} ${cases.total === 1 ? 'case' : 'cases'} · newest first`}</p></div><div className="retained-actions"><Button onClick={() => void loadCases()} disabled={casesBusy}>{casesBusy ? <LoaderCircle size={16} className="spin" /> : <RefreshCw size={16} />}Refresh</Button><Button variant="primary" onClick={openCaseDialog} disabled={savingCase}><HardDrive size={16} />Save current analysis</Button></div></header>{caseError && <ErrorNotice>{caseError}</ErrorNotice>}{cases !== null && cases.cases.length > 1 && <div className="case-search"><div className="search-input"><Search size={15} /><input aria-label="Search saved cases" placeholder="Search cases by name, target, scope, or digest…" value={caseQuery} onChange={(event) => setCaseQuery(event.target.value)} /></div>{caseQuery.trim() !== '' && <span className="muted small">{filterSavedCases(cases.cases, caseQuery).length} of {cases.cases.length}</span>}</div>}{cases !== null && cases.cases.length > 0 && filterSavedCases(cases.cases, caseQuery).length === 0 && <p className="muted small">No saved case matches this search.</p>}{cases !== null && cases.cases.length > 0 && <div className="retained-list">{filterSavedCases(cases.cases, caseQuery).map((entry) => <button className="retained-row case-row" key={entry.directory} onClick={() => void viewCase(entry.name)} disabled={openingCase !== null} title={`Open ${caseLocation(entry, boot.config.workspaceDir)}`}>{openingCase === entry.name ? <LoaderCircle size={16} className="spin" /> : <FolderOpen size={16} />}<span className="retained-row-main"><strong>{entry.name}</strong><span>{entry.summary ? describeCaseTarget(entry.summary) : 'Summary unavailable'} · {describeSavedCase(entry, boot.config.workspaceDir)}</span></span><code className="retained-id" title={relativeToWorkspace(entry.directory, boot.config.workspaceDir)}>{caseLocation(entry, boot.config.workspaceDir)}</code><ChevronRight size={16} /></button>)}</div>}{cases !== null && cases.cases.length === 0 && <EmptyState icon={<FileArchive size={26} />} title="No case folders yet"><em>Save current analysis</em> writes the Markdown report, the JSON companion, and REA’s canonical evidence bundle into one folder under <code>{relativeToWorkspace(`${boot.config.workspaceDir}/cases`, boot.config.workspaceDir)}</code>.</EmptyState>}<p className="page-note"><LockKeyhole size={13} />Cases are written by the local service, not downloaded by the browser, so they survive a reload and stay inside the workspace.</p></section><div className="catalog-toolbar"><div className="search-input"><Search size={17} /><input aria-label="Search evidence" placeholder="Search observations, tools, or evidence IDs…" value={evidenceQuery} onChange={(event) => setEvidenceQuery(event.target.value)} /></div><span className="muted small">Current workspace session</span></div>{evidence.length ? <div className="evidence-list">{evidence.map((entry) => <article className="evidence-card" key={entry.id}><header><span className="evidence-card-icon"><Database size={19} /></span><div><h3>{entry.name}</h3><p>{entry.target ? fileName(entry.target) : 'Current target'}{entry.time && ` · ${new Date(entry.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`}</p></div><Badge tone={entry.ok ? 'green' : 'red'}>{entry.ok ? 'Observed' : 'Tool error'}</Badge></header>{entry.evidenceId && <div className="evidence-reference"><ShieldCheck size={14} /><code>{entry.evidenceId}</code><CopyButton text={entry.evidenceId} /></div>}<CodePanel text={entry.text} label="Projected observation · untrusted target content" /></article>)}</div> : <div className="panel"><EmptyState icon={<Database size={30} />} title={evidenceQuery ? 'No matching observations' : 'Your evidence trail starts with a question'}>{evidenceQuery ? 'Clear your search to see all observations.' : 'Open a target for an initial overview. As the agent investigates, tool observations and evidence references will appear here.'}</EmptyState></div>}<p className="page-note"><LockKeyhole size={13} />Reports are exported locally. Observation text may contain sensitive target data; handle exported files accordingly.</p></div>}

        {page === 'diagnostics' && <div className="diagnostics-page"><div className={`health-banner ${doctor?.healthy ? 'healthy' : ''}`}><span>{checking ? <LoaderCircle size={28} className="spin" /> : doctor?.healthy ? <CheckCircle2 size={28} /> : <Activity size={28} />}</span><div><h2>{checking && !doctor ? 'Checking your environment' : doctor?.healthy ? 'All systems ready' : 'Your workspace, at a glance'}</h2><p>{doctor ? `${doctorChecks.filter((check) => check.status === 'ok').length} of ${doctorChecks.length} checks passed. ${doctor.healthy ? 'You’re ready to investigate.' : 'Review the checks below to finish setting up.'}` : 'Run diagnostics to check the engine, analysis providers, and model connection.'}</p></div><Button onClick={() => void reconnect()} disabled={checking}><RefreshCw size={15} />Reconnect engine</Button></div><div className="diagnostics-grid"><section className="panel checks-panel"><div className="panel-heading"><h3>Environment checks</h3><label className="checkbox-label"><input type="checkbox" checked={llmCheck?.status === 'skipped'} onChange={(event) => void runDoctor(event.target.checked)} disabled={checking} />Skip model probe</label></div>{doctorChecks.map((check) => <div className="check-row" key={check.id}><span className={`check-icon check-${check.status}`}>{check.status === 'ok' ? <Check size={16} /> : check.status === 'fail' ? <X size={16} /> : check.status === 'warn' ? <AlertCircle size={16} /> : <Clock3 size={16} />}</span><div><strong>{check.label}</strong><p>{check.detail}</p>{check.remediation && check.status !== 'ok' && <div className="check-remediation"><ArrowRight size={13} />{check.remediation}</div>}</div><Badge tone={check.status === 'ok' ? 'green' : check.status === 'fail' ? 'red' : check.status === 'warn' ? 'amber' : 'neutral'}>{check.status === 'ok' ? 'Passed' : check.status === 'fail' ? 'Attention' : check.status === 'warn' ? 'Warning' : 'Skipped'}</Badge></div>)}{!doctor && <div className="loading-inline"><LoaderCircle size={20} className="spin" />Waiting for diagnostics…</div>}</section><section className="panel model-setup"><span className="stat-icon"><Cpu size={23} /></span><h3>Bring your own intelligence.</h3><p>REA works with a local OpenAI-compatible model server. Start llama-server, then point your config at it.</p><div className="field-caption">CONFIGURED ENDPOINT</div><code className="endpoint-code">{boot.config.baseUrl}</code><div className="field-caption">MODEL</div><p className="model-name">{boot.config.model}</p><Button onClick={() => setPage('settings')}><Settings2 size={15} />View configuration</Button><div className="setup-note"><ShieldCheck size={17} /><p>Only loopback endpoints are allowed by default. No API key or model data is sent to a cloud service.</p></div></section></div><section className="panel activity-panel"><div className="panel-heading"><h3><SquareTerminal size={17} />Engine activity</h3><div><span className="muted small">{events.length} recent events</span><Button variant="ghost" onClick={() => setEvents([])} disabled={!events.length}><Trash2 size={14} />Clear</Button></div></div><div className="event-log">{events.length ? [...events].reverse().map((event) => <div className="event-row" key={event.id}><time>{new Date(event.time).toLocaleTimeString()}</time><span className="event-method">{event.method}{event.method === 'agent.event' ? `.${String(event.params.type)}` : ''}</span><span>{event.method === 'rea.stderr' || event.method === 'engine.stderr' ? String(event.params.line) : event.method === 'agent.event' ? JSON.stringify(event.params.data).slice(0, 220) : JSON.stringify(event.params).slice(0, 220)}</span></div>) : <div className="log-empty"><TerminalIcon /><span>No activity yet. Engine events will appear here as you work.</span></div>}</div></section></div>}

        {page === 'settings' && <div className="settings-page"><section className="panel settings-section"><div className="settings-section-heading"><span className="stat-icon"><Cpu size={21} /></span><div><h3>Local model</h3><p>OpenAI-compatible inference, running on your terms.</p></div><Badge tone={modelReady ? 'green' : 'amber'}>{modelReady ? 'Connected' : 'Not connected'}</Badge></div><div className="settings-fields"><div><label>Model endpoint</label><code>{boot.config.baseUrl}</code></div><div><label>Model name</label><code>{boot.config.model}</code></div><div><label>Context window</label><span>{boot.config.contextWindow.toLocaleString()} tokens</span></div><div><label>Request transport</label><span>OpenAI-compatible HTTP</span></div></div><div className="settings-config-note"><BookOpen size={17} /><p>Settings are read from this file. If it does not exist, built-in defaults apply — copy config.example.json to get started, then restart the workspace.</p><CopyButton text={boot.config.configPath} label="Copy configuration path" /></div><code className="config-path">{boot.config.configPath}</code></section><section className="panel settings-section"><div className="settings-section-heading"><span className="stat-icon"><Sparkles size={21} /></span><div><h3>Agent instructions</h3><p>Set a consistent approach for this workspace.</p></div></div><label className="field-label" htmlFor="instructions">Additional instructions</label><textarea id="instructions" className="settings-textarea" rows={4} maxLength={8000} placeholder="For example: Always distinguish confirmed behavior from hypotheses. Include evidence IDs and explain limitations." value={instructions} onChange={(event) => setInstructions(event.target.value)} /><div className="settings-save"><span>{instructions.length.toLocaleString()} / 8,000 characters · Applied to your next question</span><Button variant="primary" onClick={() => { store('instructions', instructions); setToast('Workspace instructions saved'); }}><Check size={15} />Save instructions</Button></div></section><section className="panel settings-section"><div className="settings-section-heading"><span className="stat-icon"><ShieldCheck size={21} /></span><div><h3>Security & storage</h3><p>Explicit boundaries for your analysis environment.</p></div></div><div className="security-row"><div><strong>Loopback-only network policy</strong><p>Remote model endpoints and network-share targets are blocked.</p></div><Badge tone={boot.config.allowNonLoopback ? 'amber' : 'green'}>{boot.config.allowNonLoopback ? 'Disabled in config' : 'Enabled'}</Badge></div><div className="security-row"><div><strong>Tool scope enforcement</strong><p>The agent cannot call tools outside its advertised scope.</p></div><Badge tone="green"><LockKeyhole size={12} />Enforced</Badge></div><div className="security-row"><div><strong>Argument bounds</strong><p>Array lengths and serialized payload sizes are checked before dispatch.</p></div><Badge tone="green"><ShieldCheck size={12} />Enforced</Badge></div><div className="security-row"><div><strong>Workspace directory</strong><p>Local caches, retained evidence{boot.mode === 'browser' ? ', and uploaded binaries' : ''}.</p></div><code>{boot.config.workspaceDir}</code></div></section><section className="panel settings-section"><div className="settings-section-heading"><span className="stat-icon"><Clock3 size={21} /></span><div><h3>Recent targets</h3><p>Only file paths are remembered, never binary contents.</p></div><Button variant="ghost" disabled={!recent.length} onClick={() => { setRecent([]); store('recent', []); setToast('Recent target history cleared'); }}><Trash2 size={14} />Clear history</Button></div>{recent.length ? recent.map((path) => <div className="recent-settings-row" key={path}><FileCode2 size={16} /><code>{path}</code><button className="icon-button" aria-label={`Remove ${fileName(path)} from history`} onClick={() => { const next = recent.filter((item) => item !== path); setRecent(next); store('recent', next); }}><X size={14} /></button></div>) : <p className="muted small">No recent targets.</p>}</section></div>}
      </main>
      <footer className="statusbar"><div><span className={`status-dot ${connected ? '' : 'red'}`} /><span>{connected ? 'Engine connected' : 'Engine disconnected'}</span><span className="statusbar-divider" /><span>REA {session?.packageVersion ?? doctor?.serverVersion ?? '—'}</span><span className="statusbar-divider" /><span>{catalogTotal ?? '—'} tools</span></div><div><span>{chat.running ? <><LoaderCircle size={11} className="spin" />Agent is investigating</> : <><Check size={12} />{targetName ? 'Target ready' : 'Ready when you are'}</>}</span><span className="statusbar-divider" /><span><LockKeyhole size={11} />{boot.config.allowNonLoopback ? 'Custom policy' : 'Loopback only'}</span></div></footer>
    </div>
    {dropping && <div className="drop-overlay" aria-hidden="true"><div className="drop-overlay-card"><Upload size={30} strokeWidth={1.5} /><strong>{boot.mode === 'desktop' ? 'Drop to open in place' : 'Drop to upload to this workspace'}</strong><span>{boot.mode === 'desktop' ? 'The file stays where it is. REA inspects it without executing it.' : 'The file is copied into the local workspace, never to a cloud service.'}</span></div></div>}
    {toast && <div className="toast" role="status"><CheckCircle2 size={18} />{toast}<button aria-label="Dismiss notification" onClick={() => setToast('')}><X size={14} /></button></div>}
    {openDialog && <OpenBinaryDialog mode={boot.mode} platform={boot.platform} opening={opening} onClose={() => { if (!opening) setOpenDialog(false); }} onOpen={openTarget} />}
    {(confirm || scopePending) && <Modal title={scopePending ? 'Change the analysis scope?' : confirm === 'close' ? 'Close this target?' : 'Start a new conversation?'} subtitle={scopePending ? `Switch to ${shortScope(scopePending)}. Changing scope starts a fresh agent transcript.` : confirm === 'close' ? 'The binary will be closed in REA. Your conversation and exported evidence are preserved.' : 'This clears the current agent transcript. Export a report first if you want to keep it.'} onClose={() => { setConfirm(null); setScopePending(null); }}><div className="modal-actions"><Button onClick={() => { setConfirm(null); setScopePending(null); }}>Keep working</Button><Button variant="primary" onClick={() => scopePending ? void changeScope(scopePending) : confirm === 'close' ? void closeTarget() : void resetChat()}>{scopePending ? 'Change scope' : confirm === 'close' ? 'Close target' : 'New conversation'}</Button></div></Modal>}
    {openedCase && <Modal title={openedCase.ok ? `Case · ${openedCase.name}` : 'Case could not be opened'} subtitle={openedCase.ok ? `${openedCase.savedAt ? new Date(openedCase.savedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'Saved case'} · ${caseLocation(openedCase, boot.config.workspaceDir)}` : openedCase.name} onClose={() => setOpenedCase(null)}>
      {!openedCase.ok ? <><ErrorNotice>{openedCase.error ?? 'This case could not be read.'}</ErrorNotice>{openedCase.files.length > 0 && <p className="muted small">Folder contains: {openedCase.files.map((file) => file.name).join(", ")}</p>}</> : <>
        <div className="case-summary">
          <div><span className="field-caption">TARGET</span><strong>{describeCaseTarget(openedCase.summary)}</strong>{shortDigest(openedCase.summary?.target.sha256) && <code className="retained-id" title={openedCase.summary?.target.sha256}>sha256 {shortDigest(openedCase.summary?.target.sha256)}</code>}</div>
          <div><span className="field-caption">RECORDED</span><p>{describeCaseStats(openedCase.summary)}</p></div>
          <div><span className="field-caption">FILES</span><p>{openedCase.files.map((file) => `${file.name} (${formatBytes(file.bytes)})`).join(' · ')}</p></div>
          {openedCase.bundle && <div><span className="field-caption">REA BUNDLE</span><p>{openedCase.bundle.records ?? 0} records · {openedCase.bundle.unknowns ?? 0} unknowns</p></div>}
          {openedCase.summary?.scope && <div><span className="field-caption">SCOPE</span><p>{shortScope(openedCase.summary.scope)}{openedCase.summary.engineVersion ? ` · engine ${openedCase.summary.engineVersion}` : ''}</p></div>}
        </div>
        <div className="case-doc-tabs" role="tablist" aria-label="Case contents">
          <button role="tab" aria-selected={!caseJsonShown} className={!caseJsonShown ? 'active' : ''} onClick={() => setCaseJsonShown(false)}><FileCode2 size={14} />Report</button>
          <button role="tab" aria-selected={caseJsonShown} className={caseJsonShown ? 'active' : ''} onClick={() => setCaseJsonShown(true)} disabled={openedCase.reportJson === undefined}><Braces size={14} />JSON</button>
        </div>
        {caseJsonShown ? <div className="case-doc"><CodePanel text={openedCase.reportJson ?? 'This case has no analysis.json.'} label="Saved analysis.json" /></div> : openedCase.report === undefined ? <p className="muted small">This case folder has no Markdown report.</p> : <div className="case-doc markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ children }) => <span className="disabled-link" title="External navigation is disabled in this local workspace">{children}</span>, img: ({ alt }) => <span>[Image omitted: {alt ?? 'target content'}]</span> }}>{openedCase.report}</ReactMarkdown></div>}
        {(openedCase.reportTruncated || openedCase.jsonTruncated) && <p className="muted small">This file exceeds the display limit and is shown in part. Open it from the folder for the full document.</p>}
        <div className="modal-actions case-actions"><Button variant="ghost" onClick={() => { setDeleteTarget(openedCase.name); setCaseError(''); }} disabled={deletingCase}><Trash2 size={15} />Delete case</Button><span className="modal-actions-spacer" /><CopyButton text={openedCase.directory ?? ''} label="Copy folder path" /><Button onClick={downloadCaseJson} disabled={openedCase.reportJson === undefined}><ArrowDownToLine size={15} />Download JSON</Button>{openedCase.summary?.target.path && <Button onClick={() => { const path = openedCase.summary?.target.path; setOpenedCase(null); if (path) void openTarget(path); }} disabled={opening || chat.running} title={openedCase.summary?.target.path}><FileSearch size={15} />Reopen target</Button>}<Button variant="primary" onClick={() => setOpenedCase(null)}>Close</Button></div>
      </>}
    </Modal>}
    {deleteTarget !== null && <Modal title="Delete this case?" subtitle="The folder and everything in it are removed from this workspace." onClose={() => { if (!deletingCase) setDeleteTarget(null); }}>
      <p className="case-warning"><Trash2 size={16} />{describeCaseDeletion(deleteTarget, openedCase?.files ?? [], boot.config.workspaceDir)}</p>
      {caseError && <ErrorNotice>{caseError}</ErrorNotice>}
      <div className="modal-actions"><Button onClick={() => setDeleteTarget(null)} disabled={deletingCase}>Keep the case</Button><Button variant="danger" onClick={() => void deleteCase(deleteTarget)} disabled={deletingCase}>{deletingCase ? <LoaderCircle size={16} className="spin" /> : <Trash2 size={16} />}{deletingCase ? 'Deleting…' : 'Delete folder'}</Button></div>
    </Modal>}
    {caseDialog && <Modal title="Save this analysis" subtitle="One folder. The report, the data, and REA's evidence." onClose={() => { if (!savingCase) setCaseDialog(false); }}>
      <form onSubmit={(event) => { event.preventDefault(); void saveCase(); }}>
        <label className="field-label" htmlFor="case-name">Case name</label>
        <input id="case-name" className="text-input" value={caseName} onChange={(event) => { setCaseName(event.target.value); setCaseNameError(''); setCaseConflict(null); setCaseError(''); }} disabled={savingCase} autoComplete="off" spellCheck={false} aria-invalid={caseNameError !== ''} aria-describedby="case-help" />
        <p className="field-help" id="case-help">Saved to <code>{relativeToWorkspace(`${boot.config.workspaceDir}/cases`, boot.config.workspaceDir)}/{caseName.trim() || '…'}/</code> as <code>analysis.md</code>, <code>analysis.json</code>{caseBundle ? <> and <code>evidence-bundle.json</code></> : null}.</p>
        {caseNameError && <p className="field-error" role="alert">{caseNameError}</p>}
        {caseConflict && <div className="retained-conflict"><span className="muted small">A case named <strong>{caseConflict}</strong> already exists. Overwriting replaces its report files and bundle.</span><Button type="button" onClick={() => void saveCase(caseConflict)} disabled={savingCase}>Overwrite it</Button></div>}
        {caseError && <ErrorNotice>{caseError}</ErrorNotice>}
        <label className="checkbox-row"><input type="checkbox" checked={caseBundle} onChange={(event) => setCaseBundle(event.target.checked)} disabled={savingCase} /><span><strong>Include REA's evidence bundle</strong><small>Has the engine write its canonical bundle into the same folder. If REA cannot, the report is still saved and the reason is reported.</small></span></label>
        <div className="modal-actions"><Button type="button" onClick={() => setCaseDialog(false)} disabled={savingCase}>Cancel</Button><Button variant="primary" type="submit" disabled={savingCase}>{savingCase ? <LoaderCircle size={16} className="spin" /> : <HardDrive size={16} />}{savingCase ? 'Saving…' : 'Save case'}</Button></div>
      </form>
    </Modal>}
    {help && <Modal title="A little help, a lot to discover." subtitle="REA Workspace · Your local reverse engineering workbench" onClose={() => setHelp(false)}><div className="help-steps"><div><span>01</span><div><strong>Open a target</strong><p>Choose a local binary. REA identifies its format and analysis surface without executing it.</p></div></div><div><span>02</span><div><strong>Follow your curiosity</strong><p>Connect a local model, ask a question, and watch the agent collect evidence with scoped tools.</p></div></div><div><span>03</span><div><strong>Keep the evidence</strong><p>Inspect observations, retain evidence references, and export your analysis as a local JSON report.</p></div></div></div><div className="shortcut-list"><div><span>Open binary</span><kbd>Ctrl / ⌘ + O</kbd></div><div><span>Search tools</span><kbd>Ctrl / ⌘ + K</kbd></div><div><span>Send question</span><kbd>Enter</kbd></div><div><span>New line</span><kbd>Shift + Enter</kbd></div></div><p className="muted small">Browser preview: choose a file to upload it to this workspace, or enter an absolute path on the engine host. The native app opens files directly.</p></Modal>}
  </div>;
}

function InfoIcon() { return <CircleHelp size={16} />; }
function TerminalIcon() { return <SquareTerminal size={20} />; }
function ChatMessage({ message }: { message: Message }) {
  return <article className={`chat-message message-${message.role}`}><div className="message-avatar">{message.role === 'assistant' ? <Braces size={18} /> : <span>L</span>}</div><div className="message-body"><div className="message-label"><strong>{message.role === 'assistant' ? 'REA assistant' : 'You'}</strong>{message.time && <span>{new Date(message.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>}{message.role === 'assistant' && <Badge><Cpu size={10} />Local</Badge>}</div>{message.activities.length > 0 && <div className="message-activities"><div className="field-caption">INVESTIGATION · {message.activities.length} TOOL {message.activities.length === 1 ? 'CALL' : 'CALLS'}</div>{message.activities.map((activity) => <ToolActivityView key={activity.id} activity={activity} />)}</div>}{message.content ? <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ children }) => <span className="disabled-link" title="External navigation is disabled in this local workspace">{children}</span>, img: ({ alt }) => <span>[Image omitted: {alt ?? 'target content'}]</span> }}>{message.content}</ReactMarkdown></div> : message.streaming && !message.activities.some((activity) => !activity.finish) ? <div className="thinking"><span /><span /><span /><span className="thinking-label">Thinking through your question</span></div> : null}{message.streaming && message.content && <span className="streaming-cursor" />}{message.error && <ErrorNotice>{message.error}</ErrorNotice>}{!message.streaming && message.reason && <div className="message-footer"><span>{message.reason === 'cancelled' ? 'Stopped by you' : message.reason === 'max_iterations' ? 'Iteration limit reached · partial answer' : message.reason === 'failed' ? 'Turn failed' : 'Investigation complete'}{message.iterations !== undefined && ` · ${message.iterations} ${message.iterations === 1 ? 'step' : 'steps'}`}</span><CopyButton text={message.content} label="Copy answer" /></div>}</div></article>;
}
function SchemaProperties({ schema }: { schema: Record<string, unknown> }) {
  const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
  const required = Array.isArray(schema.required) ? schema.required : [];
  if (!properties || !Object.keys(properties).length) return <p className="muted small">This tool takes no input arguments.</p>;
  return <div className="schema-properties">{Object.entries(properties).map(([name, property]) => <div key={name}><div><code>{name}</code><span>{String(property.type ?? 'any')}</span>{required.includes(name) && <Badge tone="amber">Required</Badge>}</div><p>{String(property.description ?? '')}</p></div>)}</div>;
}
function OpenBinaryDialog({ mode, platform, opening, onClose, onOpen }: { mode: 'desktop' | 'browser'; platform: string; opening: boolean; onClose: () => void; onOpen: (path: string) => Promise<void> }) {
  const [path, setPath] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [localError, setLocalError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  function selectFile(selected: File | undefined): void { if (!selected) return; if (selected.size > 100 * 1024 * 1024) { setLocalError('Choose a binary smaller than 100 MiB.'); return; } if (!selected.size) { setLocalError('The selected file is empty.'); return; } setLocalError(''); setFile(selected); }
  async function submit(): Promise<void> {
    setLocalError('');
    try { if (mode === 'browser' && file) { const uploaded = await uploadBinary(file); await onOpen(uploaded.path); } else await onOpen(path); }
    catch (cause) { setLocalError((cause as Error).message); }
  }
  return <Modal title="Open a binary" subtitle="A new target. A new line of inquiry." onClose={onClose}><form onSubmit={(event) => { event.preventDefault(); void submit(); }}>{mode === 'browser' ? <><button type="button" className={`upload-zone ${dragging ? 'dragging' : ''} ${file ? 'has-file' : ''}`} disabled={opening} onClick={() => fileInput.current?.click()} onDragOver={(event) => { event.preventDefault(); event.stopPropagation(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={(event) => { event.preventDefault(); event.stopPropagation(); setDragging(false); if (!opening) selectFile(event.dataTransfer.files[0]); }}>{file ? <FileArchive size={31} /> : <Upload size={31} strokeWidth={1.5} />}<strong>{file ? file.name : 'Drop a binary here, or browse'}</strong><span>{file ? `${formatBytes(file.size)} · Click to choose a different file` : 'PE, ELF, Mach-O, archives, and more · Up to 100 MiB'}</span></button><input ref={fileInput} type="file" className="visually-hidden" aria-label="Choose binary file" onChange={(event) => selectFile(event.target.files?.[0])} disabled={opening} /><div className="upload-privacy"><LockKeyhole size={13} />Uploaded to the local workspace. Never sent to a cloud service.</div><div className="or-divider"><span>or use a path on the engine host</span></div></> : <Button type="button" className="native-picker" disabled={opening} onClick={async () => { try { const selected = await window.reaDesktop?.chooseBinary(); if (selected) setPath(selected); } catch (cause) { setLocalError((cause as Error).message); } }}><FolderOpen size={20} />Browse files…</Button>}<label className="field-label" htmlFor="target-path">Absolute file path</label><input id="target-path" className="text-input" placeholder={platform === 'win32' ? 'C:\\Samples\\application.exe' : '/usr/bin/ls'} value={path} onChange={(event) => { setPath(event.target.value); setFile(null); }} disabled={opening || !!file} autoComplete="off" spellCheck={false} /><p className="field-help">{mode === 'browser' ? 'The path must exist on the machine running the REA engine.' : 'The file is inspected in place. REA does not execute the target.'}</p>{localError && <ErrorNotice>{localError}</ErrorNotice>}<div className="modal-actions"><Button type="button" onClick={onClose} disabled={opening}>Cancel</Button><Button variant="primary" type="submit" disabled={opening || (!file && !path.trim())}>{opening ? <LoaderCircle size={16} className="spin" /> : <FileSearch size={16} />}{opening ? 'Opening & inspecting…' : 'Open & inspect'}</Button></div></form></Modal>;
}
