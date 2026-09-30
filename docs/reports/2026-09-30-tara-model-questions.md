# Tara Яармаг: what customers ask that still reaches the paid model (2026-09-30)

This is a read-only analysis. It was written from `messages`, `outbound_messages`,
`deterministic_replies`, `faqs`, `canned_responses`, `contact_points`, `spellings`,
`out_of_scope_topics` and the live prefix (`config_snapshots.prompt_stable` for
`tenants.live_revision_id`, channel `facebook_page`, compiled 2026-09-27 12:15 Ulaanbaatar) on project
`tlggenaatnopnxzbkbuf`.

- Nothing was written to the database, nothing was published and no model was called.
- The drafts are in `prompt/drafts/tara_fixed_replies.mn.txt`. Nothing loads that file.

## The data

**Scope.** Inbound messages for `matrix-eco-salon` with `answered_by = 'model'`, from 2026-09-14.
There are 176 of them in 65 conversations, and no body has been redacted.

**Shadow and live.**
- Shadow: before the cutover at 2026-09-25 05:54 Ulaanbaatar (21:54 UTC on 09-24). All times
  below are Ulaanbaatar time, with UTC in brackets where it helps. The customers were real, because the Page was mirrored, but
  the ancestor bot answered them. Dala's replies were not sent.
- Live: from the cutover onwards. That is about 5.5 days of traffic.

**Test conversations removed: 39 messages in 2 conversations.** `contacts` holds no display
names for these conversations, and no contact is linked to a tenant #0 person. That means
identity could not be checked. Both were identified from their content and timing only:
- **One conversation on 09-21 (31 messages).** The same scripted list of eleven questions was
  sent twice, at 11:04–11:16 and again at 00:08–00:12 the next night (03:04 and 16:08 UTC),
  a minute apart each time. The list
  covers dye, сор, CICA, dry hair, location, manicure, master stylist and shampoo, and it
  includes the FAQ's own wording. The conversation also contains «ci henbe».
- **The go-live conversation of 09-25 (8 messages, 05:25–05:58; 21:25–21:58 UTC on 09-24).** This conversation spans
  the cutover. `docs/reports/2026-09-25-overnight.md` records the founder's own test turns
  there, in one conversation. It includes «tnah matrix salonu» and «cmg hen hiisen be».

A founder test that looks like a real customer would not have been caught.

**What was left.** 137 customer messages remain: 116 from shadow and 21 from live. Live is
about 3.8 model questions a day.

**Cost.** Costs use ₮117 per model call, the live average. Shadow calls were priced
differently, so shadow ₮ figures are "what it would cost now".

**Replay.** Every message was replayed, read-only, through the repo's own `matchDeterministic`,
once against Tara's current fixed rows and once against the proposed ones. The replay covers
the rows only. It does not apply respelling (her 29 `spellings` rows) or gate topics, so the
counts of what the rows absorb are a lower bound.

## The clusters

Counts are messages. "Now fixed" means Tara's current rows would already answer the message,
without the model; most of those rows were added after shadow. No examples are given for
clusters that have none worth showing.

