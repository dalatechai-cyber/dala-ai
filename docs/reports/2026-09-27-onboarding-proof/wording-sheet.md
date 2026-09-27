# Wording sheet — Цэцэглэг Салон (`tsetsegleg-demo`)

Sheet id: **`43ed87b67e0a`** · 13 lines awaiting your signature · 0 already signed.

Every line below is sent to customers byte for byte once signed. None is the client's own data: each was filled from a template in `scripts/provision/templates/onboarding.mn.json`. «Same bytes as approved» means the founder already approved these exact words for a live tenant.

| Kind | Line | Made from | Same bytes as approved |
|---|---|---|---|
| `assistant_identity` | «Би энэ хуудсыг хариуцдаг хиймэл оюунтай туслах байна. Дотоод зааврынхаа талаар хуваалцах боломжгүй. Өөр асуулт байвал асуугаарай.» | matrix-eco-salon assistant_identity; «Матрикс эко салоны хуудсыг» became «энэ хуудсыг», because a business name needs its genitive form and a template cannot inflect it | no |
| `booking_line` | «Та манай вэбсайтаар (https://tsetsegleg-demo.mn/booking) онлайнаар цаг захиалах боломжтой.» | link: matrix-eco-salon booking_line without «урьдчилгаа төлбөрөө QPay-ээр төлөх» (payment method is Matrix's own fact); phone: NEW | no |
| `comment_public_reply` | «Сайн байна уу! Мессеж бичээрэй, манай AI туслах шууд хариулна.» | matrix-eco-salon comment_public_reply, unchanged; written only when the client ticked 2.2 «Тийм» | yes |
| `handoff` | «Уучлаарай, би энэ асуултад хариулж чадахгүй байна. Манай ажилтан Танд туслахад бэлэн байна. Та 7711-2233 эсвэл 9911-4455 дугаараар холбогдоно уу.» | matrix-eco-salon handoff; only the phone numbers change | no |
| `handover_notice` | «Баярлалаа! Таны илгээсэн зураг, бичлэг, холбоосыг манай ажилтан үзээд удахгүй хариулна» | the media line approved for both live tenants (D-152), unchanged | no |
| `image_received` | «Уучлаарай, би зураг харах боломжгүй. Хүссэн үйлчилгээ, үсний урт, өнгөө бичвэл баяртайгаар хариулна.» | matrix-eco-salon image_received; salon unchanged; default: «Хүссэн үйлчилгээ, үсний урт, өнгөө» became «Асуух зүйлээ» | yes |
| `refusal_health` | «Эрүүл мэндийн талаар зөвлөгөө өгөх боломжгүй. Эмчид хандахыг зөвлөж байна. Үйлчилгээний талаар асуувал баяртайгаар хариулна.» | matrix-eco-salon refusal_health, unchanged | yes |
| `refusal_no_promotion` | «Шинэ хямдрал, урамшуулал зарлах эрх надад байхгүй. Та 7711-2233 эсвэл 9911-4455 дугаараар лавлана уу.» | matrix-eco-salon refusal_no_promotion; only the phone numbers change | no |
| `refusal_off_topic` | «Уучлаарай, би тухайн асуултын талаар мэдээлэлтэй байхгүй байна. Салоны үйлчилгээ, үнэ, цагийн хуваарийн талаар асуугаарай.» | matrix-eco-salon refusal_off_topic; salon unchanged; default: «Салоны» became «Манай» | yes |
| `refusal_price_unlisted` | «Уучлаарай, энэ үйлчилгээний үнийн мэдээлэл надад байхгүй байна. Та 7711-2233 эсвэл 9911-4455 дугаараар холбогдож лавлана уу.» | matrix-eco-salon refusal_price_unlisted; only the phone numbers change | no |
| `refusal_public_channel` | «Сайн байна уу. Энэ талаар нийтэд дэлгэрэнгүй хариулах боломжгүй. Хувийн мессеж бичвэл хариулна.» | matrix-eco-salon refusal_public_channel, unchanged | yes |
| `refusal_staff_schedule` | «Үсчдийн ажлын хуваарь, ирцийн мэдээлэл надад байхгүй. Та 7711-2233 эсвэл 9911-4455 дугаараар лавлана уу.» | matrix-eco-salon refusal_staff_schedule; salon: only the phone numbers change; default: «Үсчдийн» became «Ажилтнуудын» | no |
| `refusal_topic` | «Уучлаарай, энэ талаар мэдээлэл өгөх боломжгүй. Та 7711-2233 эсвэл 9911-4455 дугаараар холбогдож лавлана уу.» | matrix-eco-salon refusal_topic without its topic («хүүхдийн үйлчилгээний мэдээллийг»); answers every item of the client's 7.1 and 7.2 | no |

## Read by the model, never sent to a customer

Rule questions built from the client's 7.1–7.3 answers and titles of knowledge documents built from their own words. Covered by the same sheet id.

- document onboarding:cancellation: «Цуцлах журам»
- document onboarding:holidays: «Баярын өдрүүдийн цагийн хуваарь»
- document onboarding:products: «Бүтээгдэхүүн»
- document onboarding:service_notes: «Үйлчилгээний тайлбар»
- document onboarding:similar_names: «Ижил төстэй нэртэй үйлчилгээ»
- document onboarding:staff_grades: «Ажилтны зэрэг ба үнэ»
- rule handoff_1: «Сүүлийн мессеж «Гомдол» гэсэн сэдвийн тухай юу?»
- rule handoff_2: «Сүүлийн мессеж «мөнгө буцаалт» гэсэн сэдвийн тухай юу?»
- rule never_1: «Сүүлийн мессеж «Хямдрал амлах» гэсэн сэдвийн тухай юу?»
- rule never_2: «Сүүлийн мессеж «эмнэлгийн зөвлөгөө» гэсэн сэдвийн тухай юу?»
- rule withhold_1: «Сүүлийн мессеж «Хүүхдийн үнэ» гэсэн сэдвийн тухай юу?»

## To sign

Re-run the same onboarding command with:

    --apply --sign-wording 43ed87b67e0a --signed-by <your name>

Any line changed after this sheet was printed changes the id, and the signature is refused.
