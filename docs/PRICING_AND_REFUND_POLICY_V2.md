# Laundry — fee, cancellation and refund decision policy v2

**Status:** design hypothesis pending Russian legal review and pilot unit economics. All ruble figures below are examples, not a live tariff.

## Quote lines
service_price, pickup_fee, delivery_fee, rush_fee, precise_time_fee, storage_fee, reattempt_fee, packaging_fee, inspection_fee, discount, tax_components. Every line stores source, tariff_version, quantity, unit, amount_kopeks, consent_id, actor, timestamps. No hidden surcharge.

## Service matrix
| Situation | Proposed fee | Eligibility | Required behavior |
|---|---:|---|---|
| Group pickup at advertised building window | 0 ₽ | supported building, eligible order | no fee line or explicit zero line |
| Group delivery at advertised building window | 0 ₽ | scheduled shared route | no fee |
| Individual pickup outside group window | +500 ₽ | available route capacity, customer consent | reserve capacity then confirm charge |
| Individual delivery outside group window | +500 ₽ | order ready, route feasible | separate quote and consent |
| Both individual pickup and delivery | +1000 ₽ illustrative | both independently feasible | separate lines, no double charging |
| Precise 30-min arrival window | TBD | courier capacity and SLA support | do not offer before supported |
| Night/weekend service | TBD | safe/legal hours, staffed capacity | do not offer by default |
| Rush laundry processing | TBD | partner explicit acceptance | no guarantee until accepted |
| Extra large/heavy bag | TBD | declared size/weight and labor safety | clear threshold and advance quote |
| Extra trip after customer no-show | TBD | documented attempt and disclosed policy | no fee without legal review |
| Extra trip after courier/service failure | 0 ₽ | operator/partner fault | waive fee and consider refund/compensation |
| Split delivery requested by customer | TBD | distinct dispatch tasks | consent and per-task pricing |
| Storage after prolonged noncollection | TBD | lawful disclosure and notice | not automatic; legal review |
| Rewash due to service defect | 0 ₽ | statutory remedy where applicable | no surcharge |

## Pricing transaction
1. Request quote with address, date, service, item/weight estimate and desired slot.
2. Price engine computes versioned quote with expiration, service lines and availability constraints.
3. Customer explicitly accepts exact amount and terms; store signed/verified acceptance event.
4. Slot capacity is atomically reserved, payment authorization/capture according to approved cash-register model.
5. If slot reservation fails, release authorization/void pending fee; never leave confirmed charge for impossible service.
6. After actual weight/partner inspection, create proposed delta; require acceptance when material terms change.
7. If customer declines, follow lawful return/cancellation path, not forced processing.

## Cancellation / failure policy matrix
| Fault/timing | Pickup fee | Delivery fee | Base service | Operational handling |
|---|---|---|---|---|
| Customer cancels before published cutoff, no work started | refund unrendered fee | refund unrendered fee | refund subject to lawful actual expenses | release capacity |
| Customer cancels after dispatch but before handoff | review actual documented costs and law | unrendered fee refunded | no invented penalty | return/abort |
| Courier misses confirmed paid pickup | full pickup fee refund | unaffected | rebook or lawful refund | operator incident |
| Courier misses confirmed paid delivery | unaffected | full delivery fee refund | customer remedy based on facts | rebook free |
| Partner delays readiness | unaffected | refund paid time-specific service if not provided | assess statutory remedies | updated ETA |
| Customer unavailable at agreed pickup | only lawful disclosed costs if applicable | unaffected | service not rendered | evidence of attempt |
| Customer unavailable at agreed delivery | unaffected | review lawful disclosed costs | completed processing remains chargeable as law allows | secure storage/reattempt |
| Item rejected before processing | adjust pickup only if independently rendered and lawful | refund undelivered service if not rendered | refund unrendered treatment | arrange return |
| Partial loss/damage | no automatic fee assumption | no automatic fee assumption | investigate statutory remedies | claim and compensation ledger |
| Duplicate charge | full duplicate reversal | full duplicate reversal | no double billing | reconcile provider |

## Settlement example (not business forecast)
Illustrative base price 1200 ₽ + off-schedule pickup 500 ₽ + off-schedule delivery 500 ₽ = 2200 ₽. Partner wholesale 600 ₽, courier variable 400 ₽, packaging 40 ₽, payment fee 55 ₽, claim reserve 35 ₽ → contribution margin 1070 ₽ before allocated fixed costs and tax effects. These invented inputs illustrate accounting fields only, not actual profitability.

## Finance rules
- Customer charges and partner payables use separate ledgers, each append-only.
- Capture/refund/credit-note webhooks are idempotent.
- Refund never exceeds net captured funds; compensation may be a separate payment with authorization.
- Claims, refunds and chargebacks can coexist; reserve against double payout.
- Client receipt and partner invoice are distinct documents with separate tax and legal entities.
- Pricing, refund and cancellation policies versioned, with effective dates and historical snapshots.
