/**
 * Redaction. Devtools traffic leaves the page (bridge, CLI, exports), so
 * anything that looks like a credential is scrubbed before it becomes an event.
 * Bodies are never captured unless `captureBodies` is turned on explicitly.
 */

const SENSITIVE_PARAM = /(token|key|secret|auth|session|ticket|password|passwd|signature|sig|code)/i;
const SENSITIVE_HEADER = /^(authorization|cookie|set-cookie|x-api-key|x-auth-token|proxy-authorization)$/i;
const BEARER = /\b(bearer|basic)\s+[a-z0-9._~+/=-]{8,}/gi;
const JWT = /\beyJ[a-zA-Z0-9_-]{5,}\.[a-zA-Z0-9_-]{5,}\.[a-zA-Z0-9_-]{5,}\b/g;

export const REDACTED = "[redacted]";

export function redactUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input, "http://localhost/");
  } catch {
    return redactText(input);
  }
  if (url.username || url.password) {
    url.username = "";
    url.password = "";
  }
  let changed = false;
  for (const key of [...url.searchParams.keys()]) {
    if (SENSITIVE_PARAM.test(key)) {
      url.searchParams.set(key, REDACTED);
      changed = true;
    }
  }
  if (url.hash && SENSITIVE_PARAM.test(url.hash)) {
    url.hash = "";
    changed = true;
  }
  // Preserve relative inputs as given (the base above is only for parsing).
  if (!/^[a-z][a-z0-9+.-]*:/i.test(input)) {
    const rel = url.pathname + url.search + url.hash;
    return changed ? rel : redactText(input);
  }
  return redactText(url.toString());
}

export function redactText(text: string): string {
  return text.replace(JWT, REDACTED).replace(BEARER, (_, scheme: string) => `${scheme} ${REDACTED}`);
}

export function redactHeaders(headers: Iterable<[string, string]>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of headers) {
    out[k.toLowerCase()] = SENSITIVE_HEADER.test(k) ? REDACTED : redactText(v);
  }
  return out;
}

/** Best-effort key redaction inside small structured payloads. */
export function redactValue<T>(value: T, depth = 0): T {
  if (depth > 6 || value === null || value === undefined) return value;
  if (typeof value === "string") return redactText(value) as T;
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1)) as T;
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_PARAM.test(k) && typeof v === "string" ? REDACTED : redactValue(v, depth + 1);
    }
    return out as T;
  }
  return value;
}
