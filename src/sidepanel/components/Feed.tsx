// Conversation renderers: the user's message, assistant prose (markdown,
// tables, code with copy), compact tool traces, approvals, errors and notices.

import React, { useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, ChevronRight, CircleSlash, FileText, GitPullRequestArrow, HelpCircle, Info, Minus, RotateCw, ShieldAlert, X } from "lucide-react";
import type { FeedItem, ToolChip } from "../../shared/types";
import { fmtMd } from "../utils/markdown";

function fmtTime(ts?: number): string {
  if (!ts) return "";
  return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

// ─── User entry ──────────────────────────────────────────────────────────────

export function UserEntry({ item }: { item: Extract<FeedItem, { kind: "user" }> }) {
  return (
    <div className="user-entry">
      <div className="user-bubble" title={item.at ? `Sent ${fmtTime(item.at)}` : undefined}>
        <ChevronRight size={16} strokeWidth={2.6} className="user-glyph" aria-hidden="true" />
        <span className="user-text">{item.text}</span>
      </div>
      {item.fileNames && item.fileNames.length > 0 && (
        <div className="user-files">
          {item.fileNames.map((n, i) => (
            <span key={i} className="file-tag" title={n}>
              <FileText size={12} aria-hidden="true" /> <span className="file-tag-name">{n}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Assistant output ────────────────────────────────────────────────────────

export function OutputBlock({ item }: { item: Extract<FeedItem, { kind: "assistant" }> }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const handler = (e: Event) => {
      const btn = (e.target as HTMLElement).closest(".copy-btn") as HTMLElement | null;
      if (btn?.dataset.code !== undefined) {
        // dataset already decodes the attribute's entities: this is the code as written.
        void navigator.clipboard.writeText(btn.dataset.code).then(() => {
          btn.textContent = "Copied";
          setTimeout(() => (btn.textContent = "Copy"), 1200);
        }, () => {
          btn.textContent = "Copy failed";
          setTimeout(() => (btn.textContent = "Copy"), 1600);
        });
      }
    };
    el.addEventListener("click", handler);
    return () => el.removeEventListener("click", handler);
  }, []);

  return (
    <div className="out-block" aria-busy={item.streaming || undefined}>
      {/* While streaming, a cursor follows the last word (CSS ::after). */}
      <div ref={ref} className={`message-content ${item.streaming ? "message-streaming" : ""}`} dangerouslySetInnerHTML={{ __html: fmtMd(item.text) }} />
    </div>
  );
}

// ─── Tool trace ──────────────────────────────────────────────────────────────

const STEP_STATE: Record<ToolChip["status"], string> = {
  queued: "Waiting",
  running: "Running",
  ok: "Done",
  error: "Failed",
  unknown: "Outcome unknown",
  skipped: "Not run",
};

function StepIcon({ status }: { status: ToolChip["status"] }) {
  switch (status) {
    case "running": return <span className="trace-spinner" />;
    case "ok": return <Check size={12} strokeWidth={3} />;
    case "unknown": return <HelpCircle size={13} strokeWidth={2.4} />;
    case "skipped": return <Minus size={12} strokeWidth={3} />;
    case "queued": return null;
    default: return <X size={12} strokeWidth={3} />;
  }
}

function TraceStep({ chip }: { chip: ToolChip }) {
  return (
    <div className={`trace-step trace-step-${chip.status}`}>
      <span className="trace-icon" role="img" aria-label={STEP_STATE[chip.status]}>
        <StepIcon status={chip.status} />
      </span>
      <span className="trace-text">
        <span className="trace-label">{chip.label}</span>
        {chip.summary && <span className="trace-summary"> · {chip.summary}</span>}
        {chip.detail && <span className="trace-detail" title={chip.detail}>{chip.detail}</span>}
      </span>
    </div>
  );
}

export function ToolTrace({ item }: { item: Extract<FeedItem, { kind: "tools" }> }) {
  return (
    <div className="trace">
      {item.tools.map((chip) => (
        <TraceStep key={chip.id} chip={chip} />
      ))}
    </div>
  );
}

// ─── Change set (approval) ───────────────────────────────────────────────────

/** Approval is permission, not a result: the verdict never says a change was
 * applied — whether it was is reported by the trace that runs it. */
export function ChangeSet({
  item,
  onDecide,
}: {
  item: Extract<FeedItem, { kind: "approval" }>;
  onDecide: (approved: boolean) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const pending = item.status === "pending";
  const ops = showAll ? item.ops : item.ops.slice(0, 8);

  return (
    <div className={`changeset ${item.destructive ? "changeset-danger" : item.helper ? "changeset-warn" : ""} ${!pending ? "changeset-settled" : ""}`}>
      <div className="changeset-head">
        {item.destructive ? <ShieldAlert size={16} aria-hidden="true" />
          : item.helper ? <AlertTriangle size={16} aria-hidden="true" />
          : <GitPullRequestArrow size={16} aria-hidden="true" />}
        <span>
          {item.helper ? "Helper Script Include needs your approval"
            : item.plan ? `Plan needs your approval · ${item.ops.length === 1 ? "1 change" : `${item.ops.length} changes`}`
            : item.destructive ? "Delete needs your approval"
            : item.ops.length === 1 ? "Change needs your approval" : `${item.ops.length} changes need your approval`}
        </span>
      </div>
      {item.where && <div className="changeset-where">On {item.where}</div>}
      {item.explain && (
        <div className="changeset-explain">
          <div className="changeset-explain-title"><Info size={14} aria-hidden="true" /> {item.explain.title}</div>
          {item.explain.lines.map((line, i) => {
            // "Why: …" — the short lead-in is set in bold.
            const lead = /^([^:]{1,20}):\s/.exec(line);
            return <p key={i}>{lead ? <><strong>{lead[1]}:</strong> {line.slice(lead[0].length)}</> : line}</p>;
          })}
        </div>
      )}
      <ul className="changeset-ops">
        {ops.map((op, i) => (
          <li key={i} className="changeset-op">{op}</li>
        ))}
      </ul>
      {!showAll && item.ops.length > 8 && (
        <button type="button" className="link-btn changeset-more" onClick={() => setShowAll(true)}>
          Show {item.ops.length - 8} more
        </button>
      )}
      {pending ? (
        <div className="changeset-foot">
          <button type="button" className={item.destructive ? "btn-danger" : "btn-solid"} onClick={() => onDecide(true)}>
            <Check size={15} aria-hidden="true" /> Approve
          </button>
          <button type="button" className="btn-line" onClick={() => onDecide(false)}>
            <X size={15} aria-hidden="true" /> Reject
          </button>
        </div>
      ) : (
        <div className={`changeset-verdict verdict-${item.status}`}>
          {item.status === "approved" ? <><Check size={14} aria-hidden="true" /> Approved</>
            : item.status === "denied" ? <><CircleSlash size={14} aria-hidden="true" /> Rejected</>
            : <><CircleSlash size={14} aria-hidden="true" /> Expired — nothing was changed</>}
        </div>
      )}
    </div>
  );
}

// ─── Fault / notice / working ────────────────────────────────────────────────

/** Plain text with `backticked` commands shown as code — React escapes the rest. */
function InlineText({ text }: { text: string }) {
  return <>{text.split(/`([^`]+)`/g).map((part, i) => (i % 2 ? <code key={i} className="inline-code">{part}</code> : part))}</>;
}

function ResumeButton({ onResume }: { onResume: () => void }) {
  return (
    <button type="button" className="btn-line btn-small resume-btn" onClick={onResume}>
      <RotateCw size={13} aria-hidden="true" /> Resume
    </button>
  );
}

export function FaultBlock({ item, onResume }: { item: Extract<FeedItem, { kind: "error" }>; onResume?: () => void }) {
  return (
    <div className="callout callout-danger" role="alert">
      <AlertTriangle size={16} aria-hidden="true" />
      <div className="callout-body">
        <span><InlineText text={item.text} /></span>
        {onResume && <ResumeButton onResume={onResume} />}
      </div>
    </div>
  );
}

export function NoticeBlock({ item, onResume }: { item: Extract<FeedItem, { kind: "notice" }>; onResume?: () => void }) {
  if (item.tone === "warning") {
    return (
      <div className="callout callout-warn" role="status">
        <AlertTriangle size={16} aria-hidden="true" />
        <div className="callout-body">
          <span><InlineText text={item.text} /></span>
          {onResume && <ResumeButton onResume={onResume} />}
        </div>
      </div>
    );
  }
  return <div className="notice-block"><InlineText text={item.text} /></div>;
}

export function Working() {
  return (
    <div className="working-row" role="status">
      <span className="working-dots" aria-hidden="true"><span /><span /><span /></span>
      <span>Working…</span>
    </div>
  );
}

/** Renders one feed item; history and chat share it. */
export function FeedEntry({
  item,
  onDecide,
  resumeFor,
}: {
  item: FeedItem;
  onDecide?: (id: string, approved: boolean) => void;
  resumeFor?: (runId?: string) => (() => void) | undefined;
}) {
  switch (item.kind) {
    case "user":
      return <UserEntry item={item} />;
    case "assistant":
      return <OutputBlock item={item} />;
    case "tools":
      return <ToolTrace item={item} />;
    case "approval":
      return <ChangeSet item={item} onDecide={(ok) => onDecide?.(item.id, ok)} />;
    case "error":
      return <FaultBlock item={item} onResume={resumeFor?.(item.runId)} />;
    case "notice":
      return <NoticeBlock item={item} onResume={resumeFor?.(item.runId)} />;
    default:
      return null;
  }
}
