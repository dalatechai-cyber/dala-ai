# Matrix real turns: ancestor vs Dala AI, measured from live traffic

**2026-09-21.** Built from `message_echoes`, subscribed on Matrix's Page by the founder
this afternoon. Re-runnable: `scripts/mirror/side-by-side.sql`.

This answers the founder's item 3 ("test on real traffic in shadow — compare side by side
on real turns, not the harness") and item 4 ("production speed must beat the ancestor on
real turns").

> **§1 below is superseded by §5, added 16:30 UTC.** It was written when the corpus was a
> single turn and says so. The founder then sent a 16-message test session and §5 is the
> full side-by-side. The one-turn section is kept because its *method* notes — both clocks
> from the customer's own Meta timestamp, and the two pairing defects found while building
> it — are what make §5 trustworthy, and because deleting a superseded finding hides that
> it was ever believed.

---

## 1. The side-by-side

The corpus is **one turn**. Echoes began arriving at 14:55 UTC today, and exactly one has
landed. Everything before that shows no ancestor reply — that is an absence of
**instrument**, not of reply, and must not be read as the ancestor staying silent.

| | |
|---|---|
| **Customer** (`27412596105101390`, 14:55:15.291 UTC) | «sain bnu» |
| **Ancestor** (+**4.27s**) | «Сайн байна уу? Танд юугаар туслах вэ?» |
| **Dala AI** (+**6.85s**, `state: draft`, `answered_by: model`) | «Сайн байна уу! Танд ямар үйлчилгээний талаар мэдээлэл хэрэгтэй байна вэ?» |

Both times are from the **customer's own Meta timestamp**, not from when either bot's
database wrote a row — see §5, because getting that wrong is what the first version of
this did.

On quality this turn is a wash, and arguably ours is better: the ancestor asks an open
"how can I help", Dala asks which service — one step further into the funnel. Neither
invents anything. **Dala is 2.58s slower.**

---

## 2. Where Dala's 6.85s goes

From `reply_timing_ms` on event 327 (twelve phases, summed):

| Segment | ms | Ours to fix? |
|---|---|---|
| Meta's timestamp → our webhook receipt | 1,630 | No — the ancestor pays this too |
| webhook → worker start (QStash) | ~950 | No — the ancestor also uses QStash |
| worker: ten database phases | **1,667** | **Yes** |
| worker: the model call | **2,606** | Partly |
| **total** | **6,853** | |

The ancestor's *entire* reply fits in 4.27s. Our database phases plus our model call alone
are 4.27s, before either hop. So the gap is not one slow thing; it is that we do ten
round trips (`context_load` 533ms, `guard` 371ms, `persist_inbound` 247ms, `event_read`
169ms …) where a single-tenant bot with a module-scope prompt cache does almost none.

**That is a structural cost of multi-tenancy, not a defect** — the config is a row, so it
must be read. The lever is fewer round trips (batching `context_load` and `guard`), not a
faster database.

---

## 3. The `sin1` prediction: mostly right, and its falsifiable clause failed

`vercel.json` pinned the functions to `sin1` (Singapore) beside Supabase's
`ap-southeast-1`; before that they ran in `iad1` (Virginia), one ocean away from every
query. The prediction on record was: **database phases → ~0.5–1s, total → ~7s, and
`generate` must not move.**

| | before (`iad1`, event 320) | after (`sin1`, event 327) |
|---|---|---|
| ten database phases | 13,507 ms | **1,667 ms** |
| the model call | 6,011 ms | 2,606 ms |
| worker total | 19,518 ms | **4,273 ms** |

End to end across every turn today: pre-`sin1` **23.9 / 28.9 / 34.2 / 36.0 / 39.1 / 40.3 /
41.5 / 42.8 / 50.7 / 55.0 / 57.9 / 141.0 s**; post-`sin1` **9.24 s** and **6.85 s**.

Scored honestly:

- **Database phases: right in direction, wrong in size.** 13.5s → 1.67s is an 8.1×
  reduction, but the prediction said 0.5–1s and the measurement is 1.7–2.1s. Too
  optimistic.
