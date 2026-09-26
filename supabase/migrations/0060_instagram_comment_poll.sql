-- Instagram comments read by polling, until Meta will send them (D-146, founder 2026-09-26).
--
-- Meta delivers Instagram `comments` webhooks only to apps with ADVANCED access to
-- instagram_manage_comments. DALA_AI has Standard, so Meta's Test comment arrived
-- (webhook_events 883) and a real «1» under a @dalatech_ post never did. Until App Review, a
-- scheduled worker reads the account's recent posts and turns each NEW comment into the same
-- stored entry a webhook would have been, then queues it exactly as the webhook route does.
--
-- Two additive changes:
--
--  * `webhook_events.source` may say `poll`, so a comment the platform went and fetched is
--    distinguishable from one Meta pushed. Descriptive only; it is not in the dedup key, which
--    is why a later webhook for the same comment is a duplicate of the polled row.
--  * `tenant_channels.comment_poll_state jsonb`: the poller's own bookkeeping —
--    `since` (the watermark: nothing written before it is ever answered, set on the first
--    poll, which answers nothing), `counts` (each post's comments_count at the last read, so
--    an unchanged post costs no request), `lastRunAt`, `lastError`, `backoffUntil`.
--    NULL means never polled; the poller also clears it when the comment switch is turned
--    off, so turning it back on starts a new watermark instead of answering the gap.

alter table webhook_events drop constraint if exists webhook_events_source_check;
alter table webhook_events
  add constraint webhook_events_source_check check (source in ('meta', 'mirror', 'poll'));

alter table tenant_channels
  add column if not exists comment_poll_state jsonb;

comment on column tenant_channels.comment_poll_state is
  'D-146. Instagram comment poller bookkeeping: since (watermark; older comments are never answered), counts (comments_count per media at last read), lastRunAt, lastError, backoffUntil. NULL: not polling; the next poll sets the watermark and answers nothing.';
