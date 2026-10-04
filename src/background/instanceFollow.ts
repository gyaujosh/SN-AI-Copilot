// Which instance the chat agent targets, and when it may follow a tab.
//
// "Auto until pinned": with no pin, the agent works on the ServiceNow instance
// the user is actually viewing — and only that. It follows instances that were
// never added in Settings too (they accept changes as well, each approved), so
// Auto never quietly works somewhere other than the page on screen. A background tab
// finishing its load must never move it — whichever tab happened to report
// last would otherwise win. With a pin, nothing moves it but the user.

import type { SnContext, SnInstance } from "../shared/types";
import { parseInstanceHost } from "../shared/connection";

/** Should this tab move Auto? Returns the host to follow and the instance the
 * user added for it (null if they haven't), or null for "leave it alone". */
export function decideFollow(opts: {
  pinnedInstanceId: string | null;
  senderTabActive: boolean;
  hostname: string | null | undefined;
  instances: SnInstance[];
}): { host: string; instance: SnInstance | null } | null {
  if (opts.pinnedInstanceId !== null) return null;
  if (!opts.senderTabActive) return null;
  const host = opts.hostname ? parseInstanceHost(opts.hostname) : null;
  if (!host) return null;
  return { host, instance: opts.instances.find((i) => i.host === host) ?? null };
}

/**
 * The page context handed to the model.
 *
 * Auto keeps the old rule: the bound tab's context wins, then the newest
 * update from any tab. Pinned narrows it: only contexts on the pinned host
 * count, and none at all means null — an honest "No tab" beats a
 * wrong-instance context that the seatbelt would refuse anyway.
 */
export function pickContext(
  contexts: Iterable<SnContext>,
  bound: SnContext | null,
  preferredHost: string | null,
  pinned: boolean
): SnContext | null {
  const host = preferredHost?.toLowerCase() ?? null;
  const onHost = (c: SnContext | null): boolean => !!c?.hostname && c.hostname.toLowerCase() === host;
  if (bound && (!pinned || onHost(bound))) return bound;

  let newestOnHost: SnContext | null = null;
  let newest: SnContext | null = null;
  for (const c of contexts) {
    if (!newest || (c.updatedAt || 0) > (newest.updatedAt || 0)) newest = c;
    if (onHost(c) && (!newestOnHost || (c.updatedAt || 0) > (newestOnHost.updatedAt || 0))) newestOnHost = c;
  }
  if (pinned) return newestOnHost;
  return newest;
}
