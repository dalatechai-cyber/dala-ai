# Demo facts, daily limit, Egune: 2026-09-25 evening

1. **Why #004 invented things: the prompt told it to.** It asked for "testimonials with named local businesses", gave «Цэцэг, Эрдэнэт Импэкс» as its own example, and asked for staff names. Rewritten: facts come only from the lead (their notes included), everything else is marked `data-sample`, and there are no names, no real companies, generic marked testimonials, social links only if given, hours instead of «Одоо нээлттэй», and the current year.
2. **Code backstop (`lib/factsCheck.js`, runs on every page before deploy):** it corrects the footer year, strips social links the lead didn't give and any «Одоо нээлттэй», adds a visible «Жишээ» chip to every sample plus one explanatory line at the top, and logs an audit line per page. The line's wording is mine; change it if you like: «"Жишээ" гэж тэмдэглэсэн мэдээллийг таны бодит мэдээллээр солино.»
3. **Test lead #005, name + café + phone only ($1.49, 11 min):** [v1](https://test-claude-v1-345yh-k4q6ccs2g-bilguuns-projects-a8563d8e.vercel.app) · [v2](https://test-claude-v2-38epn-9zrx07v0t-bilguuns-projects-a8563d8e.vercel.app) · [v3](https://test-claude-v3-3dhcr-mrnc8jfrx-bilguuns-projects-a8563d8e.vercel.app). I read all three.
   - No names and no brands in any design. The menus, prices, story, numbers and opening hours carry 24/25/35 «Жишээ» marks.
   - Testimonials are generic and marked, the footer says © 2026, there are no social links, and each shows a schedule rather than «Одоо нээлттэй». The backstop had nothing to fix.
   - Still unmarked: generic lines such as «Кофе, цай, амттан», «гэрийн амттай бялуу» and «Ширээ захиалах».
4. **Daily limit is now 10.** The 11th lead is thanked, saved, held and sent to Telegram with its `RELEASE` command, and a test covers it. The live log shows the limits in force: 3 per visitor, 10 per day.
5. **Also confirmed on #005:** the lead email went to 2 recipients, and the demo email is due at 14:00 tomorrow, 23h06m after the request, inside the promise.
6. **Egune: the first run measured nothing.** The key serves only `egune-nano`; `egune1-14b` returned HTTP 503 on every call. I re-ran the Egune arm with `egune-nano` on the same prompt, gate and guards.
7. **Egune verdict: it cannot replace Sonnet 5 for Дали, for all replies or for some.**
   - The automatic metrics tie: 29/50 replies served as written each, 6/6 permanent cases each.
   - Reading the replies does not tie. Egune served random or irrelevant prices, answered «hayag» with no address, gave a staff listing to a nail question, and lost the children's rule.
   - It was also worse on Latin-typed messages (9/20 served as written against 11/20).
   - It is 4–5× faster (0.7 s against 3.2 s median), but its price is unpublished. Even free it would save at most ~₮19–27k a month at Tara's traffic. Details: [`2026-09-25-egune-vs-sonnet.md`](2026-09-25-egune-vs-sonnet.md).
8. **Live bug found and fixed along the way:** «CICA хими байгаа юу?» was being answered with «Хуримын засалт: 154,000₮–198,000₮» (wedding styling). The facts guard read two prices on one line as a range. Fixed with a regression test in [#177](https://github.com/dalatechai-cyber/dala-ai/pull/177).
