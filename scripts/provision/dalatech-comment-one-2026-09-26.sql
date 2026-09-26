-- DalaTech's «comment 1» call to action (D-144, founder 2026-09-26). Tenant #0 ONLY.
--
-- RUN ONLY AFTER the D-144 code is live in production. The two kinds must already be in
-- MODEL_INVISIBLE_KINDS on the deployment serving DMs; a row of an unknown kind inserted
-- before that moves canned_hash on one side and refuses every DalaTech DM (canned_stale).
--
-- The two sentences are the founder's, approved exactly (2026-09-26). The rule's matcher is
-- the one in scripts/provision/templates/comment_rule.cta_one.json; ctaOne.test.ts fails if
-- this file and that one disagree.
--
-- Idempotent: re-running changes nothing.

begin;

insert into canned_responses (tenant_id, kind, locale, body, reviewed_by, reviewed_at)
select t.id, v.kind, 'mn-MN', v.body, 'founder', now()
  from tenants t, (values
    ('comment_cta_public_reply', $l$Сайн байна уу! Дэлгэрэнгүй мэдээллийг чатаар илгээлээ 😊$l$),
    ('comment_cta_private_reply', $l$Сайн байна уу! Би DalaTech-ийн AI туслах Дали байна. Энэ чатаар надаас хүссэн зүйлээ асуугаарай — үнэ, үйлчилгээ, үнэгүй демо, бүгдийг тайлбарлая.$l$)
  ) as v(kind, body)
 where t.slug = 'dalatech'
on conflict (tenant_id, kind, locale) do nothing;

insert into comment_rules (tenant_id, rule_key, verdict, matcher, enabled, provenance, public_kind, private_kind)
select t.id, 'cta_one', 'reply',
       $m${"mode": "whole_message", "phrases": ["1", "1️⃣", "1⃣", "１"]}$m$::jsonb,
       true, 'tenant_confirmed', 'comment_cta_public_reply', 'comment_cta_private_reply'
  from tenants t
 where t.slug = 'dalatech'
on conflict (tenant_id, rule_key) do nothing;

-- What is now live: the rule, and both lines reviewed.
select r.rule_key, r.enabled, r.public_kind, r.private_kind,
       (select count(*) from canned_responses c
         where c.tenant_id = r.tenant_id and c.kind in (r.public_kind, r.private_kind) and c.reviewed_at is not null) as reviewed_lines
  from comment_rules r join tenants t on t.id = r.tenant_id
 where t.slug = 'dalatech' and r.rule_key = 'cta_one';

commit;
