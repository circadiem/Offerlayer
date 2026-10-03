/**
 * TLS for the Postgres connection. Certificates are always verified; a
 * provider whose CA is not in Node's trust store (e.g. Supabase) supplies it
 * in DATABASE_CA_CERT (PEM).
 */
export function pgSslConfig(
  url: string,
  caCert?: string | null,
): { rejectUnauthorized: true; ca?: string } | undefined {
  if (!/sslmode=(require|verify-full|verify-ca)/i.test(url)) return undefined;
  return caCert ? { rejectUnauthorized: true, ca: caCert } : { rejectUnauthorized: true };
}
