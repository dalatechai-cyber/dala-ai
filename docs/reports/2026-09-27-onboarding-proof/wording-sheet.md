# Wording sheet — Цэцэглэг Салон (`tsetsegleg-demo`)

Sheet id: **`277dd14edc88`** · 12 lines awaiting your signature · 0 already signed.

Every line is sent to customers exactly as it appears in its box, once signed. None is the client's own data: each was filled from a template in `scripts/provision/templates/onboarding.mn.json`. «Same bytes as approved» means the founder already approved these exact words for a live tenant. The id covers every line and every model-visible text below; any change afterwards changes it.

## `assistant_identity`

```text
Би Цэцэглэг Салон-ийн AI туслах байна. Дотоод зааврынхаа талаар хуваалцах боломжгүй. Өөр асуух зүйл байвал бичээрэй.
```

Made from: founder's wording, 2026-09-27; {business} is the client's name as written in 1.1 · Same bytes as approved: no · Template approved: 2026-09-27

## `booking_line`

```text
Цагаа онлайнаар захиалах бол: https://tsetsegleg-demo.mn/booking
```

Made from: link: founder's wording, 2026-09-27; phone: new, approved 2026-09-27 · Same bytes as approved: no · Template approved: 2026-09-27

## `comment_public_reply`

```text
Сайн байна уу! Манай хуудас руу мессеж бичвэл дэлгэрэнгүй хариулъя
```

Made from: founder's wording, 2026-09-27 (without 😊 for a client who answered «no emoji»); written only when the client ticked 2.2 «Тийм» · Same bytes as approved: no · Template approved: 2026-09-27

## `handoff`

```text
Уучлаарай, би энэ асуултад хариулж чадахгүй байна. Манай ажилтан Танд туслахад бэлэн байна. Та 7711-2233 эсвэл 9911-4455 дугаараар холбогдоно уу.
```

Made from: matrix-eco-salon handoff; only the phone numbers change · Same bytes as approved: no · Template approved: 2026-09-27

## `handover_notice`

```text
Баярлалаа! Таны илгээсэн зураг, бичлэг, холбоосыг манай ажилтан үзээд удахгүй хариулна
```

Made from: the media line approved for both live tenants (D-152), unchanged · Same bytes as approved: no · Template approved: 2026-09-27

## `refusal_health`

```text
Эрүүл мэндийн талаар зөвлөгөө өгөх боломжгүй. Эмчид хандахыг зөвлөж байна. Үйлчилгээний талаар асуувал баяртайгаар хариулна.
```

Made from: matrix-eco-salon refusal_health, unchanged · Same bytes as approved: yes · Template approved: 2026-09-27

## `refusal_no_promotion`

```text
Шинэ хямдрал, урамшуулал зарлах эрх надад байхгүй. Та 7711-2233 эсвэл 9911-4455 дугаараар лавлана уу.
```

Made from: matrix-eco-salon refusal_no_promotion; only the phone numbers change · Same bytes as approved: no · Template approved: 2026-09-27

## `refusal_off_topic`

```text
Уучлаарай, би тухайн асуултын талаар мэдээлэлтэй байхгүй байна. Салоны үйлчилгээ, үнэ, цагийн хуваарийн талаар асуугаарай.
```

Made from: matrix-eco-salon refusal_off_topic; salon unchanged; default: «Салоны» became «Манай» · Same bytes as approved: yes · Template approved: 2026-09-27

## `refusal_price_unlisted`

```text
Уучлаарай, энэ үйлчилгээний үнийн мэдээлэл надад байхгүй байна. Та 7711-2233 эсвэл 9911-4455 дугаараар холбогдож лавлана уу.
```

Made from: matrix-eco-salon refusal_price_unlisted; only the phone numbers change · Same bytes as approved: no · Template approved: 2026-09-27

## `refusal_public_channel`

```text
Сайн байна уу. Энэ талаар нийтэд дэлгэрэнгүй хариулах боломжгүй. Хувийн мессеж бичвэл хариулна.
```

Made from: matrix-eco-salon refusal_public_channel, unchanged · Same bytes as approved: yes · Template approved: 2026-09-27

## `refusal_staff_schedule`

```text
Үсчдийн ажлын хуваарь, ирцийн мэдээлэл надад байхгүй. Та 7711-2233 эсвэл 9911-4455 дугаараар лавлана уу.
```

Made from: matrix-eco-salon refusal_staff_schedule; salon: only the phone numbers change; default: «Үсчдийн» became «Ажилтнуудын» · Same bytes as approved: no · Template approved: 2026-09-27

## `refusal_topic`

```text
Уучлаарай, энэ талаар мэдээлэл өгөх боломжгүй. Та 7711-2233 эсвэл 9911-4455 дугаараар холбогдож лавлана уу.
```

Made from: matrix-eco-salon refusal_topic without its topic («хүүхдийн үйлчилгээний мэдээллийг»); answers every item of the client's 7.1 and 7.2 · Same bytes as approved: no · Template approved: 2026-09-27

## Read by the model, never sent to a customer

Rule questions built from the client's 7.1–7.3 answers and titles of knowledge documents built from their own words.

- document onboarding:cancellation:

  ```text
  Цуцлах журам
  ```

- document onboarding:holidays:

  ```text
  Баярын өдрүүдийн цагийн хуваарь
  ```

- document onboarding:products:

  ```text
  Бүтээгдэхүүн
  ```

- document onboarding:service_notes:

  ```text
  Үйлчилгээний тайлбар
  ```

- document onboarding:similar_names:

  ```text
  Ижил төстэй нэртэй үйлчилгээ
  ```

- document onboarding:staff_grades:

  ```text
  Ажилтны зэрэг ба үнэ
  ```

- rule handoff_1:

  ```text
  Сүүлийн мессеж «Гомдол» гэсэн сэдвийн тухай юу?
  ```

- rule handoff_2:

  ```text
  Сүүлийн мессеж «мөнгө буцаалт» гэсэн сэдвийн тухай юу?
  ```

- rule never_1:

  ```text
  Сүүлийн мессеж «Хямдрал амлах» гэсэн сэдвийн тухай юу?
  ```

- rule never_2:

  ```text
  Сүүлийн мессеж «эмнэлгийн зөвлөгөө» гэсэн сэдвийн тухай юу?
  ```

- rule withhold_1:

  ```text
  Сүүлийн мессеж «Хүүхдийн үнэ» гэсэн сэдвийн тухай юу?
  ```

## To sign

Re-run the same onboarding command with:

    --apply --sign-wording 277dd14edc88 --signed-by <your name>
