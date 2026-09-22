function redact(value: string): string {
  return value
    .replace(/olt_[A-Za-z0-9._-]+/g, "olt_[redacted]")
    .replace(/agt_live_[A-Za-z0-9._-]+/g, "agt_live_[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]");
}

export function logJson(event: Record<string, unknown>): void {
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(event)) {
    if (k === "token" || k === "authorization" || k === "apiKey" || k === "rawJws") {
      safe[k] = "[redacted]";
      continue;
    }
    if (typeof v === "string") safe[k] = redact(v);
    else safe[k] = v;
  }
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), ...safe })}\n`);
}
