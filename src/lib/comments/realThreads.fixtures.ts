/**
 * Real comment threads from Matrix / Tara Salon's Page, as `webhook_events` stored them
 * (D-122 addendum). Permanent: `worker/comments.realThreads.test.ts` replays them through
 * `runCommentJob` on every CI run.
 *
 * Two posts, every comment delivery on them between 2026-09-22 and 2026-09-25 that is either
 * the Page's own (the staff answering by hand) or a customer comment the tests decide:
 *
 *   P_REEL_0922 — the reel posted 2026-09-22 05:36 UTC. Its Page comments are the staff's
 *                 «<name> Баярлалаа💕» thank-yous and two answers (415, 508, 711).
 *   P_REEL_0829 — the reel posted 2026-08-29. On 2026-09-25 at 14:19 the staff answered
 *                 «Үнэ хаяг» (784) seven and a half hours after it arrived, then answered four
 *                 older comments in the same minute, pasting the same text — so every one of
 *                 those replies also carries «Ogi Oyunaa», the first person answered.
 *                 The four customer comments they answer never reached this platform (none is
 *                 in `webhook_events`; they predate the `feed` subscription or were never
 *                 delivered), which is why only their Page replies are here.
 *
 * Copied from `raw_payload` (`changes[0].value`), trimmed to the fields the comment path
 * reads. Commenters' NAMES AND IDS ARE INVENTED, replaced consistently everywhere they occur
 * (including inside the Page's replies), so the tag check still meets the real shapes —
 * Latin, Cyrillic, initials («Б. Нар», «Сарнай С.»). Texts, event, comment and post ids and
 * times are as stored.
 */
export const PAGE_ID = '1520409424715591';
export const P_REEL_0922 = `${PAGE_ID}_1398786365727108`;
export const P_REEL_0829 = `${PAGE_ID}_1378787287727016`;

/** When each post was created — from the Page's own `video` events 403 and 366. */
export const POST_CREATED: Readonly<Record<string, Date>> = {
  [P_REEL_0922]: new Date(1790055413 * 1000),
  [P_REEL_0829]: new Date(1787991624 * 1000),
};

export type StoredComment = {
  /** `webhook_events.id`. */
  eventId: number;
  receivedAt: string;
  fromId: string;
  fromName: string;
  commentId: string;
  parentId: string;
  postId: string;
  message: string | null;
  /** `value.created_time`, UNIX seconds. */
  createdTime: number;
};

const A = '1398786365727108_';
const B = '1378787287727016_';
const PAGE = { id: PAGE_ID, name: 'Tara salon яармаг салбар' };

function page(eventId: number, receivedAt: string, commentId: string, parentId: string, postId: string, message: string, createdTime: number): StoredComment {
  return { eventId, receivedAt, fromId: PAGE.id, fromName: PAGE.name, commentId, parentId, postId, message, createdTime };
}
function cust(eventId: number, receivedAt: string, fromId: string, fromName: string, commentId: string, parentId: string, postId: string, message: string | null, createdTime: number): StoredComment {
  return { eventId, receivedAt, fromId, fromName, commentId, parentId, postId, message, createdTime };
}

