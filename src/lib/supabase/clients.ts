/**
 * Shared Supabase clients. Nothing else in the codebase may construct one — enforced by
 * scripts/guards/check-supabase-nostore.mjs, which fails on any `createClient(` or any
 * direct import of `@supabase/supabase-js` outside this directory.
 *
 * ## One named key per surface
 *
 * The webhook and the worker hold DIFFERENT Supabase secret keys, and so does every other
 * component. That is not ceremony: these keys carry `service_role`, which holds BYPASSRLS.
 * A leaked key is therefore a leak of every tenant's data at once, and the only thing that
 * bounds the blast radius is being able to revoke exactly the surface that leaked without
 * taking the platform down.
 *
 * ## service_role holds BYPASSRLS — so RLS is not what protects tenants here
 *
 * RLS is the client-facing half of isolation and does nothing about a service-role route
 * with a scoping bug, which is where all the volume and all the spend are. What still
 * catches that is the composite-FK spine: children reference `(tenant_id, parent_id)`, so
 * a cross-tenant write is refused by the database even under BYPASSRLS. Every query in
 * this codebase must therefore carry `tenant_id` explicitly. Never rely on a policy to add
 * it — under these keys, there is no policy running.
 *
 * There is no module-scope client cache on purpose beyond these two constants, and neither
 * holds per-tenant state. A warm lambda is reused across tenants; anything per-tenant
 * cached at module scope is a cross-tenant leak (CLAUDE.md rule 7).
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { required } from '../env.ts';
import { noStoreFetch } from './fetch.ts';

/** Takes the secret VALUE, not its name: the env name stays a literal at the call site,
 *  where both a reader and scripts/guards/check-env-example.mjs can see which surface
 *  depends on which key. */
function serviceClient(secret: string): SupabaseClient {
  return createClient(required('NEXT_PUBLIC_SUPABASE_URL'), secret, {
    auth: { persistSession: false, autoRefreshToken: false },
    // The whole point of this module. See fetch.ts.
    global: { fetch: noStoreFetch },
  });
}

let webhookClient: SupabaseClient | undefined;
let workerClient: SupabaseClient | undefined;

/** For the Meta webhook surface: resolution and idempotency only. */
export function supabaseWebhook(): SupabaseClient {
  webhookClient ??= serviceClient(required('SUPABASE_SECRET_WEBHOOK'));
  return webhookClient;
}

/** For the queue worker surface. */
export function supabaseWorker(): SupabaseClient {
  workerClient ??= serviceClient(required('SUPABASE_SECRET_WORKER'));
  return workerClient;
}

/** Test seam: drop memoised clients so a test can change the environment. */
export function __resetClientsForTests(): void {
  webhookClient = undefined;
  workerClient = undefined;
}
