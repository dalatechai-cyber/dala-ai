# Tara Salon — Парк Од (slug `tara-park-od`, not onboarded)

A branch of Tara Salon and its own tenant (D-157). **Not onboarded yet; nothing here is in the
database.** These are the facts confirmed so far, for the day she is onboarded from her own
filled questionnaire (`docs/standards/dali.md` §7).

| Fact | Value | Source |
|---|---|---|
| Facebook Page (where Дали will answer) | https://www.facebook.com/profile.php?id=100067391025472 | Founder, 2026-10-01: «her own confirmed Page» |
| Phone | 76001888, the shared main line of both branches; no line of her own given | Price list of 2026-10-01 |
| Prices | Identical to Яармаг's (D-157); the 2026-10-01 list is in `scripts/provision/tara-price-list-2026-10-01.sql` | Price list of 2026-10-01 |
| Children's services | Served, as at Яармаг (no children's refusal) | Founder, 2026-10-01 |

**Page id.** `--facebook-page-id` takes the Page's id. The number in the link above is the id
Facebook shows for the profile; it is expected to be the Page id, but this repository cannot check
it (`developers.facebook.com` is blocked here). Confirm it from the Page's own settings (or a
Graph `GET /{id}?fields=id,name` with a token for that Page) before onboarding.

**Phones.** 76001888 is in `config/branch-groups.json` `allow_phones`, so the branch gate lets
both branches hold and say it. Any other number Парк Од is given stays hers alone, and Яармаг's
91005498 stays Яармаг's: the gate refuses it in Парк Од's rows.

Onboarding command (the founder's, when her form is filled):

    node scripts/onboard/tenant.ts --form <Парк Од form> --slug tara-park-od \
      --facebook-page-id <confirmed Page id> --display-name "Tara Salon — Парк Од"
