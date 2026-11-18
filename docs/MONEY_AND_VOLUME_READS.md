# Денежные и объёмные разрезы (Money & Volume Reads)

Три read-only эндпоинта, которые отвечают на вопросы, которые продукт до сих пор не умел
отвечать: **сколько нам должны клиенты**, **сколько должны мы прачечным**, **сколько вещей и
какого веса мы фактически приняли**.

Все три — проекции живых строк тенанта. Ничего не кэшируется, ничего не оценивается и ничего не
придумывается: пустой тенант показывает нули, а не правдоподобное демо-значение.

---

## Денежные соглашения

Деньги в системе — целые копейки. Знаковые соглашения едины для всех трёх разрезов:

| Понятие | Определение |
|---|---|
| Выставлено | Сумма счёта (`customer_invoices.total_kopeks`), счёт в состоянии `cancelled` не учитывается |
| Собрано | `captured − возвраты` по платёжным намерениям в состояниях `captured / partially_refunded / refunded` |
| К оплате (дебиторка) | `max(0, выставлено − собрано)` по каждому счёту |
| Переплата (кредит клиента) | `max(0, собрано − выставлено)` — мы должны клиенту |
| Начислено прачечной | Сумма `partner_service_accruals` |
| Оспорено | Начисления, у которых `disputed = true` — они **не** входят в кредиторку |
| К выплате | `max(0, начислено − оспорено − выплачено)` |
| Вклад | `собрано − себестоимость прачечной`. Это **не прибыль**: в системе нет учёта стоимости курьера, и подпись об этом стоит рядом с каждой цифрой |

Возврат никогда не уводит дебиторку в минус: он создаёт кредит клиента, а не уменьшает долг
ниже нуля.

---

## `GET /finance/analytics`

Роли: `platform_finance`, `platform_admin`. Возвращает:

```
receivables: {
  invoicedKopeks, netCollectedKopeks, refundedKopeks,
  receivableKopeks, creditKopeks, invoiceCount,
  aging: [ { key, label, invoiceCount, receivableKopeks } ],   // до 7 / 8–30 / 31–90 / 90+ дней
  openInvoices: [ { invoiceNumber, publicNumber, customerName, ... } ],
  topDebtors: [ { customerId, customerName, customerPhone, receivableKopeks, invoiceCount } ]
}
payables: {
  accruedKopeks, estimatedKopeks, invoicedKopeks, disputedKopeks, paidKopeks, payableKopeks,
  partners: [ { partnerId, partnerName, accruedKopeks, invoicedKopeks, estimatedKopeks,
                disputedKopeks, paidKopeks, payableKopeks } ]
}
margin: { netCollectedKopeks, partnerCogsKopeks, contributionKopeks, takeRate, note }
exposure: { adjustmentsPendingConsentKopeks, compensationsProposedKopeks,
            compensationsApprovedKopeks, chargebackAtRiskKopeks }
monthly: [ { month, invoicedKopeks, netCollectedKopeks } ]       // последние 12 месяцев
```

`exposure` — это деньги, которые уже не в выручке, но ещё не решены:

- **доплаты без согласия** — предложенные, но не подтверждённые клиентом корректировки. Их
  нельзя списать автоматически: по операционному контракту реальный вес даёт только
  *предложение* доплаты с явным согласием клиента;
- **компенсации к выплате** — одобренные, но ещё не выданные;
- **оспоренные платежи** — намерения в состоянии `disputed` / `chargeback_lost`.

## `GET /customer/finance`

Роль: `customer`. Разрез жёстко ограничен `principal.userId` и тенантом вызывающего. Другая роль
получает 403, а не пустую сводку.

```
totals: { orderCount, chargedKopeks, netPaidKopeks, refundedKopeks, outstandingKopeks,
          creditKopeks, averageOrderKopeks, sharedWindowSavingsKopeks }
byService: [ { serviceId, serviceName, unit, tier, orderCount, quantity, amountKopeks } ]
byTier:    [ { tier, orderCount, amountKopeks } ]
orders:    [ { orderId, publicNumber, lifecycleState, createdAt, invoiceNumber,
                chargedKopeks, netPaidKopeks, refundedKopeks, outstandingKopeks,
                sharedWindowSavingsKopeks } ]
```

`sharedWindowSavingsKopeks` — сколько клиент сэкономил, взяв общий групповой слот вместо
внепланового забора и доставки. Считается из строк счёта: нога с `source = tariff` и нулевой
суммой — это групповое окно, и avoided-сумма берётся из тарифной версии заказа.

## `GET /ops/item-mix?days=90`

Роли: `dispatcher`, `platform_finance`, `platform_admin`, `laundry_operator` (только свой заказ).

Ответ здесь **намеренно разный для двух тарифов**, потому что разный и смысл:

```
categories:   [ { category, itemCount, orderCount, rawCategories } ]  // только «Защищённый»
garmentStatus:[ { status, count } ]
tierSplit: {
  protected: { orderCount, itemCount },      // поштучная опись существует
  economy:   { orderCount, receivedGrams, quotedGrams }   // объём меряется весом
}
weight: { quotedGrams, receivedGrams, deltaGrams,
          ordersWithOverReceipt, ordersWithUnderReceipt, ordersWithIntake }
daily: [ { date, itemCount, receivedGrams, orderCount } ]
topVariance: [ { orderId, publicNumber, quotedGrams, receivedGrams, deltaGrams, itemCount } ]
note: string
```

### Почему по «Эконом» нет числа футболок

Тариф «Эконом» **обещает отсутствие поштучной описи**: клиент отдаёт закрытый, опломбированный
и взвешенный мешок. Считать «футболки» по такому заказу нельзя — это противоречило бы и тарифу,
и оферте, и обещанию перед клиентом. Поэтому:

- по «Защищённому» — реальные количества вещей по категориям;
- по «Эконом» — **вес**, потому что вес и есть единица объёма;
- `weight.deltaGrams` — расхождение между посчитанным в смете и принятым на весах весом. Это
  единственная финансово значимая величина для эконом-заказа, и она **не списывается
  автоматически**: расхождение порождает предложение доплаты, на которое клиент должен
  согласиться.

### Нормализация категорий

`garments.category` — свободный текст. Значения приводятся к управляемому словарю
(`normalizeCategory` в `src/services/item-mix.ts`): синонимы (`Футболки`, `T-shirt`, `tee`)
сворачиваются в одну категорию, всё незнакомое попадает в `прочее`. Исходные значения всегда
сохраняются в `rawCategories`, чтобы словарь можно было расширять по реальным данным, а не по
догадкам.

---

## Демо-книга

`npm run db:seed` (и `POST /api/v1/dev/seed` в preview-профиле) больше не оставляет тенант пустым.
Помимо каталога, тарифа и персон создаётся **книга заказов**: 14 заказов, 4 клиента, счета,
оплаты, частичный возврат, претензия с одобренной компенсацией, а также заказы в разных
состояниях — ждут забора, в обработке, доставлены без оплаты.

Книга создаётся **настоящими доменными сервисами** (котирование → заказ → резерв слота →
назначение курьера → приёмка → передача прачечной → обработка → ОТК → доставка → счёт →
оплата → закрытие), а не прямыми вставками в SQL. Ни один инвариант не обходится.

Меняются только **время показа**: заказы, манифесты, счета, платежи и возвраты растягиваются на
последние два месяца, чтобы графики показывали не один день. Журналы проводок не трогаются —
они append-only.

Каждая сценария имеет стабильный ключ идемпотентности, поэтому повторный запуск **переигрывает**
сценарии, а не дублирует их.
