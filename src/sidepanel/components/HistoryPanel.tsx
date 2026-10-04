// View-only browser for archived sessions. Archives hold the feed (UI
// transcript) only — nothing here is ever sent to the model, so browsing old
// conversations costs zero context in the current session.

import React, { useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ArrowLeft, Eye, MessageSquareText, Trash2 } from "lucide-react";
import { useView } from "../hooks/useView";
import type { AgentApi } from "../hooks/useAgent";
import { FeedEntry } from "./Feed";
import type { SessionMeta } from "../../shared/types";
import { costBasis, formatTokens, formatUsd, isApproximate, sessionSpend, totalTokens } from "../utils/cost";

/** What an opened chat cost: dollars first, then where the tokens went. */
function SessionCostLine({ meta }: { meta: SessionMeta }) {
  const cost = meta.cost;
  if (!cost) {
    return typeof meta.usd === "number" ? <div className="hist-cost"><p><strong>{formatUsd(meta.usd, true)}</strong> spent</p></div> : null;
  }
  // Each phrase stays whole; lines break only between them.
  return (
    <div className="hist-cost" title={costBasis(cost)}>
      <p>
        <span><strong>{isApproximate(cost) ? "≈ " : ""}{formatUsd(cost.usd, true)}</strong> spent</span>
        {" · "}<span>{formatTokens(totalTokens(cost))} tokens</span>
        {" · "}<span>{cost.requests} model call{cost.requests === 1 ? "" : "s"}</span>
      </p>
      <p className="hist-cost-split">
        <span>{formatTokens(cost.inputTokens)} in</span>
        {" · "}<span>{formatTokens(cost.cacheReadTokens)} cached</span>
        {" · "}<span>{formatTokens(cost.outputTokens)} out</span>
      </p>
    </div>
  );
}

function fmtWhen(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
    " · " +
    d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export function HistoryPanel({ open, onClose, agent }: { open: boolean; onClose: () => void; agent: AgentApi }) {
  const viewRef = useView(open, onClose);
  useEffect(() => {
    if (open) {
      agent.clearSessionDetail();
      agent.listSessions();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const detail = agent.sessionDetail;
  const detailMeta = detail ? agent.sessions.find((s) => s.id === detail.id) : null;

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="app-view"
          ref={viewRef}
          role="region"
          aria-label="History"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 8 }}
          transition={{ duration: 0.16 }}
        >
          <div className="view-head">
            <button
              type="button"
              className="icon-btn view-back"
              onClick={() => (detail ? agent.clearSessionDetail() : onClose())}
              aria-label={detail ? "All sessions" : "Back to chat"}
              title={detail ? "All sessions" : "Back to chat"}
            >
              <ArrowLeft size={20} />
            </button>
            <span className="view-head-text">
              <h1 className="view-title">History</h1>
              <span className="view-sub">Read-only. Nothing here is sent to the AI.</span>
            </span>
          </div>

          {detail ? (
            <div className="view-body hist-detail">
              <div className="hist-detail-bar">
                <span className="hist-detail-title">{detailMeta?.title ?? "Past session"}</span>
                <span className="readonly-badge">
                  <Eye size={12} aria-hidden="true" /> Read-only{detailMeta ? ` · ${fmtWhen(detailMeta.at)}` : ""}
                </span>
                {detailMeta && <SessionCostLine meta={detailMeta} />}
              </div>
              <div className="console-feed hist-feed">
                {detail.feed.map((item) => <FeedEntry key={item.id} item={item} />)}
              </div>
            </div>
          ) : (
            <div className="view-body">
              {agent.sessions.length === 0 ? (
                <div className="empty-state">
                  <MessageSquareText size={22} aria-hidden="true" />
                  <p>No past sessions yet. When you start a new chat, the current one is saved here.</p>
                </div>
              ) : (
                <ul className="hist-list">
                  {agent.sessions.map((s) => {
                    const spend = sessionSpend(s);
                    return (
                      <li key={s.id} className="hist-row">
                        <button type="button" className="hist-open" onClick={() => agent.getSession(s.id)}>
                          <span className="hist-title">{s.title}</span>
                          <span className="hist-meta">
                            {fmtWhen(s.at)} · {s.items} item{s.items === 1 ? "" : "s"}
                            {spend && <> · <span className="hist-spend">{spend}</span></>}
                          </span>
                        </button>
                        <button
                          type="button"
                          className="icon-btn hist-delete"
                          aria-label={`Delete “${s.title}”`}
                          title="Delete this session"
                          onClick={() => agent.deleteSession(s.id)}
                        >
                          <Trash2 size={16} />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