export const STORED: readonly StoredComment[] = [
  page(410, '2026-09-22T05:43:23.246Z', `${A}1792725698673848`, `${A}2533577880468144`, P_REEL_0922, 'Tuya Tuya баярлалаа💕', 1790055799),
  cust(412, '2026-09-22T05:44:07.143Z', '90000000000000005', 'Дорж Бат', `${A}1071986075685070`, P_REEL_0922, P_REEL_0922, 'Хаяг хуучиндаа юу?', 1790055843),
  page(415, '2026-09-22T05:45:45.602Z', `${A}1093751833582201`, `${A}1071986075685070`, P_REEL_0922, 'Дорж Бат Хуучиндаа . Манай салбар удахгүй шинэ байршил руу нүүх гэж байгаа . Удахгүй мэдээлэл өгнөө.💕', 1790055941),
  page(422, '2026-09-22T05:47:57.765Z', `${A}1453669683338366`, `${A}2301321197287166`, P_REEL_0922, 'Oyu Bold баярлалаа💕', 1790056073),
  page(451, '2026-09-22T06:03:27.549Z', `${A}2334252307379242`, `${A}1370546688586854`, P_REEL_0922, 'Sara Temuulen Баярлалаа💕', 1790057004),
  page(477, '2026-09-22T06:22:46.145Z', `${A}1654363026115681`, `${A}1407249744100292`, P_REEL_0922, 'Zaya Nomi Баярлалаа💕', 1790058162),
  page(481, '2026-09-22T06:23:03.653Z', `${A}1348222063800807`, `${A}3257578837964111`, P_REEL_0922, 'Solongo Ganbold Баярлалаа💕', 1790058179),
  // Not the Page: a stylist's personal account thanking someone. Never staff evidence.
  cust(484, '2026-09-22T06:24:21.764Z', '90000000000000000', 'Stylist Account', `${A}1413425690985408`, `${A}1336019808401618`, P_REEL_0922, 'Khulan Erdene Баярлалаа💕', 1790058257),
  cust(492, '2026-09-22T06:39:19.108Z', '90000000000000004', 'Б. Нар', `${A}2794712814263601`, P_REEL_0922, P_REEL_0922, 'Amjilt nzdaa 🤗💪🏻\nHaashaa nuuj bga we', 1790059154),
  page(505, '2026-09-22T06:57:16.141Z', `${A}4065228047116378`, `${A}4317966198465972`, P_REEL_0922, 'Сэлэнгэ Бямба Баярлалаа💕', 1790060231),
  page(508, '2026-09-22T06:58:25.850Z', `${A}1414354837469735`, `${A}2794712814263601`, P_REEL_0922, 'Б. Нар vip center 2 давхарт удахгүй орно. Яармагт', 1790060300),
  page(510, '2026-09-22T06:58:47.734Z', `${A}39211317841799742`, `${A}1399308285981819`, P_REEL_0922, 'Temuujin Dash Баярлалаа💕', 1790060321),
  page(575, '2026-09-22T11:44:08.115Z', `${A}2081380542738794`, `${A}1625600102632455`, P_REEL_0922, 'Anu Munkh Баярлалаа💕', 1790077442),
  page(577, '2026-09-22T11:44:37.580Z', `${A}2165375920687862`, `${A}1069506325946382`, P_REEL_0922, 'Мөнхөө Мөнхөө Баярлалаа💕', 1790077471),
  page(579, '2026-09-22T11:49:16.775Z', `${A}1866832354699291`, `${A}1774031233512291`, P_REEL_0922, 'Nomin Saraa Баярлалаа💕', 1790077751),
  page(581, '2026-09-22T11:49:34.691Z', `${A}1400917241505330`, `${A}1246726674307796`, P_REEL_0922, 'Bolor Tsetseg Баярлалаа💕', 1790077770),
  page(584, '2026-09-22T11:49:53.701Z', `${A}1731168817951395`, `${A}1519541699937744`, P_REEL_0922, 'Ганзориг Цэцгээ Баярлалаа💕', 1790077787),
  page(588, '2026-09-22T11:50:18.910Z', `${A}1086378297639520`, `${A}1581978953335292`, P_REEL_0922, 'Mishka Dancer Show Баярлалаа💕', 1790077804),
  page(590, '2026-09-22T11:50:36.199Z', `${A}1809838287024870`, `${A}1093929339715956`, P_REEL_0922, 'Maral Dorj Баярлалаа💕', 1790077820),
  page(592, '2026-09-22T11:50:49.526Z', `${A}1079072081657529`, `${A}1771236780747499`, P_REEL_0922, 'Сарнай С. Баярлалаа💕', 1790077833),
  page(606, '2026-09-22T13:41:05.459Z', `${A}1954184885257331`, `${A}1091219840062770`, P_REEL_0922, 'Enkhjin Erka Баярлалаа💕', 1790084459),
  page(608, '2026-09-22T13:42:39.628Z', `${A}1740602187187133`, `${A}1407910584179637`, P_REEL_0922, 'Ariun Batbayar Баярлалаа💕', 1790084532),
  page(623, '2026-09-22T15:06:35.504Z', `${A}1436708641974060`, `${A}1633328461652046`, P_REEL_0922, 'Delger Delgerma Баярлалаа💕', 1790089589),
  page(646, '2026-09-23T00:50:12.228Z', `${A}2309165423175864`, `${A}1023343554051670`, P_REEL_0922, 'Oyuka Gansukh Баярлалаа💕', 1790124608),
  page(667, '2026-09-23T06:37:02.363Z', `${A}1491235999462522`, `${A}2111981946347259`, P_REEL_0922, 'Naraa Sodoo Баярлалаа💕', 1790145417),
  page(688, '2026-09-23T07:22:35.900Z', `${A}1619342703109610`, `${A}1749545423161365`, P_REEL_0922, 'Temka Bilgee Баярлалаа💕', 1790148152),
  page(690, '2026-09-23T07:22:55.665Z', `${A}28547616491589328`, `${A}1449142720418549`, P_REEL_0922, 'Naraa Sodoo Баярлалаа💕', 1790148171),
  cust(705, '2026-09-23T14:50:19.776Z', '90000000000000001', 'Батзориг Намсрай', `${A}1724020538825453`, P_REEL_0922, P_REEL_0922, 'Ashgui de. Tsag avch boloh yum uu?', 1790175014),
  cust(706, '2026-09-23T14:53:00.330Z', '90000000000000001', 'Батзориг Намсрай', `${A}1504646148088489`, P_REEL_0922, P_REEL_0922, 'Yag haana be', 1790175176),
  page(711, '2026-09-23T20:22:07.151Z', `${A}1727853898285746`, `${A}1724020538825453`, P_REEL_0922, 'Батзориг Намсрай Та ☎️76001888 залгаж цагаа аваарай', 1790194923),
  cust(740, '2026-09-24T05:39:58.827Z', '90000000000000006', 'Gerel Munkhbat', `${A}1334783559722949`, P_REEL_0922, P_REEL_0922, 'Амжилт бүтээлийн дээдийг хүсэн ерөөе. Мундаг бүсгүй минь🌹🌺❤️', 1790228394),
  cust(748, '2026-09-24T13:10:44.448Z', '90000000000000002', 'Saran Tuul', `${A}906212865693103`, P_REEL_0922, P_REEL_0922, 'Egchdee amjilt husie. Mundag shuu ta min 🤎', 1790255440),
  cust(749, '2026-09-24T13:12:27.018Z', '90000000000000002', 'Saran Tuul', `${A}28096149960081092`, `${A}1071986075685070`, P_REEL_0922, 'Tara salon яармаг салбар yarmagtaa bizdee hehe', 1790255520),
  page(751, '2026-09-24T14:10:27.287Z', `${A}1450266930498914`, `${A}906212865693103`, P_REEL_0922, 'Saran Tuul Баярлалаа💕', 1790259021),
  cust(784, '2026-09-25T06:49:26.408Z', '90000000000000003', 'Ogi Oyunaa', `${B}1370871108161662`, P_REEL_0829, P_REEL_0829, 'Үнэ хаяг', 1790318962),
  page(803, '2026-09-25T14:19:02.592Z', `${B}1828875115203808`, `${B}1370871108161662`, P_REEL_0829, 'Ogi Oyunaa 📍 Яармаг салбар\n\n🏢 Мөнхада төвийн зүүн талд, Төгөлдөр Апартмент 1 давхарт.\n\n📞 Цаг захиалах бол 76001888 манай салбартай холбогдоорой.\n\n☎️ Гар утас: 9100 5498', 1790345937),
  page(806, '2026-09-25T14:19:15.575Z', `${B}1722045702228432`, `${B}2727639764299440`, P_REEL_0829, 'Khongor Battulga Ogi Oyunaa 📍 Яармаг салбар\n\n🏢 Мөнхада төвийн зүүн талд, Төгөлдөр Апартмент 1 давхарт.\n\n📞 Цаг захиалах бол 76001888 манай салбартай холбогдоорой.\n\n☎️ Гар утас: 9100 5498', 1790345950),
  page(808, '2026-09-25T14:19:21.518Z', `${B}1444669067551432`, `${B}1086869327175318`, P_REEL_0829, 'Цэцэгмаа Дорж Ogi Oyunaa 📍 Яармаг салбар\n\n🏢 Мөнхада төвийн зүүн талд, Төгөлдөр Апартмент 1 давхарт.\n\n📞 Цаг захиалах бол 76001888 манай салбартай холбогдоорой.\n\n☎️ Гар утас: 9100 5498', 1790345956),
  page(810, '2026-09-25T14:19:27.209Z', `${B}968054209648763`, `${B}2306599276818489`, P_REEL_0829, 'Ундрах Ганбаатар Ogi Oyunaa 📍 Яармаг салбар\n\n🏢 Мөнхада төвийн зүүн талд, Төгөлдөр Апартмент 1 давхарт.\n\n📞 Цаг захиалах бол 76001888 манай салбартай холбогдоорой.\n\n☎️ Гар утас: 9100 5498', 1790345962),
  page(812, '2026-09-25T14:19:30.699Z', `${B}1476649297608108`, `${B}1559304308701371`, P_REEL_0829, 'Erdene Erdenechimeg Ogi Oyunaa 📍 Яармаг салбар\n\n🏢 Мөнхада төвийн зүүн талд, Төгөлдөр Апартмент 1 давхарт.\n\n📞 Цаг захиалах бол 76001888 манай салбартай холбогдоорой.\n\n☎️ Гар утас: 9100 5498', 1790345966),
];

/** The stored `feed` entry for one row, shaped as Meta delivered it. */
export function entryOf(c: StoredComment): unknown {
  return {
    id: PAGE_ID,
    time: c.createdTime,
    changes: [{
      field: 'feed',
      value: {
        from: { id: c.fromId, name: c.fromName },
        item: 'comment',
        verb: 'add',
        post_id: c.postId,
        parent_id: c.parentId,
        comment_id: c.commentId,
        created_time: c.createdTime,
        ...(c.message === null ? {} : { message: c.message }),
      },
    }],
  };
}
