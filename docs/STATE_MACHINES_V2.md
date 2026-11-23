# Laundry — state machines v2

## Global contract
Each aggregate has state, state_version, updated_at. Commands require expected_version and idempotency_key; transactional changes append domain_event and outbox_event atomically. Reject illegal transitions with conflict and current state, never silently force them. Audit actor, scope, reason, request id, effective timestamp, evidence and previous/next states. Administrative override is a separate command with dual approval for custody/finance corrections.

## Order lifecycle
| From | Command | To | Actor | Guard / side effects |
|---|---|---|---|---|
| draft | confirm | confirmed | customer | valid address, quote, terms version, chosen service, slot |
| confirmed | reserve_pickup | scheduled | system | slot capacity committed atomically |
| scheduled | assign_pickup | pickup_assigned | dispatcher | courier shift active; route capacity |
| pickup_assigned | accept_handoff | picked_up | courier | intake manifest, bag scan, seal, customer receipt |
| picked_up | hub_receive | at_hub | hub | dual-party manifest reconciliation |
| picked_up/at_hub | partner_receive | partner_received | partner | receipt, seal and discrepancy checks |
| partner_received | inspect | inspection | partner | inspection record opened |
| inspection | propose_change | awaiting_approval | partner | quote/technology change persisted; no processing |
| awaiting_approval | approve_change | processing | customer | signed version of change, feasible capacity |
| inspection | start_processing | processing | partner | no unresolved critical discrepancies |
| processing | qc_start | quality_check | partner | startProcessing -> completeProcessing -> recordQualityCheck (batch in quality_check with complete_processing) |
| quality_check | pack | ready | partner | all accepted lines accounted for; QC passed |
| ready | dispatch | out_for_delivery | dispatcher | delivery route and custody confirmed |
| out_for_delivery | handover | delivered | courier | recipient proof; partial delivery tracked at item level |
| delivered | close | closed | system/operator | reconciliation and outstanding items accounted for; claims remain independent |
| confirmed/scheduled | cancel | cancelled | customer/operator | policy engine, refund/fee outcome and notification |
| any physical custody | exception | unchanged + incident | any authorized role | incident never erases lifecycle |
| any | mark_missing/damaged | unchanged + garment incident | partner/support | claim/custody investigation, no fabricated delivered status |

## Pickup task
unassigned→assigned→en_route→arrived→completed; alternate arrived→failed→reschedule_pending→assigned. Cancel before completion; no direct failed→completed without explicit new attempt.

## Delivery task
unassigned→assigned→en_route→arrived→completed; alternate arrived→recipient_unavailable→reattempt_pending. Partial delivery produces completed_with_exceptions and outstanding item tasks, never falsely completes all garments.

## Custody
with_customer→with_pickup_courier→at_hub→with_partner→at_hub/with_delivery_courier→delivered. Every arrow requires scan+handoff manifest and receiving actor; missing counterpart scan creates pending_handoff exception. A damaged seal triggers custody_disputed overlay, not rewriting location.

## Garment
declared→accepted→inspected→approved_for_processing→processing→quality_checked→packed→delivered. Exceptions: rejected_before_processing, missing_reported, damaged_reported, returned_unprocessed. Garment location/owner separate from treatment state.

## Payment
initiated→authorized→captured; captured→partially_refunded→refunded; captured→disputed→chargeback_won/chargeback_lost. Webhook deduplication on provider event ID; refund cannot exceed refundable captured balance. Refund and chargeback racing requires financial hold and reconciliation.

## Partner payable
estimated→accrued→reconciliation_pending→approved→scheduled_for_payment→paid. disputed at accrued/reconciliation_pending; adjustments via immutable credit/debit note. No deletion of paid records.

## Claim
opened→triage→investigating→decision_pending→resolved or denied_with_reason. Reopen creates revision/review, retains earlier outcome. Claim legal hold is independent of delivery/closed.

## Slot exception
requested→quoted→awaiting_consent→capacity_held→confirmed→fulfilled. quote_expired/cancelled/failed branches. Never capture surcharge before feasible capacity and acceptance of final fee; if authorized before reservation, release on failure.

## Invariants to test
- No duplicate physical handoff, charge, fee or payout from retries.
- No process start while awaiting approval.
- No closed order with unaccounted physical items; a closed order may still have an active claim.
- No order state derived from payment state alone.
- No physical custody handoff without evidence or explicit exception.
- Each state transition has exactly one domain event and auditable actor.
- Claim outcome cannot erase original evidence or customer statutory rights.
