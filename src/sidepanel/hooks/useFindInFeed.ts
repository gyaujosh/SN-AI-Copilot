// Ctrl+F-style find within the transcript. Walks text nodes in the feed
// container, wraps matches in <mark data-find> elements, and navigates between
// them. Marks are cleared and re-applied whenever the query or the feed
// changes (debounced), which also heals any marks React re-rendering wiped.

import { useCallback, useEffect, useRef, useState } from "react";

function clearMarks(root: HTMLElement) {
  const marks = root.querySelectorAll("mark[data-find]");
  marks.forEach((mark) => {
    const parent = mark.parentNode;
    if (!parent) return;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
    parent.normalize();
  });
}

function applyMarks(root: HTMLElement, query: string): HTMLElement[] {
  const q = query.toLowerCase();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const p = node.parentElement;
      if (!p) return NodeFilter.FILTER_REJECT;
      if (p.closest("mark[data-find], textarea, input, .find-bar")) return NodeFilter.FILTER_REJECT;
      return node.nodeValue && node.nodeValue.toLowerCase().includes(q)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_SKIP;
    },
  });

  const textNodes: Text[] = [];
  let n: Node | null;
  while ((n = walker.nextNode())) textNodes.push(n as Text);

  const marks: HTMLElement[] = [];
  for (const textNode of textNodes) {
    let node: Text = textNode;
    // A single text node can contain multiple matches — split iteratively.
    for (;;) {
      const value = node.nodeValue || "";
      const idx = value.toLowerCase().indexOf(q);
      if (idx < 0) break;
      const matchNode = node.splitText(idx);
      const rest = matchNode.splitText(query.length);
      const mark = document.createElement("mark");
      mark.dataset.find = "1";
      matchNode.parentNode?.replaceChild(mark, matchNode);
      mark.appendChild(matchNode);
      marks.push(mark);
      node = rest;
    }
  }
  return marks;
}

export function useFindInFeed(containerRef: React.RefObject<HTMLElement>, feedVersion: unknown, enabled = true) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hitCount, setHitCount] = useState(0);
  const [current, setCurrent] = useState(0); // 1-based for display
  const marksRef = useRef<HTMLElement[]>([]);
  const currentRef = useRef(0); // 0-based index

  const highlight = useCallback((index: number, scroll: boolean) => {
    const marks = marksRef.current;
    marks.forEach((m) => m.classList.remove("find-current"));
    if (!marks.length) {
      setCurrent(0);
      return;
    }
    const i = ((index % marks.length) + marks.length) % marks.length;
    currentRef.current = i;
    marks[i].classList.add("find-current");
    if (scroll) marks[i].scrollIntoView({ block: "center", behavior: "auto" });
    setCurrent(i + 1);
  }, []);

  const runSearch = useCallback(
    (scrollToFirst: boolean) => {
      const root = containerRef.current;
      if (!root) return;
      clearMarks(root);
      marksRef.current = [];
      if (!open || query.trim().length < 1) {
        setHitCount(0);
        setCurrent(0);
        return;
      }
      const marks = applyMarks(root, query.trim());
      marksRef.current = marks;
      setHitCount(marks.length);
      highlight(Math.min(currentRef.current, Math.max(marks.length - 1, 0)), scrollToFirst);
    },
    [containerRef, open, query, highlight]
  );

  // Re-run on query change (jump to first hit).
  useEffect(() => {
    currentRef.current = 0;
    const t = setTimeout(() => runSearch(true), 120);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, open]);

  // Heal marks when the feed updates (don't yank the viewport).
  useEffect(() => {
    if (!open || !query.trim()) return;
    const t = setTimeout(() => runSearch(false), 200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feedVersion]);

  const next = useCallback(() => highlight(currentRef.current + 1, true), [highlight]);
  const prev = useCallback(() => highlight(currentRef.current - 1, true), [highlight]);

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    const root = containerRef.current;
    if (root) clearMarks(root);
    marksRef.current = [];
    setHitCount(0);
    setCurrent(0);
  }, [containerRef]);

  // Cmd/Ctrl+F opens, Escape closes.
  useEffect(() => {
    if (!enabled) return;
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setOpen(true);
      } else if (e.key === "Escape" && open) {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, close, enabled]);

  return { open, setOpen, query, setQuery, hitCount, current, next, prev, close };
}