- **Total: beaten.** Predicted ~7s, measured 4.27s worker-internal / 6.85s end to end.
- **`generate` must not move: THE CLAUSE FAILED, and what it shows is that the clause was
  untestable as written.** It moved, 6,011ms → 2,606ms. Pinning a region cannot speed up a
  call to Anthropic — if anything `sin1` is *further* from it than `iad1` — so the region
  is not the cause, and the clause was treating `generate` as a constant it was never shown
  to be.

  **What it is instead is not yet measured, and the samples refuse the obvious answer.**
  Per output character the three read 34.2, 36.2 and 57.7 ms/char (176, 72 and 72
  characters). The tempting reading is "it scales with reply length, and a long reply was
  compared to a short one" — but events 326 and 327 are **both 72 characters** and took
  **4,151ms and 2,606ms**, a 1.6× spread at identical length. That single pair is wider
  than any length effect three points could establish, so **reply length is not
  demonstrated to drive `generate`, and nothing here should be optimised on the assumption
  that it does.** What can be said: the model call's own run-to-run variance dominates at
  this sample size, and the region change is not visible through it either way.

  The honest correction to the clause is that a prediction about `generate` needs a
  controlled comparison — same prompt, same output length, many samples — which one turn a
  day cannot supply. An earlier version of this report asserted the length explanation as
  fact; it is withdrawn here rather than quietly edited, because a latency strategy built
  on "shorter replies are faster" would have been built on three points and a coincidence.

The region change is therefore worth **~11.8s per reply**, all of it database, and the
model is untouched.

---

## 4. The three asks

### (1) The side-by-side — built, and thin by construction

`scripts/mirror/side-by-side.sql`. One turn today; it fills on its own as echoes arrive.
The ancestor's words live **only** in `webhook_events.raw_payload` — `meta/extract.ts`
skips echoes and the skip carries the `mid`, the customer and now the app, but never the
text. Nothing needs changing for that; the report reads the payload.

### (2) The handover detector — half can fire, half is deliberately shut, and one thing was wrong

| Half | Can it fire? |
|---|---|
| **Handover events** (`pass/take/request_thread_control`) | **Yes, now.** `tenant_channels.meta_app_id` is `1562862634970492`, so `controlAfter` returns a real verdict instead of `unknown`. But `messaging_handovers` is **not subscribed**, so none has arrived and the delivery shape is still unverified. |
| **Echoes** | **No, by design.** `record.ts` acts on echoes only when `delivery_mode = 'live'`; Matrix is `shadow`. Counted, nothing moved. |

**The thing that was wrong.** The echo half concluded `human` from "this `mid` is not one
of our sends". The first real echo carries **`app_id: 1380702870025418`** — the `dalatech`
app, which holds the ancestor's callback — against our `1562862634970492`. So on Matrix's
Page every ancestor reply is an echo that is not ours **and is not a person either.**

Today that is harmless because `shadow` gates it. **It stops being harmless at the exact
moment of cutover**: flipping to `live` while the ancestor is still answering marks every
active conversation `human`, and H11 check 4 then refuses the bot on precisely the threads
worth measuring. The symptom is a quiet afternoon — the hardest failure here to tell from
working (D-062).

Fixed: `extract.ts` carries the echo's `app_id`, and `controlFromEcho` now answers with a
`kind` — `ours` / `unreadable` / `app` / `human`. An echo Meta attributes to **any** app is
an app's; `human` is the residue, an echo nobody claims, which is what a receptionist
typing in the Page Inbox should produce. **That direction is unverified** —
`developers.facebook.com` is 403 through this environment's proxy — so it is deliberately
the conservative way round: it errs toward missing a handover, never toward muting a
tenant. `echoesFromApp` and `echoAppIds` are logged in **every** delivery mode, so the
question can be answered before cutover rather than after.

### (3) Echoes never become customer messages — verified, then guaranteed

Verified on the real event first. Event 328 (the echo) produced: **0** `messages` rows,
**0** drafts, **0** spend. The single draft in that window carries
`dedup_key = 'in:m_ycfLNVbTj24Qf…'`, which traces to event **327** — the customer's own
«sain bnu» — not to the echo.

What was missing is that this rested on one `continue` in `meta/extract.ts` with **no
end-to-end test**. `extract.test.ts` proved the *parser* drops an echo; nothing proved the
*pipeline* does, and a parser test cannot see a caller that reads `skipped` and answers it
anyway. Two tests now assert it through both entry points (`replay.test.ts`), each with a
control so it cannot pass by the harness being inert. Both were confirmed to **fail** under
a deliberate reversion before being kept.

