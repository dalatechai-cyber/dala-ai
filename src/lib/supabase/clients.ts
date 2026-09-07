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
let privacyClient: SupabaseClient | undefined;

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

/**
 * For the public privacy surface: Meta's data-deletion callback and the status page it
 * hands people.
 *
 * Its own key rather than the webhook's, because this is the one surface that is
 * unauthenticated by design AND writes a row — anybody on the internet can make it insert.
 * A leak there must be revocable without taking Messenger down, which is the entire
 * argument for one key per surface.
 */
export function supabasePrivacy(): SupabaseClient {
  privacyClient ??= serviceClient(required('SUPABASE_SECRET_PRIVACY'));
  return privacyClient;
}

/**
 * For `scripts/publish/tenant.ts`, the operator command that compiles and publishes a
 * tenant's configuration.
 *
 * **No deployed surface uses this key and none should.** Publishing is an operator action
 * an owner takes from their own shell, not something a request can trigger — so the key is
 * exported for one command and is absent from the Vercel environment entirely. It is listed
 * in `.env.example` because the guard requires every name `src/` reads to be documented,
 * and it is deliberately NOT in `scripts/preflight.ts`'s required set: a deploy must not
 * fail for the want of a key no deployed code path reads.
 *
 * It is its own name rather than a reuse of the worker's for the reason at the top of this
 * file — a leaked key is every tenant's data, and the only thing bounding the blast radius
 * is being able to revoke exactly the surface that leaked. "The laptop I ran a publish from"
 * is a different surface from "the queue worker".
 */
export function supabasePublish(): SupabaseClient {
  // Not memoised: the command runs once and exits, and a module-scope client here would
  // outlive nothing. The others are memoised because a warm lambda reuses them.
  return serviceClient(required('SUPABASE_SECRET_PUBLISH'));
}

/** Test seam: drop memoised clients so a test can change the environment. */
export function __resetClientsForTests(): void {
  webhookClient = undefined;
  workerClient = undefined;
  privacyClient = undefined;
}
