/**
 * Every inbound message Matrix Eco Salon's real customers sent, 2026-09-14 to 2026-09-18.
 *
 * The one real Mongolian corpus this platform has, and the evidence `docs/comments.md`
 * rests on. It is a fixture rather than a document because the design makes quantitative
 * claims — question-shape reaches a minority, topic stems reach a majority, the booking
 * intent needs a stem sequence — and a claim nothing executes is a claim that drifts.
 * `classify.test.ts` asserts against it, so editing this array to suit a conclusion turns
 * a test red rather than making the conclusion true.
 *
 * ## Why real messages, and what is and is not in them
 *
 * Synthetic Mongolian would be written by whoever is building the matcher, which makes
 * every measurement over it circular — the bare topic nouns that are 52% of this corpus
 * («Хаяг», «Хими», «Мэдээлэл») are exactly what someone inventing test data would not
 * think to write, and they are the finding.
 *
 * It carries message BODIES only: no PSID, no name, no phone number, no timestamp, no
 * conversation. Two messages name a stylist the customer asked for — a business fact the
 * salon publishes, not a customer identifier — and they are kept because removing them
 * would silently change the denominator every percentage here is measured against.
 *
 * This is a test fixture, which CLAUDE.md names explicitly as NOT a customer-visible
 * Mongolian string: nothing renders it, no reply quotes it, and it reaches no prompt.
 *
 * ## It is DM text, and comments are a different surface
 *
 * Stated here because it is the limitation that matters most and it is invisible from the
 * data. Nobody sends a salon a direct message to say «гоё», so this corpus is silent on
 * the NOISE rate a public feed carries — it grounds what a real customer asks and in what
 * shape, and it says nothing about how much of a comment feed is praise, tags and emoji.
 * That half rests on the founder's reading of his own feed until a comment feed exists.
 */
export const MATRIX_DM_CORPUS: readonly string[] = [
  "hello",
  "будаг хэдээр хийх вэ",
  "buten",
  "Хаяг",
  "Цаг авах",
  "Эмэгтэй сортой будаг хийлгэх гэсийн",
  "Очиж үсчинтэйгээ уулзаж ярилцаад шийдэж болох уу",
  "Sn bnu?",
  "Холбогдох утас бна",
  "Уу",
  "tsag avii",
  "Сайн байна уу",
  "Цаг авах гэсэн юм",
  "Үс будуулна, маникюр педикюр",
  "Өнөөдрийн цаг байнуу",
  "Утсаа авахгүй байна",
  "2 өдөр залгаж байна",
  "sn bna uu",
  "emchilgeenii himu",
  "himu hymdral bgaa yu",
  "эмчилгээний хими сонирхож бна",
  "ai bish huntei holbogdmoor bna",
  "asuult oilgoh tuvshnii bish bna",
  "Sain bna u",
  "4deh udur hamgiin ert tsag hed deer bna Oyuka deer",
  "Мөрөөр тарих тэгээд цайвар үстэй болхоор омврээ будалт",
  "Хийлгэх юм",
  "Цаг авдаг уу",
  "Мөрнөөс арай богино тайруулаад сэттинг хийлгэвэл хэд болох вэ",
  "Иймэрхүү",
  "Эмэгтэй 1р зэргийн",
  "Ugluni mend. Unudr tom huni tairalt master stilist drn tsag baiga bolov uu",
  "Emegtei",
  "Tulbur amjilttai",
  "Sn bnuu \nOyunaaa artist vs tairalt budaltiiin surgalt uguhvvv",
  "Bayrllaa",
  "Сайн байна уу",
  "Шулуун хими хэдээр хийх вэ?",
  "Танай хаяг хаана вэ?",
  "Sain bainu",
  "Яармаг салбар",
  "Хүннү салбар",
  "Usnii emchilgee",
  "Us toslogtood bn",
  "Kurs emchilgee bdgu",
  "Himi",
  "Klinik emchilgee",
  "Saloni emchilge",
  "Buh turliin uilchilgee",
  "Hi vsnii ongo oorchlowol zohih ongiin songoj ogohvv",
  "Xayg",
  "hi",
  "Хаяг яармагийн хаана вэ",
  "Sn bnu hagsaind tsag bgayu",
  "Us tairalt\n10-13 iin hoorond",
  "Emegtei \nMaster",
  "Сайн байна уу? Үс будалт үнэ хэд вэ?",
  "Sn bnu sortoi budalt hed ve",
  "Мэдээлэл",
  "Үс будуулах",
  "Ж",
  "Хими",
  "Эмэгтэй хими",
  "Salbaruud",
  "Tsagiin huwaari",
  "Хаяг",
  "Setting himi",
  "Hayg",
  "Hedn salbartaiwe",
  "Himi hiilgwl her udhu",
  "Margaash tsag bga yu office color",
];
