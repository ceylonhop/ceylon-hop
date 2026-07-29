# Payment evidence migration runbook

Applies to migration `0024_married_ricochet.sql`.

## Preflight

Run these read-only counts against the target database before applying the migration:

```sql
select count(*) as payment_rows from payments;

select status, count(*)
from payments
group by status
order by status;
```

Record the payment count and succeeded count in the deployment log. Existing payment rows do
not yet carry gateway evidence; the new gateway ID therefore starts null for every historical
row and cannot conflict with its additive unique key.

## Apply and verify

Apply migrations before deploying code that writes `payment_events`. Then verify:

```sql
select count(*) from payment_events;

select count(*) as succeeded_without_legacy_evidence
from payments
where status = 'succeeded'
  and (settled_at is null or settlement_source <> 'legacy_backfill');

select count(*) as missing_updated_at
from payments
where updated_at is null;

select provider, gateway_payment_id, count(*)
from payments
where gateway_payment_id is not null
group by provider, gateway_payment_id
having count(*) > 1;
```

Immediately after migration, the event count may be zero. The remaining queries must return
zero counts or zero rows.
Historical succeeded rows deliberately use `created_at` as the estimated settlement timestamp
and `legacy_backfill` as its provenance. The migration does not claim this is a gateway receipt
time.

## Forward-fix rollback

Do not drop `payment_events`, evidence columns, or financial history. If the application release
must be rolled back, redeploy the previous application version; the additive nullable columns and
unused table are backward compatible.

If the new event writer is faulty, disable that writer in a forward application fix and retain
all rows for reconciliation. Correct malformed evidence with an audited forward data migration.
Never delete or rewrite accepted event history as a rollback mechanism.
