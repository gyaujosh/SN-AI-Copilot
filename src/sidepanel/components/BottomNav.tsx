import React, { useCallback, useEffect, useRef, useState } from "react";
import { History, MessageCircle, Pin, Settings } from "lucide-react";
import { useTheme } from "../theme/ThemeContext";

export type View = "chat" | "history" | "settings";

const DESTINATIONS: { id: View; label: string; icon: typeof MessageCircle }[] = [
  { id: "chat", label: "Chat", icon: MessageCircle },
  { id: "history", label: "History", icon: History },
  { id: "settings", label: "Settings", icon: Settings },
];

/** Grace before an unpinned bar retracts, so a pointer passing over an edge
 * or moving between buttons never makes it flicker. */
const HIDE_DELAY_MS = 450;

/**
 * Chat, History and Settings, plus a pin.
 *
 * Pinned, the bar stays open. Unpinned, it retracts to a thin edge with a
 * handle and opens while hovered, focused from the keyboard, or tapped. It sits
 * in the layout rather than over it: retracting gives its height back to the
 * conversation and lowers the composer; opening lifts the composer again. The
 * buttons stay in the tab order while retracted — focusing one opens the bar.
 */
export function BottomNav({ view, onNavigate }: { view: View; onNavigate: (view: View) => void }) {
  const { navPinned, setNavPinned } = useTheme();
  const [revealed, setRevealed] = useState(false);
  const navRef = useRef<HTMLElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hovered = useRef(false);
  const expanded = navPinned || revealed;

  /** Hovered, or focused from the keyboard. A mouse click also focuses a
   * button, but that alone must not hold the bar open. */
  const inUse = useCallback(() => {
    const nav = navRef.current;
    if (hovered.current || !nav) return hovered.current;
    try {
      return !!nav.querySelector(":focus-visible");
    } catch {
      return nav.contains(document.activeElement);
    }
  }, []);

  const reveal = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setRevealed(true);
  }, []);
  const conceal = useCallback((delay = HIDE_DELAY_MS) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      if (!inUse()) setRevealed(false);
    }, delay);
  }, [inUse]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  // A touch reveal ends with a tap anywhere else.
  useEffect(() => {
    if (!revealed || navPinned) return;
    const away = (e: PointerEvent) => {
      if (e.pointerType === "touch" && !navRef.current?.contains(e.target as Node)) conceal(0);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [revealed, navPinned, conceal]);

  return (
    <nav
      ref={navRef}
      className={`bottom-nav ${expanded ? "bottom-nav-open" : "bottom-nav-edge"} ${navPinned ? "bottom-nav-pinned" : ""}`}
      aria-label="Panel navigation"
      onPointerEnter={(e) => { if (e.pointerType !== "touch") { hovered.current = true; reveal(); } }}
      onPointerLeave={(e) => { if (e.pointerType !== "touch") { hovered.current = false; if (!navPinned) conceal(); } }}
      onPointerDown={(e) => {
        // The first tap on a retracted bar only opens it.
        if (e.pointerType === "touch" && !expanded) { e.preventDefault(); reveal(); }
      }}
      onFocus={reveal}
      onBlur={(e) => { if (!navPinned && !navRef.current?.contains(e.relatedTarget as Node)) conceal(250); }}
    >
      <span className="nav-handle" aria-hidden="true" />
      <div className="nav-items">
        {DESTINATIONS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            className="nav-item"
            aria-current={view === id ? "page" : undefined}
            onClick={() => {
              onNavigate(id);
              if (!navPinned) conceal();
            }}
          >
            <Icon size={21} aria-hidden="true" />
            <span>{label}</span>
          </button>
        ))}
        <span className="nav-divider" aria-hidden="true" />
        <button
          type="button"
          className="nav-pin"
          aria-pressed={navPinned}
          aria-label="Pin navigation"
          title={navPinned ? "Unpin — hide the bar when not in use" : "Pin — keep the bar visible"}
          onClick={() => setNavPinned(!navPinned)}
        >
          <Pin size={19} fill={navPinned ? "currentColor" : "none"} aria-hidden="true" />
        </button>
      </div>
    </nav>
  );
}
