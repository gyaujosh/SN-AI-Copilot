import type React from "react";

/**
 * Arrow-key movement for a group with one tab stop (tabs, radio groups):
 * Left/Up and Right/Down move to the previous/next option, Home/End to the
 * ends. Choosing on arrow matches how native radios and tabs behave.
 */
export function arrowKeys<T>(options: readonly T[], current: T, choose: (next: T) => void) {
  return (event: React.KeyboardEvent<HTMLElement>) => {
    const index = options.indexOf(current);
    let next = -1;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (index + 1) % options.length;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (index - 1 + options.length) % options.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = options.length - 1;
    if (next < 0) return;
    event.preventDefault();
    choose(options[next]);
    // Focus follows the choice; the option re-renders as the group's tab stop.
    const group = event.currentTarget.closest('[role="tablist"], [role="radiogroup"]');
    const items = group?.querySelectorAll<HTMLElement>('[role="tab"], [role="radio"]');
    items?.[next]?.focus();
  };
}
