import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Check, CheckCircle2, ChevronDown, Copy, AlertCircle, LoaderCircle, X, Terminal, ShieldCheck } from "lucide-react";
import type { ToolActivity } from "./state";

export function Button({ children, variant = "secondary", className = "", ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger" }) {
  return <button className={`button button-${variant} ${className}`} {...props}>{children}</button>;
}
export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: "green" | "amber" | "red" | "neutral" }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}
export function EmptyState({ icon, title, children, action }: { icon: ReactNode; title: string; children: ReactNode; action?: ReactNode }) {
  return <div className="empty-state"><div className="empty-icon">{icon}</div><h3>{title}</h3><p>{children}</p>{action}</div>;
}
export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => { if (!copied && !failed) return; const timer = setTimeout(() => { setCopied(false); setFailed(false); }, 2000); return () => clearTimeout(timer); }, [copied, failed]);
  return <button className="copy-button" aria-label={label} title={label} onClick={async () => { try { await navigator.clipboard.writeText(text); setCopied(true); } catch { setFailed(true); } }}>{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? "Copied" : failed ? "Select to copy" : null}</button>;
}
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Modal({ title, subtitle, children, onClose, className = "" }: { title: string; subtitle?: string; children: ReactNode; onClose: () => void; className?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // jsdom and older embedded Chromium builds lack <dialog> methods; fall back
    // to the `open` attribute so the modal still renders and can be dismissed.
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    const focusables = (): HTMLElement[] =>
      [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((element) => !element.hasAttribute("hidden"));
    // Native <dialog> traps focus in a browser, but the attribute fallback does
    // not; do it explicitly so both paths behave the same.
    const first = focusables()[0];
    (first ?? dialog).focus?.();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
      if (event.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) return;
      const firstItem = items[0];
      const lastItem = items[items.length - 1];
      if (firstItem === undefined || lastItem === undefined) return;
      const active = document.activeElement;
      if (event.shiftKey && (active === firstItem || active === dialog)) {
        event.preventDefault();
        lastItem.focus();
      } else if (!event.shiftKey && active === lastItem) {
        event.preventDefault();
        firstItem.focus();
      }
    };
    dialog.addEventListener("keydown", onKeyDown);
    return () => {
      dialog.removeEventListener("keydown", onKeyDown);
      if (typeof dialog.close === "function") dialog.close();
      else dialog.removeAttribute("open");
      previouslyFocused?.focus?.();
    };
  }, []);
  return <dialog ref={ref} className={`modal ${className}`} onCancel={onClose} onClick={(event) => { if (event.target === ref.current) onClose(); }} aria-labelledby={titleId} aria-modal="true">
    <div className="modal-inner"><header className="modal-header"><div><h2 id={titleId}>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button className="icon-button" aria-label="Close dialog" onClick={onClose}><X size={20} /></button></header>{children}</div>
  </dialog>;
}
const compactQuery = "(max-width: 1199px)";
function subscribeViewport(callback: () => void): () => void {
  if (typeof window.matchMedia !== "function") {
    window.addEventListener("resize", callback);
    return () => window.removeEventListener("resize", callback);
  }
  const query = window.matchMedia(compactQuery);
  query.addEventListener("change", callback);
  return () => query.removeEventListener("change", callback);
}
function isCompact(): boolean { return typeof window.matchMedia === "function" ? window.matchMedia(compactQuery).matches : window.innerWidth < 1200; }
export function ResponsiveInspector({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }) {
  const compact = useSyncExternalStore(subscribeViewport, isCompact, () => false);
  if (!open) return null;
  return compact
    ? <Modal title="Session Inspector" onClose={onClose} className="inspector-dialog"><div id="session-inspector" className="inspector-body">{children}</div></Modal>
    : <aside id="session-inspector" className="inspector" aria-label="Session Inspector">{children}</aside>;
}
export function ErrorNotice({ children, onDismiss }: { children: ReactNode; onDismiss?: () => void }) {
  return <div className="error-notice" role="alert"><AlertCircle size={18} /><div>{children}</div>{onDismiss && <button className="icon-button" aria-label="Dismiss error" onClick={onDismiss}><X size={15} /></button>}</div>;
}
export function ToolActivityView({ activity }: { activity: ToolActivity }) {
  const [open, setOpen] = useState(false);
  const finish = activity.finish;
  return <div className={`tool-activity ${finish ? finish.ok ? "tool-success" : "tool-error" : "tool-pending"}`}>
    <button className="tool-activity-summary" onClick={() => setOpen(!open)} aria-expanded={open}>
      {finish ? finish.ok ? <CheckCircle2 size={16} /> : <AlertCircle size={16} /> : <LoaderCircle size={16} className="spin" />}<span>{activity.name}</span><span className="tool-time">{finish ? `${Math.round(finish.elapsedMs)} ms` : "Running"}</span><ChevronDown size={15} className={open ? "rotate" : ""} />
    </button>
    {open && <div className="tool-activity-detail"><div className="field-caption">ARGUMENTS</div><pre>{JSON.stringify(activity.arguments, null, 2)}</pre>{finish && <><div className="field-caption">OBSERVATION PREVIEW · TARGET-DERIVED CONTENT</div><pre>{finish.preview}</pre>{finish.evidenceId && <div className="evidence-reference"><ShieldCheck size={14} /><code>{finish.evidenceId}</code><CopyButton text={finish.evidenceId} label="Copy evidence ID" /></div>}{finish.truncated && <p className="muted small">The engine truncated this observation. Evidence IDs and limitations are preserved.</p>}</>}</div>}
  </div>;
}
export function CodePanel({ text, label = "Raw observation" }: { text: string; label?: string }) {
  return <div className="code-panel"><div className="code-panel-bar"><span><Terminal size={14} />{label}</span><CopyButton text={text} label="Copy observation" /></div><pre tabIndex={0}>{text}</pre></div>;
}
export function formatBytes(bytes: number): string { return bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1048576).toFixed(1)} MiB`; }
export function fileName(path: string): string { return path.split(/[\\/]/).pop() ?? path; }