This is the most expensive thing that can go wrong here: an answered echo is the bot
replying to its own reply, echoed back, for ever, at full price — and on Matrix's Page the
echoes are the ancestor's, so it would be two bots answering each other in a live salon's
inbox.

---

## 5. Two defects in my own measurement, both caught before reporting

Recorded because each produced a *plausible* number, and the second only looked absurd by
luck.

1. **One echo was counted as the reply to eleven turns.** Pairing each customer message
   with the nearest *later* echo attached the single echo in the table to every earlier
   message on that thread, producing ancestor reply times of **39,544s and 41,951s**. Eleven
   hours is visibly wrong; a full day of echoes would have produced plausible wrong numbers
   instead. This is D-062 exactly — a row read as present-tense evidence with nobody asking
   *when* — met while building the instrument meant to measure it. The pairing is
   echo-driven and window-bounded now.
2. **The two bots were timed on two different clocks.** `messages.at` is when *we* wrote
   the row; the echo carries *Meta's* timestamp. Measuring the ancestor from Meta's clock
   and Dala from ours silently discounted Dala by the whole webhook hop — 1.3–6.4s on
   measured traffic, **larger than the 2.58s gap being reported.** Both sides come from the
   customer's own payload timestamp now.

A third, smaller: the first query read `raw_payload->'entry'`. `raw_payload` stores **one
entry**, not the whole webhook body, so the wrong path returned zero rows — which reads
exactly like "no echoes have ever arrived", about a table with an echo in it.

---

## 6. Two things found on the way that are the founder's call

**Dala AI sent 14 real messages on Matrix's Page between 03:07 and 03:29 UTC today.** Real
`provider_message_id`s, `state = 'sent'`. `canDeliver` is a pure function of
`delivery_mode` with no third path, so the channel was `live` for those 22 minutes and is
`shadow` again now. I did not change it and no code here can. Reading the alerts either
side (`secret.undecryptable` 02:10, `outbound.token_revoked` 02:25, then successful sends
from 03:07) this looks like the founder fixing the page token and testing end to end —
which is his to do. **One thing I cannot resolve from here:** the sends went to two PSIDs.
One is his own (he identified event 327, same PSID, as his message). The other,
`28503743322612345`, received two replies at 03:27–03:28 — «Hi» and a straight-perm price
question. *Was that a second test account, or a real customer?*

**`tenant_channels.status` latches and nothing clears it.** Matrix reads
`authorization_error`, set by `halt.ts` at 02:25. The credential demonstrably works —
`tenant_secrets.last_ok_at` is 03:28:45 and 14 sends succeeded after the flag was set — but
nothing anywhere writes the status back. It does **not** gate the reply path (drafts are
being produced with the flag set), but `website/mintJob.ts` refuses on it with
`channel_inactive`. This is D-064's shape inverted: a column written in one direction only,
which reads as a live signal for as long as nobody checks. What should clear it — a
successful send, a probe run, a manual reset — is a design question, so it is flagged, not
fixed.

---

## 7. What item 4 still needs

The founder's bar is **real-turn p50 beats the ancestor**. There is one comparable turn, so
there is no p50 yet — of either bot. What can be said:

- The gap on the only measured turn is **2.58s** (6.85 vs 4.27), down from roughly 35s
  before `sin1`.
- The database phases (1.67s) are the part that is measured, repeatable and ours. The
  model call is not yet separable from its own variance, so it is not a lever anybody
  should pull on current evidence.
- The rest is the Meta hop and the QStash hop, which both bots pay.

`loadReceptionContext` and `withTenantRole` are 54% of the database time (533ms + 371ms)
and both are now split into sub-phases in `reply_timing_ms`, so the next real turn says
where inside them the time goes instead of leaving it to inference. Two candidate changes
are waiting on that reading rather than being made ahead of it: `loadLiveSnapshot` runs
sequentially before a `Promise.all` of ten queries that **do not use its result** (checked
— every one keys on `tenantId`, the locale or the local date), so the two stages are
sequential by layout and not by data; and the guard is independent of the config read, so
the two could overlap. The guard's OWN three steps stay ordered whatever happens —
identity → entitlement → budget is CLAUDE.md rule 2 and is not a performance question.

