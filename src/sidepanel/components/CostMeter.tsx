// What this chat has cost so far, beside the model picker: dollars over
// tokens at a glance, updated after every model call, with the breakdown one
// click away. It starts again at $0 with a new chat; the
// finished chat's total is saved with it in History.

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type { SessionCost } from "../../shared/types";
import { costBasis, formatTokens, formatUsd, isApproximate, totalTokens } from "../utils/cost";

const count = (n: number) => Math.round(n).toLocaleString("en-US");

export function CostMeter({
  cost,
  running,
  anchorRef,
}: {
  cost: SessionCost;
  running: boolean;
  /** The composer: the breakdown opens above it. */
  anchorRef: React.RefObject<HTMLElement>;
}) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState({ room: 360, caret: 60 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  const close = useCallback((returnFocus = true) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  // A new chat has nothing to break down.
  useEffect(() => {
    if (!cost.requests) setOpen(false);
  }, [cost.requests]);

  // Always upward — the composer sits at the foot of the panel — with the caret on the meter.
  useLayoutEffect(() => {
    if (!open) return;
    const anchor = anchorRef.current?.getBoundingClientRect();
    const button = triggerRef.current?.getBoundingClientRect();
    if (!anchor || !button) return;
    setPlacement({ room: Math.max(180, anchor.top - 16), caret: button.left - anchor.left + button.width / 2 });
  }, [open, anchorRef]);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const away = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!popRef.current?.contains(target) && !triggerRef.current?.contains(target)) close(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      close();
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc, true);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc, true);
    };
  }, [open, close]);

  if (!cost.requests) return null;

  const total = totalTokens(cost);
  const approx = isApproximate(cost) ? "≈ " : "";

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="cost-meter"
        onClick={() => (open ? close() : setOpen(true))}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`This chat so far: ${approx}${formatUsd(cost.usd)}, ${count(total)} tokens. Show cost details`}
        title="What this chat has cost so far"
      >
        <span className="cost-meter-usd">{approx}{formatUsd(cost.usd)}</span>
        <span className="cost-meter-tokens">{formatTokens(total)} tokens</span>
      </button>

      {open && (
        <div
          ref={popRef}
          className="picker picker-up cost-pop"
          role="dialog"
          aria-label="Cost of this chat"
          style={{ maxHeight: placement.room, ["--caret-x" as string]: `${placement.caret}px` }}
        >
          <div className="picker-head">
            <h2 className="picker-title">This chat</h2>
            <button ref={closeRef} type="button" className="icon-btn" onClick={() => close()} aria-label="Close cost details">
              <X size={17} />
            </button>
          </div>

          <p className="cost-total">
            <span className="cost-total-usd">{approx}{formatUsd(cost.usd, true)}</span>
            <span className="cost-total-label">spent so far</span>
          </p>

          <dl className="cost-rows">
            <div>
              <dt>{running ? "This answer so far" : "Latest answer"}</dt>
              <dd>{formatUsd(cost.turnUsd, true)}</dd>
            </div>
            <div>
              <dt>Input tokens</dt>
              <dd>{count(cost.inputTokens)}</dd>
            </div>
            <div>
              <dt>Cached input tokens</dt>
              <dd>{count(cost.cacheReadTokens)}</dd>
            </div>
            <div>
              <dt>Output tokens</dt>
              <dd>{count(cost.outputTokens)}</dd>
            </div>
            <div className="cost-row-total">
              <dt>Total tokens</dt>
              <dd>{count(total)}</dd>
            </div>
            <div>
              <dt>Model calls</dt>
              <dd>{count(cost.requests)}</dd>
            </div>
          </dl>

          <p className="cost-note">{costBasis(cost)}</p>
          <p className="cost-note">A new chat starts again at $0. Each chat&apos;s total is saved with it in History.</p>
        </div>
      )}
    </>
  );
}
