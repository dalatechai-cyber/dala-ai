/**
 * The comment corpus the salon rule template is held to (D-122). Permanent: every entry is
 * asserted on every CI run by `salonRules.test.ts`.
 *
 * Two halves.
 *
 * `REAL_COMMENTS` is every comment Matrix's Page delivered to this platform between
 * 2026-09-20 02:17 UTC (the first `feed` delivery, `webhook_events` 203) and 2026-09-25 14:19
 * UTC — 78 comment deliveries, counted from the table on 2026-09-25. 35 were the Page's own
 * replies (skipped as `comment_self` before any rule runs, so not listed), 9 carried no text
 * (a sticker or a photo; listed with `text: ''`), and 34 carried text: all 43 are below. Text
 * copied from `webhook_events.raw_payload` exactly, ids kept so a reader can find the row. The expected
 * outcome is the founder's rule applied by hand: reply to a question or a request for
 * information, never to praise, emoji, stickers, tags, jokes or the Page itself.
 *
 * `EXAMPLES` are written for the purpose, at least thirty per kind the founder named:
 * question, praise, tag, emoji, complaint, joke, Latin-typed. They are what the corpus does
 * not contain yet — nobody has complained on Matrix's wall so far, and the tags on record are
 * all the Page's own — and they say what the rules must do the day one arrives.
 *
 * A tag is decided by Graph's `message_tags`, not by the text (the webhook carries a tag only
 * as a name, see `comments/lookup.ts`), so a tag example carries `tagsPerson: true` and its
 * expected outcome is silence WHATEVER it asks.
 */
export type Expect = 'reply' | 'silent' | 'escalate';

export type CorpusEntry = {
  text: string;
  expect: Expect;
  /** What Graph's `message_tags` said. Absent means no person was tagged. */
  tagsPerson?: boolean;
  /** `webhook_events.id`, for a real comment. */
  eventId?: number;
  note?: string;
};

export const REAL_COMMENTS: readonly CorpusEntry[] = [
  { eventId: 203, text: 'une hed ve', expect: 'reply', note: 'the founder’s test comment' },
  { eventId: 205, text: 'une hed ve', expect: 'reply', note: 'tenant #0’s Page commenting; a customer from here' },
  { eventId: 212, text: 'Яармаг хаяг хаана вэ', expect: 'reply' },
  { eventId: 219, text: 'Зэсэн улаан туяа арилдагуу', expect: 'reply', note: 'does the copper-red tint wash out — a service question with a fused particle' },
  { eventId: 407, text: 'Woow nzdaa amjilt hvsey 🥰🥰🥰💪💪', expect: 'silent' },
  { eventId: 412, text: 'Хаяг хуучиндаа юу?', expect: 'reply' },
  { eventId: 432, text: 'Хотын төвруу ойрхон ирээрэй😊 хүлээгээл байгаа шүү. Чадварлаг мундаг бүсгүй шүү чи минь😘 Hairstylist Oyunaa', expect: 'silent' },
  { eventId: 467, text: 'wow naizdaa bayar hurgue mundagdaa chin mini tomoos tom amjilt husie 👏🏻👏🏻👏🏻🫶🏻🫶🏻🫶🏻', expect: 'silent' },
  { eventId: 472, text: 'Амжилт хүсье 👍', expect: 'silent' },
  { eventId: 475, text: 'Wow', expect: 'silent' },
  { eventId: 482, text: 'Amjilt hvsie🎉🎊', expect: 'silent' },
  { eventId: 492, text: 'Amjilt nzdaa 🤗💪🏻\nHaashaa nuuj bga we', expect: 'reply', note: 'praise, then "where are you moving to?" — a location question' },
  { eventId: 493, text: 'Амжилт хүсье Оюунаа 💪💪💪.', expect: 'silent' },
  { eventId: 496, text: '❤️❤️❤️❤️', expect: 'silent' },
  { eventId: 518, text: 'Mundag egchdee bayr hurgie 🤩🫶🫶🫶', expect: 'silent' },
  { eventId: 525, text: 'Bayr hurgeyee egchmin tanidaa ulam ih amjiltiin deediig huseyee 🥰🥹', expect: 'silent' },
  { eventId: 537, text: 'Амжилт', expect: 'silent' },
  { eventId: 542, text: 'Амжилт хүсье 🎉👏🏻', expect: 'silent' },
  { eventId: 597, text: 'Amjilt 😘', expect: 'silent' },
  { eventId: 602, text: 'Амжилт хүсье', expect: 'silent' },
  { eventId: 611, text: 'АМЖИЛТ', expect: 'silent' },
  { eventId: 619, text: 'Chadvarlag mundag busguid ulam ih amjilt husey. 👏👏👏', expect: 'silent' },
  { eventId: 626, text: 'амжилт хүсье🎊👏🥰', expect: 'silent' },
  { eventId: 642, text: 'Чамдаа амжилт хүсье ээ ❤️❤️❤️', expect: 'silent' },
  { eventId: 663, text: 'Амжилт хүсэе', expect: 'silent' },
  { eventId: 671, text: 'Amjilt husey 🥰', expect: 'silent' },
  { eventId: 685, text: 'Woow hayg huuchindaa yu', expect: 'reply', note: 'is the address still the old one?' },
  { eventId: 705, text: 'Ashgui de. Tsag avch boloh yum uu?', expect: 'reply' },
  { eventId: 706, text: 'Yag haana be', expect: 'reply' },
  { eventId: 740, text: 'Амжилт бүтээлийн дээдийг хүсэн ерөөе. Мундаг бүсгүй минь🌹🌺❤️', expect: 'silent' },
  { eventId: 748, text: 'Egchdee amjilt husie. Mundag shuu ta min 🤎', expect: 'silent' },
  {
    eventId: 749, text: 'Tara salon яармаг салбар yarmagtaa bizdee hehe', expect: 'reply',
    note: 'the founder, 2026-09-25: answer it. It names the Page and its branch and asks «it is at Yarmag, right?» — ' +
      'a location question with a laugh on the end. Fires `location_branch` (салбар + «bizdee»), which no longer excludes laughter',
  },
  { eventId: 784, text: 'Үнэ хаяг', expect: 'reply', note: 'price and address, two bare nouns — the founder: answer it' },
  { eventId: 484, text: 'Khulan Erdene Баярлалаа💕', expect: 'silent', note: 'not the Page: a personal account thanking a tagged person' },
  // Nine real comments arrived with no text at all — a sticker or a photo. `extractComments`
  // returns them with `text: ''`, and no rule can fire on nothing.
  ...[419, 438, 487, 500, 551, 553, 558, 649, 664].map((eventId) => ({ eventId, text: '', expect: 'silent' as const, note: 'sticker or photo, no text' })),
];