The corpus fills by itself now. Re-run `scripts/mirror/side-by-side.sql`.

---

## 5. The 16-turn session, 2026-09-21 16:07–16:22 UTC

The founder sent sixteen messages from PSID `27412596105101390` after republishing Matrix
at **seq 12** (`content_hash bf20cbeb…`, 18,122 chars, `allowed_numbers` 50 tokens). Every
one drew an ancestor reply, so all sixteen are paired.

**Both clocks are the customer's own Meta timestamp.** The ancestor's is its echo's Meta
timestamp — when Meta stamped the real outbound message. Dala's is `outbound_messages
.created_at`, when the draft row was written. Dala is in `shadow` and never sends, so its
figure **omits one `POST /{page-id}/messages` round trip**. Honest on generation,
optimistic by one send. Stated here because §1 was nearly published with the two bots on
different clocks, and the discrepancy was larger than the gap being reported.

Verdict per turn: ✗ Dala worse · ✓ Dala better · = even. **9 worse, 3 better, 4 even.**

| # | ev | Customer | Anc | Dala | | Why |
|---|---|---|---|---|---|---|
| 1 | 330 | «dugaar hedve» | 5.43 | 7.71 | = | same facts, Dala terser |
| 2 | 332 | «Үс будахад хэд вэ?» | 6.45 | 8.27 | ✗ | three prices on ONE line — style rule (4) ignored; omits `Үндэс` |
| 3 | 334 | «Сор хэд вэ?» | 3.46 | 5.37 | = | identical content |
| 4 | 336 | «CICA хими байгаа юу?» | 7.34 | 8.61 | ✗ | explains the distinction correctly, then gives no price and no next step |
| 5 | 338 | «Үс маань их хуурай, хугараад байна…» | 10.58 | 8.26 | ✗ | ancestor lists SIX treatments with prices; Dala gives only the deflection |
| 6 | 340 | «Цаг захиалмаар байна, утас хэд вэ?» | 12.93 | 7.45 | ✓ | link + numbers in one turn; ancestor asks first (D-042) |
| 7 | 342 | «Хаана байрладаг вэ?» | 5.42 | 7.40 | = | equivalent |
| 8 | 344 | «Маникюр хэд вэ?» | 9.65 | 7.31 | ✗ | drops `Дип будаг 65,000₮`, which IS in `services`; lists 4 where (4) says ask |
| 9 | 346 | «Будаг хэд вэ?» | 6.77 | 6.78 | ✗ | rule (4) executed perfectly; still omits `Үндэс` |
| 10 | 348 | «Мастер үсчинд орвол дээр юу?» | 14.03 | 6.58 | ✗ | **answers a different question** — pivots to haircuts mid-dye-conversation |
| 11 | 350 | «Шампунь зардаг уу?» | 5.47 | 6.81 | ✓ | Dala has the products URL; the ancestor gives up |
| 12 | 352 | photo + «ийм болгож болох уу» | 9.35 | 7.61 | ✓ | keeps the customer in the thread; reworded line live, no «зураг» |
| 13 | 354 | «us budalt» | 7.34 | 6.73 | ✗ | good format, omits `Үндэс` |
| 14 | 356 | «dund zergiin usend shuluun himi hedeer…» | 6.45 | 6.34 | ✗ | **correct answer destroyed by the guard — see below** |
| 15 | 358 | «tsag zahialah» | 10.14 | 6.65 | ✗ | generic handoff; Cyrillic form at #6 answered well |
| 16 | 360 | «hayag» | 6.34 | 7.51 | = | equivalent |

### Latency

| | ancestor | Dala |
|---|---|---|
| median | 7.06s | 7.36s |
| min–max | 3.46 – **14.03** | 5.37 – **8.61** |
| faster on | 8 turns | 8 turns |

**This supersedes the bake-off's "production 25.8s" row.** That figure predates the `sin1`
region pin. Dala's spread is a third of the ancestor's: it loses every short reply to fixed
overhead (Meta→webhook ~1.6s, QStash ~0.95s, ten DB phases ~1.3s) and wins every long one,
because the ancestor's time scales with output length and Dala's does not.

`reply_timing_ms` on all sixteen: `context_snapshot` 105–135ms, `context_batch` 237–375ms,
sequential, summing to the 410–571ms `context_load`. **Merging `loadLiveSnapshot` into the
ten-query `Promise.all` would save ~110ms of a ~7,000ms reply — 1.6%.** Measured and
declined; the note in `reception/load.ts` can be closed. `generate` is 2,359–5,079ms,
**55–70% of every reply**, and is the only lever that matters.

### Turn 14: three defects stacked

The model wrote **«Шулуун хими 430,000₮–510,000₮ байна.»** — the `Шулуун хими` row to the
tögrög, and what the ancestor sent. `quality_flags` holds it verbatim. The customer got the
generic handoff.

1. **The matcher classifies a price question as a suitability question.**
   `suitability_lat_himi` is `stem_sequence ["usend","himi"]` within 40 codepoints;
   "…**usend** shuluun **himi** hedeer…" fires it. «hedeer» — *for how much* — makes this
   unmistakably a price question and the matcher cannot see that.
2. **The blanket price block is justified by a gate this rule does not use.**
   `load.ts` gave every `out_of_scope_topics` row `quotePrice: false`, which empties the
   guard's allow-list. That blanket is argued in `guard/outbound.ts` from **Ш1's** rule.
   `refusal_suitability` is absent from `GATE_BY_RESPONSE_KIND` and falls to
   `DEFAULT_GATE = 'Ш8'` — *"not in the knowledge base"* — for a service that is in the
   knowledge base with a confirmed price. `0037` adds the column that lets a tenant say
   so; **its default is `false`, so it changes no behaviour until a row is flipped.**
3. **The fallback served the wrong refusal.** Matrix has a reviewed `refusal_suitability`
   row — «Уучлаарай, энэ таны үсэнд тохирох эсэхийг би шийдэж өгөх боломжгүй. Манай
   мэргэжилтэн үсийг тань харж хэлнэ…» — and the customer never saw it, because
   `handle.ts:436` serves `handoff()` regardless of what was asked. That unconditional
   fallback is already an open question in CLAUDE.md; this is its first measured instance.

### Two data gaps the ancestor has and Dala does not

Neither is a bug. Both are rows nobody has written, and both cost a turn above.

- **`Тэжээл` 44,000–88,000₮ is absent from `services` entirely** (`plain_tejeel_rows = 0`).
  The ancestor offered it at turn 5; Dala cannot.
- **No deposit data anywhere.** `tenant_booking` is `{mode: link, booking_url,
  handoff_fields: []}`. The ancestor quotes `Мастер: 20,000₮` / `1-р зэрэг: 10,000₮` at
  turn 15. Ш3 instructs the model to state the relevant deposit; Matrix has none to state.

### Two things checked and found NOT to be defects

Recorded because both looked like findings and were reported as such in a draft of this
document before they were checked against the prefix.

- **Dala's CICA claim is sourced.** «эмчилгээний хими нь ургамлын гаралтай, зөөлөн» reads
  like an invention; the live prefix carries «Эмчилгээний хими бол ургамлын гаралтай зөөлөн
  хими» at offset 13,013. It is a tenant-confirmed KB note reproduced faithfully.
- **The `20,000` in the prefix is not a deposit or a tenant constant.** It sits at offset
  3,995 inside Ш2 as a *negative* example — «БУРУУ ЖИШЭЭ … «Хөмсөг засалт ойролцоогоор
  20,000₮ орчим байх аа.» Яагаад буруу вэ: тийм мөр жагсаалтад байхгүй.» It is the block
  teaching the model not to guess prices.

### `allowed_numbers` moved, and that is worth a decision

Seq 11 → 12 took it from **13 tokens to 50**, of which 37 are prices. Every price Dala
quoted across all sixteen turns is correct against `service_variants` — checked
individually, eleven of them. But D-075's guarantee is gone: `allowed_numbers` is a SET, so
the guard asks whether a numeral is on the tenant's list and never whether it belongs to the
service being discussed. `33,000`, `500,000` and `640,000` are all on the list now, so
«Омбре 33,000₮» — D-075's own example, a 500,000–640,000 service at a haircut's price —
passes every check. Sixteen correct turns are evidence about the model, not about the guard.
