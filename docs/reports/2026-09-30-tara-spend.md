# Tara Яармаг: September model spend, before and after go-live (2026-09-30)

Read-only. Written from `spend_ledger`, `messages`, `model_prices` and `tenants` on the project,
through 2026-09-30 ~12:00 Ulaanbaatar. No paid model was run. All model calls were
`claude-sonnet-5` on the Reception surface; the ledger's rate is ₮3,500 per US dollar.

## By day (Ulaanbaatar calendar)

| Day | Model calls | Conversations | ₮ |
|---|---|---|---|
| 09-14 | 11 | 5 | 654 |
| 09-15 | 16 | 4 | 989 |
| 09-16 | 13 | 5 | 673 |
| 09-17 | 16 | 6 | 878 |
| 09-18 | 60 | 26 | 1,782 |
| 09-19 | 38 | 13 | 1,123 |
| 09-20 | 9 | 5 | 512 |
| 09-21 | 28 | 4 | 1,180 |
| 09-22 | 16 | 1 | 432 |
| 09-23 | 0 | 0 | 0 |
| 09-24 | 0 | 0 | 0 |
| 09-25 | 13 | 4 | 1,095 |
| 09-26 | 3 | 2 | 494 |
| 09-27 | 11 | 5 | 1,972 |
| 09-28 | 5 | 3 | 542 |
| 09-29 | 5 | 1 | 316 |
| 09-30 | 3 | 2 | 280 |

"Conversations" counts distinct conversations with a model call that day.

- **Shadow (09-14 to 09-22):**
  - ₮8,223 over 9 days, which is ₮914 a day.
  - 207 calls. This includes the founder's own test turns, which the ledger cannot separate.
- **09-23 and 09-24: no model call at all.**
  - 22 customer messages were stored on those two days with no answer recorded (`answered_by` empty).
  - This analysis did not investigate why. It lines up with the go-live changeover and is worth a
    separate look.
- **Live (09-25 to 09-30):**
  - ₮4,699 over 6 days, which is **₮783 a day**.
  - 40 model calls and 17 conversation-days, which is **₮276 (about $0.079) per conversation**.
  - Answers that cost nothing: 18 fixed replies (`deterministic`) and 9 approved lines (`canned`),
    against 29 model answers.
- **September total:** ₮12,922.

## Where the money goes (live days)

Cache writes are 88% of live spend: $1.18 of $1.34.

- **18 of the 40 calls started cold.** Each wrote the whole prompt prefix to the cache: 16,451
  tokens on average, at the 1-hour cache-write rate ($4.00 per million tokens), which is about
  $0.066 per cold call.
- **Input and output are small.** Model output averaged 86 tokens a call ($0.03 in total).
- **The prefix has grown.** Cold writes averaged 10,145 tokens in shadow and 16,451 live, 62% more.
  That is why the measured cost per conversation is above D-072's model (a $0.0406 cold reply).
- **The 1-hour cache is not paying for itself.** At 2–5 conversations a day most conversations
  start cold anyway, and a 1-hour write costs 2× the input rate where a 5-minute write costs 1.25×.

## October projection

These use the live rate, 6 days and 17 conversations. That is a small sample, so read the figures
as a range, not a forecast.

**Tara alone, at the current rate:** 31 × ₮783 ≈ **₮24,300** (about $6.90).
- That is 121% of the rulebook's 20,000 ₮ line.
- It is 9.7% of her 250,000 ₮ fee, well under D-004's ₮80,000 allowable spend.

**Tara with a 5-minute cache** (writes at 1.25× instead of 2×, same miss pattern):
**≈ ₮16,000–18,000.**
- It could be less of a saving if customers pause more than 5 minutes between turns.

**Tara plus «Tara Salon — Парк Од»** (a separate tenant with its own 20,000 ₮ line):
**≈ ₮48,500**, assuming the same traffic.
- No data exists for Парк Од yet. Its traffic is a guess.

**If traffic reaches the ancestor's measured level** (D-016: about 60 replies a day), spend scales
up by a large factor. More of it would then be warm cache reads, so the cost per conversation
would fall.

## Is the line or the cost per conversation wrong?

**The line does not fit the band Reception is sold against.**
- 20,000 ₮ at ₮276 per conversation buys about 72 conversations a month.
- The band is 400 a month (D-015). 400 × ₮276 ≈ ₮110,000, which is 44% of the fee and above
  D-004's ₮80,000.

**So both need attention:**
- **The line** is really a "low traffic" line. At Tara's current traffic it fires every month.
- **The cost per conversation** has drifted up with the prefix: 62% more tokens since shadow.

Changing either the line or the cache mode is money, so it is the founder's call.

## Cheap levers that keep reply quality

1. **Switch the prompt cache from 1 hour to 5 minutes for low-traffic tenants.**
   - It changes one row, `tenants.prompt_cache_mode`, and no wording.
   - It cuts cache-write cost by about 37% at today's traffic.
   - The risk is more misses inside slow conversations.
2. **Trim the prefix (`docs/prefix-trim.md`).** Every 1,000 tokens removed saves about ₮14 per cold
   conversation. The 62% growth since shadow is the place to look first.
3. **Answer more frequent questions with fixed replies.** Fixed replies and approved lines cost
   nothing. On live days 27 of 56 answers were already free. Every question moved there costs
   ₮0 instead of about ₮117 a call.
4. **A cheaper model for simple questions is not available as things stand.** D-009 forbids Haiku
   for customer-facing Mongolian prose. The rule-compliant form of this lever is item 3. Reversing
   D-009 would be a quality decision, and it is yours.