| Cluster | All | Live | Now fixed | ≈ ₮ (all × 117) | Fixed-reply candidate? |
|---|---|---|---|---|---|
| Price of a named service (dye, cut, perm, "for this length") | 34 | 2 | 6 | 3,978 | **No.** The price is served from the rows (D-075), and `dye_prices` / `perm_types` already cover the plain forms. One live miss is a stem gap (§6 of the drafts). |
| Greeting on its own | 19 | 1 | 18 | 2,223 | **Already done.** The `greeting` row absorbs 18. The one live miss («Sainu») is a one-stem addition. |
| Suitability or colour advice, mostly with a photo (grey toner over green, black to lighter without bleach, "will this colour take on my dark hair") | 16 | 1 | 1 | 1,872 | **No.** It needs judgement and a stylist. Gate topics `suitability_*` and `photo_consultation` exist for it. |
| **Address or location** («хаяг», «where are you», «send the exact address», «where did you move») | **12** | **5** | 0 | 1,404 | **Yes: the top live cluster.** The answer is two rows (`contact_points` address and `maps_url`). Draft 1. |
| Service facts (what afro perm is, how long a perm takes, treatment courses, men's cuts, "must I book to come") | 10 | 1 | 0 | 1,170 | **No.** Each question is different, and several need KB judgement. |
| Free slot on a date («today?», «on the 3rd?», «earliest with a named stylist») | 6 | 1 | 0 | 702 | **No.** The honest answer is "I can't see the calendar", which the model must phrase around the date. |
| Noise (one letter, «hu», «bnu») | 6 | 2 | 0 | 702 | **No.** There is nothing safe to match. |
| **Booking intent, plain** («Цаг авах», «Цаг авдаг уу», «Tsag awhuu») | **5** | 1 | 0 | 585 | **Yes.** The body is the reviewed `booking_line`, byte for byte, and the platform adds the deposits. Draft 2. The live one («…10с цаг нвья») has a typo and a time, so it stays with the model. |
| Complaints (phone not answered for two days, "you don't understand perms", sign taken down, "payment done") | 5 | 1 | 0 | 585 | **No.** These need a person. |
| Branches (other branches, «Хүннү салбар», "interested in Яармаг") | 5 | 0 | 0 | 585 | **No, for now.** Парк Од is arriving as its own tenant (D-157), so "one branch" will stop being true. `branch_clarify` is pending. |
| **Generic price request** («үнийн мэдээлэл», «vniin medeelel awii», «Vne») | **4** | 0 | 0 | 468 | **Yes, carefully.** The reply is a question back, using a live row's own sentence. It should fire only on a first message. Draft 5. |
| Staff (is a named stylist in today, a stylist's own phone, training course) | 4 | 1 | 0 | 468 | **No.** This is a person or a staff-schedule refusal. Gate territory, not a fixed reply. |
| **Acknowledgement** («Ok», «Аан за», «за тиймэ») | 3 | **2** | 0 | 351 | **Yes.** It is 2 of 21 live model calls, and the model already answers with nearly the `thanks` row's second sentence. Draft 3. |
| Opening hours («what time do you open», «Tsagiin huwaari», «open tomorrow?») | 3 | 2 | 1 | 351 | **Not drafted.** «Tomorrow» is now the `tomorrow_hours` row. The week's hours have no slot, so a row would need the hours typed, a copy nothing checks. Adding a `{week.hours}` slot is a code change, and a founder call. |
| Vague "information" («Мэдээлэл», «Medeelel awii») | 2 | 0 | 0 | 234 | **No.** It is too open, and the model's clarifying question is right. |
| **Salon phone** («contact phone?», «give me the Яармаг branch's phone») | **2** | 1 | 0 | 234 | **Yes, small.** The numbers and sentence are already in the reviewed `handoff` row. Draft 4. |
| Thanks | 1 | 0 | 1 | 117 | Already done (`thanks`). |

**Totals.** 137 messages (₮16,029 at the live rate), of which 21 are live (₮2,457). The
current rows already absorb 27 of the 137, which leaves **110 still reaching the model today.**

## What the drafts would absorb (replayed)

| Draft | Absorbs (all / live) | Est. saving per month at live traffic | Collision and risk notes |
|---|---|---|---|
| 1 `address` | 10 / 5 | 5 live in 5.5 days ≈ 27 a month ≈ **₮3,200** | No overlap with any current row. It fires on a bare «Хаана вэ?», because «хаана» is a stem (see the draft's question). It does not fire on «Facebook хаяг…», «имэйл хаяг…», «Оюунаа хаана ажилладаг вэ» or «Хаана байрладаг вэ, үнэ хэд вэ». The disabled `tara_rebrand` row lists хаяг/haana stems as an `append`: if it were re-enabled, it would add its line after this one. The address and link are a typed second copy of `contact_points`, which the facts gate does not check. |
| 2 `booking` | 4 / 0 | No live hit yet. Shadow rate scaled to live traffic ≈ 4 a month ≈ **₮470** | It does not fire on «Өнөөдөр цаг байна уу», «Хэдэн цаг авах вэ», «Би цаг захиалсан», «Утсаа авахгүй байна», «Tsagiin huwaari» or «margaash tsag awah». The deposit rows come from `withDeposits`. That was read in the code, not run. |
| 3 `acknowledgement` | 2 / 2 | ≈ 11 a month ≈ **₮1,300** | `whole_message`, so it has no stem-floor risk. «тийм» and «за тэгье» are excluded, because they answer a question. Its risk is a «за» that answers the bot's own question. |
| 4 `salon_phone` | 2 / 1 | ≈ 5 a month ≈ **₮600** (n = 1) | It does not fire on a stylist's number, on «Утсаа авахгүй байна» (the phone complaint) or on «Парк Од салбарын утас». |
| 5 `price_which_service` | 4 / 0 | ≈ 4 a month at most ≈ **₮470**, less with the first-message-only setting | It is disjoint from `dye_prices` and `perm_types`: any service word makes it silent, and «үнэн үү» does not match because short stems match only as whole words. |
| 6 stem additions (`greeting`, `dye_prices`) | 2 / 2 | ≈ 11 a month ≈ **₮1,300** | Neither addition fires on any other message in the set. |

- **Together:** 24 of the 137 messages, and 10 of the 21 live ones. That is about **₮7,300 a
  month** (about $2.10) at current live traffic, against the October projection of about
  ₮24,300 in `2026-09-30-tara-spend.md`.
- **Treat that as a range, not a forecast.** The live sample is 21 messages in 5.5 days.
- **The saving may be higher.** A fixed reply that is the whole conversation (for example a
  lone address question) also avoids that conversation's cold cache write (about ₮230), not
  just the ₮117 average.
- **Negatives:** 24 adversarial messages were checked. The only one that fires a draft is
  «Хаана вэ?» (draft 1), which is named above.
- **No overlap between drafts and current rows:** no message fired both a proposed row and a
  current one.

## Things found on the way, not acted on

- **Shadow replies used stale data.** The shadow-era replies quote an old phone number
  (7741-7777), "six branches" and an older map link. The live replies from 09-25 use the
  current rows. This is recorded only so nobody reads the shadow replies as current behaviour.
- **A shadow reply exposed the model's reasoning.** On 09-16, the reply to «Цаг авдаг уу»
  began by reasoning in the open about whether `refusal_public_channel` applied. It was a
  shadow reply, so it was not sent.
- **A real customer turned back at the door (09-28).** They wrote that the sign outside had been
  taken down, so they left. That is for the salon, not the bot.
- **Two paid-deposit or complaint messages needed a person.** One was «Tulbur amjilttai»
  (payment done). The other was a customer who had been calling for two days with no answer.
  Both are shadow-era and got a model reply.

## Not verified

- **Respelling and gate topics were not in the replay.** Real matching also applies Tara's
  29 respellings and the gate's topic refusals. The replay did neither, so a few messages
  counted as "still model" may already be absorbed another way.
- **URL guard.** It was not run to confirm the maps link in draft 1 passes the outbound URL
  check. `contact_points` URLs are on the allow-list by code (`linkValues`).
- **Deposits on draft 2.** `withDeposits` adding the deposit rows to a fixed reply was
  confirmed by reading `handle.ts`, not by running it.
- **The ₮117 figure.** It is the brief's live average, not recomputed per call here.