const q = (text: string, note?: string): CorpusEntry => ({ text, expect: 'reply', ...(note === undefined ? {} : { note }) });
const s = (text: string, note?: string): CorpusEntry => ({ text, expect: 'silent', ...(note === undefined ? {} : { note }) });
const e = (text: string): CorpusEntry => ({ text, expect: 'escalate' });
const t = (text: string): CorpusEntry => ({ text, expect: 'silent', tagsPerson: true });

export const EXAMPLES: Readonly<Record<'question' | 'praise' | 'tag' | 'emoji' | 'complaint' | 'joke' | 'latin', readonly CorpusEntry[]>> = {
  question: [
    q('Үнэ хэд вэ?'), q('Энэ будаг хэдэн төгрөг вэ'), q('Химийн үнэ хэд вэ'), q('Хаяг хаана байдаг вэ?'),
    q('Яармагт хаана байрладаг вэ'), q('Цаг авч болох уу?'), q('Маргааш цаг байна уу'), q('Захиалга авдаг уу'),
    q('Дэлгэрэнгүй мэдээлэл өгөөч'), q('Мэдээлэл авъя'), q('Утасны дугаар хэд вэ'), q('Хэдэн цагаас ажилладаг вэ?'),
    q('Бямба гарагт ажилладаг уу'), q('Энэ өнгийг хийж болох уу?'), q('Урт үсэнд хэд вэ'), q('Омбре хийдэг үү'),
    q('Кератин эмчилгээ байгаа юу?'), q('Эрэгтэй үс засдаг уу'), q('Хүүхдийн үс засдаг уу?'), q('Шулуун хими хэд вэ'),
    q('Энэ ямар будаг вэ'), q('Будаг хэр удаан барих вэ'), q('Үсний эмчилгээ хийдэг үү'), q('Салбар хаана байдаг вэ?'),
    q('Хэдэн салбартай вэ'), q('Маникюр хийдэг үү'), q('Урамшуулал байгаа юу'), q('Хямдрал хэзээ хүртэл вэ'),
    q('Байршил аль вэ'), q('Энэ үсчний цаг авмаар байна'), q('Үнийн мэдээлэл өгөөч'), q('Сэттинг хэд вэ?'),
    q('Гоё юм аа, үнэ нь хэд вэ?', 'praise first, then a price — the question wins'),
    q('Хэзээ нээх вэ?'), q('ib'), q('Инбокс шалгаарай'), q('Pm бичлээ'),
    // Found by probing the first version of the rules with comments it had not been tuned on.
    q('Утсаа өгөөч'), q('Утас?'), q('Эрэгтэйчүүдэд үйлчилдэг үү'), q('Salbaruud'), q('Шинэ салбар хэзээ нээгдэх вэ'),
    q('Хамгийн ойрын цаг хэзээ вэ'), q('Үнэ?'), q('Нээлттэй юу'), q('Одоо ажиллаж байгаа юу'), q('Хаяг'), q('Мэдээлэл'),
    q('Ямар гоё юм бэ хэдээр хийдэг вэ'), q('Сайхан байна, хаана байдаг вэ'), q('Tsagiin huwaari'), q('Цаг авах'),
    // D-122 addendum: a LOCATION question with a laugh on the end is still a location
    // question. The two location rules are the only reply rules without the laughter
    // exclusion; every joke below must stay silent regardless.
    q('Хаяг хаана вэ хаха', 'a location question, laughing'), q('hayg haana ve haha'), q('Хаана байдаг юм бэ 😂'),
    q('Салбар нь Яармагт биз дээ хэхэ', '«биз дээ» — "right?" — a question asking the salon to confirm'),
    q('Яармаг салбар мөн биз 😅'), q('salbar yarmagtaa biz dee hehe'),
  ],
  praise: [
    s('Амжилт хүсье'), s('Гоё байна'), s('Ямар гоё юм бэ'), s('Хөөрхөн юу'), s('Үнэхээр гоё болжээ'), s('Мундаг шүү'),
    s('Баярлалаа'), s('Гоёмсог'), s('Сайхан болсон байна'), s('Чадварлаг мастер'),
    s('Ямар хөөрхөн өнгө вэ', 'an exclamation shaped like a question, about a colour — praise'),
    s('Ямар гоё будаг вэ', 'the same, about the dye'),
    s('Гоё үс байна'), s('Энэ өнгө үнэхээр гоё'), s('Wow гоё'), s('goy bna'), s('goyo'), s('hoorhon'), s('mundag'),
    s('amjilt husie'), s('bayrlalaa'), s('Гайхалтай'), s('Super 👍'), s('Хамгийн шилдэг салон'), s('Миний дуртай салон ❤️'),
    s('Дахиад очно шүү'), s('Ажилдаа амжилт'), s('Сайн ажиллаарай', 'a well-wish that contains the stem of "working hours"'),
    s('Энэ үсчин үнэхээр мундаг'), s('Хэн ийм гоё болгодог юм бэ', 'who makes it this beautiful — praise'),
    s('Ямар гоё үс вэ'), s('Амжилт бүтээлийн дээдийг хүсье'),
    s('Муу биш шүү', 'not bad — praise, and it must not page the founder as a complaint'), s('Muu bish'),
    s('Мундаг мастер хэн бэ'), s('Ямар хөөрхөн юм бэ'), s('Үнэхээр гоё будаг байна, ямар өнгө вэ'),
    s('Сэтгэл хангалуун байна'), s('Үйлчилгээ маш сайн'),
  ],
  tag: [
    t('Bold Bat энийг хар'), t('Saraa Enkh чамд таарна'), t('Anu Gan хийлгэе хамт'), t('Номин Бат 😍'),
    t('Ану Болд энд очъё'), t('Tuya Bat ийм болгоё'), t('Bat Erdene'), t('Саран Туул чи энийг хийлгэ'),
    t('Oyuka Tsend 😂😂'), t('Enkhjin B look'), t('Золзаяа Г энэ чинь'), t('Munkh Od үнэ нь хэд юм бол'),
    t('Намуун Энх хаяг нь хаана юм бэ'), t('Gerel Bat tsag avah uu'), t('Дөлгөөн Б хамт очих уу'), t('Nomuunaa Bold ib bichey'),
    t('Ariunaa Ts энэ өнгө чамд зохино'), t('Хонгорзул Д үсээ ингэж будуулаач'), t('Uyanga Bat 🔥🔥'), t('Батаа Ганаа хар даа'),
    t('Enkhee Munkh ene salon goy shuu'), t('Солонго Т маргааш хамт очих уу?'), t('Anar Bold hed bolj bgaag asuugaarai'),
    t('Оюунаа Б чиний хэлсэн салон'), t('Tsetsgee Bat 👀'), t('Мөнхөө Б энд цаг авъя'), t('Unur Ganbold'), t('Ганчимэг Ж 😍😍'),
    t('Zaya Bat ombre hiilgeh uu'), t('Хулан Э үнэ нь дажгүй юм байна'),
  ],
  emoji: [
    s('😍'), s('❤️❤️❤️'), s('🔥🔥'), s('👏👏👏'), s('🥰'), s('😘'), s('💕'), s('👍'), s('🙌'), s('😮'), s('😂'), s('💯'),
    s('✨✨'), s('🤩'), s('💇‍♀️'), s('😍😍😍'), s('❤️'), s('🫶🏻🫶🏻'), s('💪💪'), s('🌹'), s('👌'), s('🙏'), s('😊'), s('🤎'),
    s('💖'), s('🥹'), s('😻'), s('💐'), s('⭐⭐⭐⭐⭐'), s('❤️‍🔥'), s('', 'a sticker: no text at all'), s('???'),
  ],
  complaint: [
    e('Утсаа авахгүй байна'), e('2 өдөр залгаж байна авахгүй юм'), e('Утсаа аваач'), e('Залгаад авахгүй юм аа'),
    e('Үсийг минь сүйтгэсэн'), e('Будаг хийлгээд үс минь шатчихлаа'), e('Үйлчилгээ муу байна'), e('Маш муу үйлчилгээ'),
    e('Мөнгөө буцааж өгөөч'), e('Луйварчид'), e('Мессежэнд хариулахгүй юм уу'), e('Хүлээлгээд байх юм'),
    e('Бүдүүлэг харьцаатай ажилтан'), e('Ичгүүргүй юм'), e('Дахиж очихгүй'), e('Сэтгэл дундуур байна'),
    e('Гомдол гаргамаар байна'), e('Та нар худлаа ярьдаг юм'), e('Үс минь муудсан'), e('AI биш хүнтэй холбогдмоор байна'),
    e('Муухай болгосон'), e('Тэнэг юм'), e('Хогийн үйлчилгээ'), e('utsaa avahgui bn'), e('zalgaad avahgui yum'),
    e('muu uilchilgee'), e('gomdol bna'), e('luivar'), e('ai bish huntei holbogdmoor bna'), e('ichguurgui yum'),
    e('mungu butsaaj ugluu'), e('hudlaa yaridag'), e('Ямар муухай юм'), e('Маш муу'),
  ],
  joke: [
    s('Хаха энэ би юм уу'), s('хахаха нөхрөө явуулъя'), s('Энийг хийлгээд нөхөр маань таних болов уу 😂'),
    s('Хаха чи энийг хийлгэчих'), s('lol'), s('haha ene chin bi bish uu'), s('Ээж минь ч гэсэн ийм болмоор байна хаха'),
    s('Үсгүй хүн юу хийх вэ хаха'), s('Халзан хүнд хэд вэ хаха'), s('Намайг ч гэсэн залуу болгоод өгөөч 😂'),
    s('Муурандаа будаг хийлгэж болох уу 😂'), s('Би ч гэсэн ийм болох уу 🤣'), s('Энэ өнгөөр машинаа будуулмаар 😂'),
    s('Хэдэн жил хийлгэхгүй байсан юм бэ хаха'), s('Нөхрийн минь үсийг ингэж засч болох уу хэхэ'),
    s('Зээлээр хийдэг үү 😂'), s('Үнэгүй хийдэг үү хаха'), s('haha tsag avya bi ch gesen'), s('lol une ni hed ve'),
    s('Сахал будаж болох уу 😅'), s('Нохойныхоо үсийг засуулж болох уу 😂'), s('hehe bi ch bas'), s('Хахаха ёстой инээд хүрлээ'),
    s('xaxa ene yu ve'), s('Энийг хараад ээж минь айна даа 😆'), s('Би ийм болбол хэн ч танихгүй 🤣🤣'),
    s('Толгой минь хүртэл гялалзана 😂'), s('Хаха бид хоёр ийм болох уу'), s('Лол салонд очоод буцаж ирэхгүй юм байна 😂'),
    s('Ингэж будуулчихвал ажлаасаа хөөгдөнө хэхэ'),
    s('Хэзээ очих вэ хамт', 'two friends planning — no question to the salon'), s('Хэдүүлээ очъё'), s('Гадаа хүйтэн байна уу'),
    // «биз» is a question word only inside the location rules; a joke that uses it about
    // anything else stays a joke.
    s('Би ч гэсэн ийм болох биз дээ хаха'), s('Нөхөр маань намайг таних биз хэхэ'), s('ene chin bi biz dee haha'),
  ],
  latin: [
    q('une hed ve'), q('une hed we'), q('uniin medeelel'), q('hayg haana ve'), q('hayag?'), q('haana baidag ve'),
    q('tsag avch boloh uu'), q('tsag avmaar bn'), q('cag avya'), q('margaash tsag bgaa yu'), q('ib'), q('pm'), q('info'),
    q('delgerengui'), q('delgerengui medeelel'), q('ib ee'), q('utasnii dugaar'), q('hedeer hiideg ve'), q('himi hed ve'),
    q('budag hed ve'), q('ombre hiideg uu'), q('usnii emchilgee bga yu'), q('manicure hiideg uu'), q('salbar haana bdag ve'),
    q('heden tsagaas ajilladag ve'), q('hymdral bga yu'), q('zahialga avdag uu'), q('ene ongo hed ve'), q('urt usend hed ve'),
    q('keratin hed'), q('ibeer medeelel ogooch'),
  ],
};
