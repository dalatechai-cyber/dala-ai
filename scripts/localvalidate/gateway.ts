/**
 * A local stand-in for Supabase's API gateway, so the repo's own scripts can run against a
 * scratch Postgres + PostgREST exactly as they run against the project.
 *
 * LOCAL ONLY. It exists so onboarding can be proven on a replica and never on a live tenant
 * (founder, 2026-09-27). `@supabase/supabase-js` addresses `${url}/rest/v1/...`; PostgREST
 * serves `/...`. This forwards the one to the other, untouched, the same mapping
 * `scripts/verify/postgrest.ts` makes for CI.
 *
 *     # PostgREST on :3001 against the scratch database, as in .github/workflows/schema.yml
 *     PGRST_URL=http://127.0.0.1:3001 PGRST_JWT_SECRET=<the local literal> \
 *       node scripts/localvalidate/gateway.ts 54321
 *
 * It prints the two lines to export: `NEXT_PUBLIC_SUPABASE_URL` and a `service_role` token
 * signed with the throwaway secret. Nothing outside that scratch PostgREST trusts either.
 */
import { createHmac } from 'node:crypto';
import http from 'node:http';

const target = process.env['PGRST_URL'];
const secret = process.env['PGRST_JWT_SECRET'];
if (target === undefined || secret === undefined || secret.length < 32) {
  process.stderr.write('gateway: PGRST_URL and PGRST_JWT_SECRET (≥32 chars) must be set\n');
  process.exit(2);
}
const port = Number(process.argv[2] ?? '54321');

const enc = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const head = enc({ alg: 'HS256', typ: 'JWT' });
const body = enc({ role: 'service_role', iss: 'dala-local', iat: now, exp: now + 12 * 3600 });
const jwt = `${head}.${body}.${createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')}`;

const server = http.createServer((req, res) => {
  const rest = (req.url ?? '/').replace(/^\/rest\/v1/, '');
  const upstream = new URL(rest === '' ? '/' : rest, target);
  const proxied = http.request(upstream,
    { method: req.method, headers: { ...req.headers, host: upstream.host } },
    (up) => { res.writeHead(up.statusCode ?? 502, up.headers); up.pipe(res); });
  proxied.on('error', (err) => {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: err.message }));
  });
  req.pipe(proxied);
});
server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`export NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:${port}\n`);
  process.stdout.write(`export SUPABASE_SECRET_PUBLISH=${jwt}\n`);
});
