import type { OfferlayerEnv } from "@offerlayer/db";

const LOOPBACK = /127\.0\.0\.1|localhost|0\.0\.0\.0|::1/i;
export const PRODUCTION_ORIGIN = "https://offerlayer.grok.me";

export function isLoopbackHost(value: string): boolean {
  return LOOPBACK.test(value);
}

function asOrigin(value: string): string {
  const trimmed = value.trim().replace(/\/$/, "");
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
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

function envPublicOrigin(env: OfferlayerEnv): string | null {
  for (const raw of [env.shopifyAppUrl, env.publicBaseUrl]) {
    if (!raw || isLoopbackHost(raw)) continue;
    return asOrigin(raw);
  }
  const vercel =
    process.env.VERCEL_PROJECT_PRODUCTION_URL ||
    process.env.OFFERLAYER_PUBLIC_HOST ||
    (process.env.VERCEL || process.env.VERCEL_ENV ? "offerlayer.grok.me" : "");
  if (vercel && !isLoopbackHost(vercel)) return asOrigin(vercel);
  return null;
}

/** Public origin for install_url / demo_complete_url. Never localhost on a public Host. */
export function requestPublicOrigin(
  headers: { header: (n: string) => string | undefined },
  env: OfferlayerEnv,
): string {
  const host = headerHost(headers);
  if (host && !isLoopbackHost(host)) {
    return `${headerProto(headers, host)}://${hostnameWithoutPort(host)}`;
  }
  const fromEnv = envPublicOrigin(env);
  if (fromEnv) return fromEnv;
  if (process.env.VERCEL || process.env.VERCEL_ENV) return PRODUCTION_ORIGIN;
  if (host) return `${headerProto(headers, host)}://${host}`;
  const fallback = env.publicBaseUrl.replace(/\/$/, "");
  return fallback || "http://127.0.0.1:8787";
}

export function rewritePublicUrl(url: string, origin: string): string {
  try {
    const parsed = new URL(url);
    if (!isLoopbackHost(parsed.host) && !isLoopbackHost(parsed.hostname)) {
      if (parsed.port) {
        parsed.port = "";
        return parsed.toString();
      }
      return url;
    }
    const next = new URL(origin);
    parsed.protocol = next.protocol;
    parsed.hostname = next.hostname;
    parsed.port = next.port;
    return parsed.toString();
  } catch {
    return url;
  }
}
