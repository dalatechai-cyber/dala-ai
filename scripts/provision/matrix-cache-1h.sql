-- Matrix Eco Salon — prompt caching on, 1-hour TTL.
--
-- Its own change, applied before the budget, so the cost effect is attributable to it and
-- to nothing else.
--
-- ## Why
--
-- D-016's measured $0.0090/reply is a CACHED figure: the ancestor sets
-- `cache_control: { type: 'ephemeral', ttl: '1h' }` (`salonBrain.js:220`, CACHE_TTL='1h').
-- Matrix's `prompt_cache_mode` was `off`, so every reply would have paid full input price
-- on the whole 12,313-character prefix — roughly $0.022/reply against $0.012 cached, which
-- over a 14-day shadow at the measured ~60 replies/day is $18 rather than $10.
--
-- The two prefixes are close enough to compare directly: the ancestor's prompt is 11,321
-- characters and ours is 12,313, so 1.088x. The prompt was never the problem; the setting
-- was.
--
-- ## Why 1h rather than 5m
--
-- Matrix's measured traffic is ~60 replies/day concentrated in a ~10-hour trading day —
-- about one every ten minutes. A 5-minute TTL would expire between most consecutive
-- messages, so most requests would pay a cache WRITE rather than a read, and a write costs
-- more than the uncached read it replaces. A 1-hour TTL turns roughly five in six requests
-- into reads. It is also what the ancestor uses, which keeps the comparison honest.
--
-- ## What this does NOT do yet
--
-- Matrix is `delivery_mode = 'shadow_routing'`, which is `{deliver:false, generate:false}`:
-- no model call happens at all. So this setting changes nothing observable until the mode
-- goes to `shadow`. There is no before/after to measure on Matrix, because there is no
-- "before" traffic — the measurement is `spend_ledger.cache_read_tokens` being non-zero
-- from the first replies onward.
--
-- Idempotent, and asserts the end state.

begin;

update tenants set prompt_cache_mode = '1h'
where slug = 'matrix-eco-salon' and prompt_cache_mode <> '1h';

do $$
declare
  v_mode  text;
  v_rate  bigint;
  v_min   integer;
  v_chars integer;
begin
  select prompt_cache_mode into strict v_mode from tenants where slug = 'matrix-eco-salon';
  if v_mode <> '1h' then
    raise exception 'cache: prompt_cache_mode is %, not 1h', v_mode;
  end if;

  -- `priceCall` refuses rather than guessing when there is no price row for the model
  -- ("no price for %: refusing to guess"), and a refusal to settle means the reservation
  -- is never converted to a ledger row. So the row is asserted here rather than discovered
  -- on the first real reply.
  --
  -- The individual RATE columns are NOT NULL, so a present row cannot have a missing 1h
  -- write rate — the reachable failure is an absent row, and that is what this checks. An
  -- assertion against a state the schema forbids is decoration; this one can actually fire.
  select cache_write_1h_nanousd_per_token into v_rate
    from model_prices where model_id = 'claude-sonnet-5'
     and effective_from <= now() order by effective_from desc limit 1;
  if v_rate is null then
    raise exception 'cache: no effective price row for claude-sonnet-5 — settle would refuse to price the call';
  end if;

  -- A prefix shorter than the model's minimum cacheable length is NOT cached, and the API
  -- says so by doing nothing: no error, `cache_read_input_tokens` simply stays zero and
  -- every request pays full price. Turning caching on for a tenant whose prefix is too
  -- short is a silent no-op, which is the worst shape a setting can have.
  --
  -- The comparison is in CHARACTERS against a token minimum, and the reasoning first given
  -- for that was BACKWARDS (corrected 2026-09-07). No tokenizer emits more than one token
  -- per character, so tokens <= chars: `prompt_chars` is an UPPER bound on the token count,
  -- not a lower one. "If the characters clear the minimum, the tokens do" does not follow —
  -- 2,000 characters can be 800 tokens.
  --
  -- So this check is one-sided and worth keeping as exactly that: chars < min PROVES the
  -- prefix is too short to cache, while chars >= min proves nothing on its own. It catches
  -- the obviously-short prefix and cannot catch one near the boundary.
  --
  -- No live risk at either tenant — Mongolian Cyrillic runs about 1.47 chars/token, so
  -- 12,239 characters is roughly 8,300 tokens and 9,265 is roughly 6,300, both far above
  -- 1,024. The measurement that actually confirms caching engaged is
  -- `spend_ledger.cache_read_tokens` being non-zero on the first replies, and a sustained
  -- zero is the signal to read, not this assertion.
  select min_cacheable_tokens into v_min
    from model_prices where model_id = 'claude-sonnet-5'
     and effective_from <= now() order by effective_from desc limit 1;

  select s.prompt_chars into v_chars
    from config_snapshots s
    join tenants t on t.id = s.tenant_id
    join tenant_channels tc on tc.tenant_id = t.id and tc.provider = s.channel
   where t.slug = 'matrix-eco-salon' and s.revision_id = t.live_revision_id;

  if v_chars is null then
    raise exception 'cache: matrix has no live snapshot on its own channel — nothing to cache';
  end if;
  if v_chars < v_min then
    raise exception 'cache: the prefix is % characters against a % token minimum — caching would silently no-op', v_chars, v_min;
  end if;
end $$;

commit;
