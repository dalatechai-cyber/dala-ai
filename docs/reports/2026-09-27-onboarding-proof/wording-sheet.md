# Wording sheet — Цэцэглэг Салон (`tsetsegleg-demo`)

Sheet id: **`f2cbd3fb37bd`** · 13 lines awaiting your signature · 0 already signed.

Every line is sent to customers exactly as it appears in its box, once signed. None is the client's own data: each was filled from a template in `scripts/provision/templates/onboarding.mn.json`. «Same bytes as approved» means the founder already approved these exact words for a live tenant. The id covers every line and every model-visible text below; any change afterwards changes it.

## `assistant_identity`

```text
Би энэ хуудсыг хариуцдаг хиймэл оюунтай туслах байна. Дотоод зааврынхаа талаар хуваалцах боломжгүй. Өөр асуулт байвал асуугаарай.
```

Made from: matrix-eco-salon assistant_identity; «Матрикс эко салоны хуудсыг» became «энэ хуудсыг», because a business name needs its genitive form and a template cannot inflect it · Same bytes as approved: no

## `booking_line`

```text
Та манай вэбсайтаар (https://tsetsegleg-demo.mn/booking) онлайнаар цаг захиалах боломжтой.
```

Made from: link: matrix-eco-salon booking_line without «урьдчилгаа төлбөрөө QPay-ээр төлөх» (payment method is Matrix's own fact); phone: NEW · Same bytes as approved: no

## `comment_public_reply`

```text
Сайн байна уу! Мессеж бичээрэй, манай AI туслах шууд хариулна.
```

Made from: matrix-eco-salon comment_public_reply, unchanged; written only when the client ticked 2.2 «Тийм» · Same bytes as approved: yes

## `handoff`

```text
Уучлаарай, би энэ асуултад хариулж чадахгүй байна. Манай ажилтан Танд туслахад бэлэн байна. Та 7711-2233 эсвэл 9911-4455 дугаараар холбогдоно уу.
```

Made from: matrix-eco-salon handoff; only the phone numbers change · Same bytes as approved: no

## `handover_notice`

```text
Баярлалаа! Таны илгээсэн зураг, бичлэг, холбоосыг манай ажилтан үзээд удахгүй хариулна
```

Made from: the media line approved for both live tenants (D-152), unchanged · Same bytes as approved: no

## `image_received`

```text
Уучлаарай, би зураг харах боломжгүй. Хүссэн үйлчилгээ, үсний урт, өнгөө бичвэл баяртайгаар хариулна.
```

Made from: matrix-eco-salon image_received; salon unchanged; default: «Хүссэн үйлчилгээ, үсний урт, өнгөө» became «Асуух зүйлээ» · Same bytes as approved: yes

## `refusal_health`

```text
Эрүүл мэндийн талаар зөвлөгөө өгөх боломжгүй. Эмчид хандахыг зөвлөж байна. Үйлчилгээний талаар асуувал баяртайгаар хариулна.
```

Made from: matrix-eco-salon refusal_health, unchanged · Same bytes as approved: yes

## `refusal_no_promotion`

```text
Шинэ хямдрал, урамшуулал зарлах эрх надад байхгүй. Та 7711-2233 эсвэл 9911-4455 дугаараар лавлана уу.
```

Made from: matrix-eco-salon refusal_no_promotion; only the phone numbers change · Same bytes as approved: no

## `refusal_off_topic`

```text
Уучлаарай, би тухайн асуултын талаар мэдээлэлтэй байхгүй байна. Салоны үйлчилгээ, үнэ, цагийн хуваарийн талаар асуугаарай.
```

Made from: matrix-eco-salon refusal_off_topic; salon unchanged; default: «Салоны» became «Манай» · Same bytes as approved: yes

## `refusal_price_unlisted`

```text
Уучлаарай, энэ үйлчилгээний үнийн мэдээлэл надад байхгүй байна. Та 7711-2233 эсвэл 9911-4455 дугаараар холбогдож лавлана уу.
```

Made from: matrix-eco-salon refusal_price_unlisted; only the phone numbers change · Same bytes as approved: no

## `refusal_public_channel`

```text
Сайн байна уу. Энэ талаар нийтэд дэлгэрэнгүй хариулах боломжгүй. Хувийн мессеж бичвэл хариулна.
```

Made from: matrix-eco-salon refusal_public_channel, unchanged · Same bytes as approved: yes

## `refusal_staff_schedule`

```text
Үсчдийн ажлын хуваарь, ирцийн мэдээлэл надад байхгүй. Та 7711-2233 эсвэл 9911-4455 дугаараар лавлана уу.
```

Made from: matrix-eco-salon refusal_staff_schedule; salon: only the phone numbers change; default: «Үсчдийн» became «Ажилтнуудын» · Same bytes as approved: no

## `refusal_topic`

```text
Уучлаарай, энэ талаар мэдээлэл өгөх боломжгүй. Та 7711-2233 эсвэл 9911-4455 дугаараар холбогдож лавлана уу.
```

Made from: matrix-eco-salon refusal_topic without its topic («хүүхдийн үйлчилгээний мэдээллийг»); answers every item of the client's 7.1 and 7.2 · Same bytes as approved: no

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

    --apply --sign-wording f2cbd3fb37bd --signed-by <your name>
