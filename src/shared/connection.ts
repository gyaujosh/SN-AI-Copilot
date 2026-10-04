/** Health describes the browser relay, not a successful authenticated API call. */
export const BRIDGE_VERSION = 1;
export type ConnectionPhase = "checking" | "ready" | "reconnecting" | "unavailable" | "sign_in_required";
// not_sent: the page never received the request (certain, safe to resend).
// cancelled: the run was stopped while waiting.
export type ConnectionFailure = "transport" | "timeout" | "network" | "authentication" | "access_denied" | "http" | "incompatible" | "no_tab" | "document_changed" | "not_sent" | "cancelled";
export interface ConnectionState {
  phase: ConnectionPhase;
  host: string | null;
  checkedAt: number | null;
  reason?: ConnectionFailure;
}
export const INITIAL_CONNECTION: ConnectionState = { phase: "checking", host: null, checkedAt: null };
/** Accessible descriptions. "Ready" means the browser helper answered — it
 * never claims that ServiceNow API permissions were verified. */
export const CONNECTION_LABELS: Record<ConnectionPhase, string> = {
  checking: "Checking the ServiceNow tab", ready: "Browser helper ready", reconnecting: "Reconnecting to ServiceNow",
  unavailable: "No usable ServiceNow tab", sign_in_required: "ServiceNow sign-in required",
};
export interface BridgeHealth {
  version: number;
  ready: boolean;
  hostname: string;
  documentToken: string;
  reason?: "authentication" | "incompatible";
}
const SERVICENOW_HOST = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.service-now\.com$/;
export function serviceNowHost(url?: string): string | null {
  try {
    const parsed = new URL(url || "");
    return parsed.protocol === "https:" && SERVICENOW_HOST.test(parsed.hostname)
      ? parsed.hostname : null;
  } catch { return null; }
}
/** The bare instance hostname in what a user typed or pasted — a host, or a
 * URL on it ("https://dev12345.service-now.com/nav_to.do") — else null. */
export function parseInstanceHost(input: string): string | null {
  const host = String(input ?? "").trim().replace(/^https?:\/\//i, "").replace(/[/?#].*$/s, "")
    .replace(/:443$/, "").replace(/\.$/, "").toLowerCase();
  return SERVICENOW_HOST.test(host) ? host : null;
}
export function eligibleServiceNowUrl(url?: string): boolean {
  // Keep in sync with manifest exclude_matches (case sensitive).
  return !!serviceNowHost(url) && !/[?&](?:XML|WSDL)/.test(url || "");
}
