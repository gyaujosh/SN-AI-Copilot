const REDACTED = "[REDACTED]";

// `token` on its own is deliberate: `access_token`/`refresh_token`/`id_token`
// were listed but a field named plainly `token` was not, and that is the
// commonest name of all. The (?:^|_)…(?:$|_) anchors keep it from matching
// `tokenizer` or `tokens_used`. The short forms (`pwd`, `passwd`),
// `private_key` and `connection_string` are whole words the same way:
// `ssh_private_key` and `x.integration.pwd` match; `passport` and `compass` don't.
const SECRET_KEY = /(?:^|_)(?:password|passwd|pwd|passphrase|secret|authorization|cookie|set_cookie|g_ck|csrf|token|access_token|refresh_token|id_token|api_key|apikey|client_secret|private_key|connection_string)(?:$|_)/i;
const CREDENTIAL_TEXT = /\b(?:basic|bearer)\s+[A-Za-z0-9._~+/=-]+/gi;
const COOKIE_TEXT = /\b(?:cookie|set-cookie)\s*:\s*[^\r\n]+/gi;
// ServiceNow script records frequently use generic fields such as `script` or
// `body`. Redact only the value assigned to a credential-like identifier so
// the surrounding, useful code remains available to the model.
const HARDCODED_CREDENTIAL = /((?:api[_ -]?key|apikey|client[_ -]?secret|access[_ -]?token|refresh[_ -]?token|id[_ -]?token|password|passwd|\bpwd|passphrase|secret|authorization|token)\s*(?:[:=]\s*|["']\s*:\s*["']))(?:"[^"\r\n]*"|'[^'\r\n]*'|`[^`\r\n]*`|[^\s,;)}\]]+)/gi;
const SEMANTIC_NAME_KEYS = new Set(["name", "key", "property", "property_name", "parameter", "variable", "field"]);
const SEMANTIC_VALUE_KEYS = new Set(["value", "display_value", "raw_value"]);

function redactString(value: string): string {
  return value
    .replace(CREDENTIAL_TEXT, REDACTED)
    .replace(COOKIE_TEXT, REDACTED)
    .replace(HARDCODED_CREDENTIAL, `$1${REDACTED}`);
}

export function isSecretKey(key: string): boolean {
  const normalized = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[.-]/g, "_");
  return SECRET_KEY.test(normalized);
}

function hasSecretSemanticName(record: Record<string, unknown>): boolean {
  return Object.entries(record).some(([key, value]) =>
    SEMANTIC_NAME_KEYS.has(key.toLowerCase()) && typeof value === "string" && isSecretKey(value)
  );
}

/**
 * AI-safe redaction for ServiceNow payloads. In addition to secret-shaped
 * object keys, ServiceNow property records are inspected semantically: a
 * secret-like `name` (for example `integration.password`) redacts its generic
 * `value` fields before the payload can enter model history or local storage.
 */
export function redactForAi<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value === "string") return redactString(value) as T;
  if (value == null || typeof value !== "object") return value;
  if (seen.has(value as object)) return "[Circular]" as T;
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((entry) => redactForAi(entry, seen)) as T;
  }

  const record = value as Record<string, unknown>;
  const secretNamedRecord = hasSecretSemanticName(record);
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    output[key] = isSecretKey(key) || (secretNamedRecord && SEMANTIC_VALUE_KEYS.has(key.toLowerCase()))
      ? REDACTED
      : redactForAi(entry, seen);
  }
  return output as T;
}

/** A page URL with the values of secret-named query parameters (token,
 * password, g_ck, …) replaced. The rest — table, sys_id, filters — is kept. */
export function redactUrl(url: string): string {
  const text = String(url ?? "");
  const q = text.indexOf("?");
  if (q < 0) return text;
  const hash = text.indexOf("#", q);
  const end = hash < 0 ? text.length : hash;
  const params = text.slice(q + 1, end).split("&").map((pair) => {
    const eq = pair.indexOf("=");
    if (eq < 0) return pair;
    let name = pair.slice(0, eq);
    try { name = decodeURIComponent(name); } catch { /* keep it as sent */ }
    return isSecretKey(name) ? `${pair.slice(0, eq)}=${REDACTED}` : pair;
  });
  return text.slice(0, q + 1) + params.join("&") + text.slice(end);
}

/** Backwards-compatible name for callers that redact diagnostics or storage. */
export const redactSecrets = redactForAi;

export function safeDiagnostic(error: unknown): string {
  const source =
    error instanceof Error
      ? { name: error.name, message: error.message }
      : typeof error === "string"
        ? error
        : error;
  try {
    return typeof source === "string" ? redactString(source) : JSON.stringify(redactSecrets(source));
  } catch {
    return "Unable to serialize diagnostic";
  }
}
