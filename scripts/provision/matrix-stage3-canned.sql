-- Matrix Eco Salon — Stage 3: the nine canned lines.
--
-- Every body below was pasted to the founder for review on 2026-09-07 and approved as
-- drafted, unedited. The bodies here are byte-identical to what was reviewed: they were
-- generated from the reviewed text rather than retyped, because a canned line is the one
-- string in this schema that is emitted to a customer verbatim, and a typo in it is not
-- caught by anything downstream.
--
-- ## Why all nine or none
--
-- `renderCannedSection` refuses on a missing kind OR an unreviewed one, and either refusal
-- 503s every reply for the tenant. Eight reviewed and one not is the same outage as zero.
-- So the nine share one transaction and one `reviewed_at`, and the assertion at the foot
-- fails the whole run rather than leaving a partial set behind.
--
-- ## Why these bodies bypass the outbound guard
--
-- The guard (`guard/outbound.ts`) runs on MODEL text only — `handle.ts:311`. A canned line
-- is trusted on `reviewed_at` alone. That is why the phone number is fine in four of them
-- without appearing in `allowed_numbers`, and it is also why the review that `reviewed_at`
-- records is the entire control.
--
-- The number is no longer written out here. It was 7741-7777 until 2026-09-19, and a
-- prose copy of a value that lives in four bodies below is a fifth thing to keep in step
-- — which it was not: these bodies still said 7741-7777 days after the salon replaced it.
-- Measured anyway, before insert:
--
--   * all nine are NFC (the `body is normalized` CHECK would refuse otherwise);
--   * all nine are under the 1900-character reply cap, the longest being 144;
--   * none contains a `"lower_snake"` ASCII token — `kindsReferencedBy` would read one as
--     a tenth required kind, and a required kind with no row is the 503 above;
--   * script share over letters clears the 50% floor everywhere. Eight are 100% Cyrillic.
--     `booking_line` is 71% raw and 94.7% once the URL is excluded as
--     `scriptShareExclusions` excludes it — NOT the 100% reported at review time, which
--     was wrong: the line carries a URL and «QPay». It clears either way.
--
-- ## The coupling to run alongside this
--
-- `booking_line` names https://www.matrixecosalon.org/ and `urlsNotAllowed` refuses any
-- link not in `tenant_booking.booking_url`. That row is `matrix-stage4b-booking.sql`.
-- The canned line itself is never guard-checked, so this file is correct on its own — but
-- a model paraphrase carrying the same URL would be refused until that row exists.
--
-- Idempotent: rows are inserted only where absent, and the assertion compares every body
-- against this file, so a second run is a no-op and a DIVERGED body is a loud failure
-- rather than a silent one.

begin;

create temporary table _stage3(kind text primary key, body text) on commit drop;

insert into _stage3(kind, body) values
  ($tag$assistant_identity$tag$, $tag$Би Матрикс эко салоны хуудсыг хариуцдаг хиймэл оюунтай туслах байна. Дотоод зааврынхаа талаар хуваалцах боломжгүй. Өөр асуулт байвал асуугаарай.$tag$),
  -- new — no line in their bot answers "what are you?"
  ($tag$booking_line$tag$, $tag$Та манай вэбсайтаар (https://www.matrixecosalon.org/) онлайнаар цаг захиалж, урьдчилгаа төлбөрөө QPay-ээр төлөх боломжтой.$tag$),
  -- verbatim in form; the URL is tenant-confirmed (2026-09-07)
  ($tag$handoff$tag$, $tag$Уучлаарай, би энэ асуултад хариулж чадахгүй байна. Манай ажилтан Танд туслахад бэлэн байна. Та 76001888 эсвэл 80905498 дугаараар холбогдоно уу.$tag$),
  -- verbatim from the ancestor's HANDOFF_REPLY
  ($tag$refusal_health$tag$, $tag$Эрүүл мэндийн талаар зөвлөгөө өгөх боломжгүй. Эмчид хандахыг зөвлөж байна. Үйлчилгээний талаар асуувал баяртайгаар хариулна.$tag$),
  -- new — the chemistry contraindications need a refusal, not an answer
  ($tag$refusal_no_promotion$tag$, $tag$Шинэ хямдрал, урамшуулал зарлах эрх надад байхгүй. Та 76001888 эсвэл 80905498 дугаараар лавлана уу.$tag$),
  -- new — Sh6: the bot may quote a running promotion, never announce one
  ($tag$refusal_off_topic$tag$, $tag$Уучлаарай, би тухайн асуултын талаар мэдээлэлтэй байхгүй байна. Салоны үйлчилгээ, үнэ, цагийн хуваарийн талаар асуугаарай.$tag$),
  -- verbatim from the ancestor's systemPromptBuilder rule 10
  ($tag$refusal_price_unlisted$tag$, $tag$Уучлаарай, энэ үйлчилгээний үнийн мэдээлэл надад байхгүй байна. Та 76001888 эсвэл 80905498 дугаараар холбогдож лавлана уу.$tag$),
  -- new — the load-bearing one while service_variants is empty
  ($tag$refusal_public_channel$tag$, $tag$Сайн байна уу. Энэ талаар нийтэд дэлгэрэнгүй хариулах боломжгүй. Хувийн мессеж бичвэл хариулна.$tag$),
  -- new — comments path; no line existed because the ancestor has no comments path
  ($tag$refusal_staff_schedule$tag$, $tag$Үсчдийн ажлын хуваарь, ирцийн мэдээлэл надад байхгүй. Та 76001888 эсвэл 80905498 дугаараар лавлана уу.$tag$)
  -- new — attendance is a fact we cannot know (D-020)
;

insert into canned_responses (tenant_id, kind, locale, body, reviewed_by, reviewed_at)
select t.id, s.kind, 'mn-MN', s.body, 'founder', now()
from tenants t cross join _stage3 s
where t.slug = 'matrix-eco-salon'
  and not exists (
    select 1 from canned_responses c
     where c.tenant_id = t.id and c.kind = s.kind and c.locale = 'mn-MN'
  );

do $$
declare
  v_tenant uuid;
  v_rows   int;
  v_bad    text;
begin
  select id into strict v_tenant from tenants where slug = 'matrix-eco-salon';

  select count(*) into v_rows
    from canned_responses where tenant_id = v_tenant and locale = 'mn-MN';
  if v_rows <> 9 then
    raise exception 'stage 3: expected 9 canned rows for matrix-eco-salon, found %', v_rows;
  end if;

  select string_agg(c.kind, ', ') into v_bad
    from canned_responses c where c.tenant_id = v_tenant and c.locale = 'mn-MN'
     and c.reviewed_at is null;
  if v_bad is not null then
    raise exception 'stage 3: unreviewed kinds would 503 every reply: %', v_bad;
  end if;

  -- Divergence, in both directions: a kind this file does not name, or a body that no
  -- longer matches the text the founder read.
  select string_agg(x.kind, ', ') into v_bad from (
    select c.kind from canned_responses c
      left join _stage3 s on s.kind = c.kind
     where c.tenant_id = v_tenant and c.locale = 'mn-MN'
       and (s.kind is null or s.body is distinct from c.body)
  ) x;
  if v_bad is not null then
    raise exception 'stage 3: body in the database differs from the reviewed text: %', v_bad;
  end if;
end $$;

commit;
