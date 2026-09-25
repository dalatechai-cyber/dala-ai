-- DalaTech (tenant #0) matching fixes from the founder's read of the test set, 2026-09-26.
-- Matching data only: no reply wording changes. Both rows are read per request, so this is
-- live on commit.
--
--  B4 (p03, p04): a GENERAL price question gets the approved price list, not a clarifying
--     question. price_overview moves from `whole_message` to `covers_message`: it fires when
--     every word of the message is a price word (the anchors, matched as word prefixes) or
--     harmless filler (the cover words). «Сайн байна уу, үнэ ямар байдаг вэ?» and
--     «tanaih yamar unetei ve» fire; «Дали сард хэд вэ?», «Вира хэд вэ?», the bundle, FAQ 5's
--     «Сарын төлбөрт юу юу багтдаг вэ?» and «Тусгай үнийн санал…» do not — a question about
--     one product is still the model's, from the price list. Every phrase the old row matched
--     is still matched. Anchors shorter than four letters («үнэ», «une») match as WHOLE words
--     only, so «Үнэн үү?» / «unen uu» (is it true?) and «Үнэгүй юу?» do not fire.
--
--     ORDER: apply this only AFTER the code of the same PR is deployed. The code before it
--     skips a covers_message row with a stem under four letters, so applied early, the price
--     row goes silent (measured 2026-09-26 on DalaTech and reverted within minutes).
--  i04: «chi robot uu hun uu» gets the approved "who are you" answer (assistant_who), which
--     says what the bot is and never mentions internal instructions.
begin;

update deterministic_replies
   set match_mode = 'covers_message',
       stems = array['үнэ', 'үний', 'үнэт', 'төлбөр', 'une', 'unet', 'unii', 'tulbur', 'price', 'cost', 'much'],
       cover_words = array[
         'сайн', 'байна', 'уу', 'sain', 'sn', 'bna', 'baina', 'bnu', 'bnuu', 'uu', 'hi', 'hello',
         'ямар', 'yamar', 'байдаг', 'baidag', 'bdg', 'вэ', 'бэ', 've', 'we', 'be',
         'хэд', 'хэдэн', 'hed', 'heden', 'төгрөг', 'tugrug', 'танайх', 'танай', 'tanaih', 'tanai',
         'нь', 'ni', 'хэр', 'her', 'мэдээлэл', 'medeelel', 'авъя', 'avya', 'өгөөч', 'uguuch',
         'мэдмээр', 'medmeer', 'асууя', 'asuuya', 'юм', 'yum', 'ер', 'er', 'ерөнхий', 'бүгд', 'bugd',
         'санал', 'how', 'is', 'the', 'what', 'are', 'your']
 where tenant_id = (select id from tenants where slug = 'dalatech') and intent = 'price_overview';

update deterministic_replies
   set stems = stems || array[
     'chi robot uu hun uu', 'robot uu hun uu', 'chi robot uu', 'ta robot uu', 'robot uu', 'bot uu',
     'chi bot uu', 'chi hun uu', 'ta hun uu', 'hun uu', 'chi ai uu', 'ai uu',
     'чи робот уу', 'та робот уу', 'робот уу', 'чи хүн үү', 'та хүн үү', 'хүн үү',
     'чи робот уу хүн үү', 'хүн үү робот уу', 'робот уу хүн үү']
 where tenant_id = (select id from tenants where slug = 'dalatech') and intent = 'assistant_who'
   and not ('chi robot uu hun uu' = any(stems));

commit;
