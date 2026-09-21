# Matrix real turns: ancestor vs Dala AI, measured from live traffic

**2026-09-21.** Built from `message_echoes`, subscribed on Matrix's Page by the founder
this afternoon. Re-runnable: `scripts/mirror/side-by-side.sql`.

This answers the founder's item 3 ("test on real traffic in shadow — compare side by side
on real turns, not the harness") and item 4 ("production speed must beat the ancestor on
real turns"). **It does not yet clear item 4's bar**, and the reason is sample size, not
the numbers.

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
- **`generate` must not move: THE CLAUSE FAILED, and the failure is instructive.** It moved,
  6,011ms → 2,606ms. Pinning a region cannot speed up a call to Anthropic — if anything
  `sin1` is *further* from it than `iad1`. Per output character the three samples read
  **34.2, 36.2 and 57.7 ms/char** (176, 72 and 72 characters): the before/after pair at
  34.2 and 36.2 is flat. **`generate` scales with reply length and I compared a long reply
  to a short one.** The clause was written as though `generate` were a constant; it never
  was, so it could not have tested what it claimed to. The right form is *generate must not
  move per output token*, and by that form it did not.

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
- Closing it needs the ten database round trips batched, worth up to ~1.7s, which would
  put the two within noise.
- The rest is the Meta hop and the QStash hop, which both bots pay.

The corpus fills by itself now. Re-run `scripts/mirror/side-by-side.sql`.
