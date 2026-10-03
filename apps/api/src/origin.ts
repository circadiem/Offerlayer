import type { OfferlayerEnv } from "@offerlayer/db";

const LOOPBACK = /127\.0\.0\.1|localhost|0\.0\.0\.0|::1/i;

export function isLoopbackHost(value: string): boolean {
  return LOOPBACK.test(value);
}

/** Public hosts never keep a stray :3000 / :8080. Loopback keeps its port. */
export function hostnameWithoutPort(host: string): string {
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return end >= 0 ? host.slice(0, end + 1) : host;
  }
  const idx = host.lastIndexOf(":");
  if (idx > 0 && /^\d+$/.test(host.slice(idx + 1))) return host.slice(0, idx);
  return host;
}

function headerHost(headers: { header: (n: string) => string | undefined }): string | null {
  const raw =
    headers.header("x-forwarded-host")?.split(",")[0]?.trim() ||
    headers.header("host")?.split(",")[0]?.trim();
  return raw || null;
}

function headerProto(headers: { header: (n: string) => string | undefined }, host: string): string {
  const xf = headers.header("x-forwarded-proto")?.split(",")[0]?.trim();
  if (xf) return xf.replace(/:$/, "");
  if (isLoopbackHost(host)) return "http";
  return "https";
}

/**
 * Public origin for URLs we hand out (install links, OAuth redirect, webhook
 * URLs). Outside demo mode this is always the configured API URL, never the
 * request's Host. In demo mode a non-loopback Host wins, so a demo on a
 * preview host links back to itself.
 */
export function requestPublicOrigin(
  headers: { header: (n: string) => string | undefined },
  env: OfferlayerEnv,
): string {
  if (!env.demoMode) return env.urls.api;
  const host = headerHost(headers);
  if (host && !isLoopbackHost(host)) {
    return `${headerProto(headers, host)}://${hostnameWithoutPort(host)}`;
  }
  return env.urls.api;
}
