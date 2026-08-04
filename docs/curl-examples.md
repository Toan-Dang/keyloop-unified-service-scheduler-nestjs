# cURL examples

The client layer is stubbed by the OpenAPI contract (`openapi.yaml`, served at
<http://localhost:3000/docs>) plus the commands below. Every id here comes from the seed fixture
(`prisma/seed.ts`), so these run as-is after `npm run db:migrate && npm run db:seed`.

## Authentication (stubbed)

Auth is a documented stub (§14, R-4) — the seam a real IdP plugs into. The token is a base64url
JSON claims blob; **the dealership comes from it and from nowhere else**, which is what makes
"out-of-tenant reference → 404" true by construction.

```bash
export BASE=http://localhost:3000/v1

# Service advisor (STAFF) at the seeded dealership.
export STAFF=$(printf '%s' \
  '{"dealershipId":"01900000-0000-7000-8000-00000000d001","role":"STAFF"}' \
  | basenc --base64url -w0 | tr -d '=')

# Self-service customer — reads are further restricted to their own rows.
export CUSTOMER=$(printf '%s' \
  '{"dealershipId":"01900000-0000-7000-8000-00000000d001","role":"CUSTOMER","customerId":"01900000-0000-7000-8000-00000000ee01"}' \
  | basenc --base64url -w0 | tr -d '=')
```

## Reference data

```bash
curl -s $BASE/dealerships   -H "Authorization: Bearer $STAFF" | jq
curl -s $BASE/service-types -H "Authorization: Bearer $STAFF" | jq
curl -s $BASE/technicians   -H "Authorization: Bearer $STAFF" | jq
curl -s $BASE/service-bays  -H "Authorization: Bearer $STAFF" | jq
```

Note in the technician list that only **Binh Tran** holds `brakes`. That single fact is what makes
the concurrency proof meaningful.

## Availability preview (advisory)

```bash
# Brake Inspection on Monday 7 Sep 2026 (dealership-local date).
curl -s -G $BASE/availability \
  -H "Authorization: Bearer $STAFF" \
  --data-urlencode 'serviceTypeId=01900000-0000-7000-8000-00000000cc02' \
  --data-urlencode 'date=2026-09-07' \
  --data-urlencode 'granularityMinutes=30' | jq
```

`bookable` is `min(free technicians, free bays)` — **not** the number of candidate pairs. Brake
Inspection reports `1` (one qualified technician); Oil Change reports `2`.

This is advisory: the authoritative decision happens at `POST` time under the exclusion
constraint, so a slot shown here can still come back `409`.

## Book an appointment

```bash
curl -i -X POST $BASE/appointments \
  -H "Authorization: Bearer $STAFF" \
  -H 'Idempotency-Key: demo-key-001' \
  -H 'Content-Type: application/json' \
  -d '{
        "customerId":     "01900000-0000-7000-8000-00000000ee01",
        "vehicleId":      "01900000-0000-7000-8000-00000000ff01",
        "serviceTypeId":  "01900000-0000-7000-8000-00000000cc02",
        "desiredStartTime": "2026-09-07T02:00:00Z"
      }'
```

`201`, with the technician and bay the system allocated. There is no `dealershipId` in the body
and no end time — the tenant comes from the token and the duration from the service type.

**Retry it verbatim** and you get the same `201` with the same appointment id, not a duplicate:

```bash
# ...identical command, same Idempotency-Key => the original appointment, unchanged.
```

**Reuse the key with a different body** and it is rejected rather than silently replaying:

```bash
curl -i -X POST $BASE/appointments \
  -H "Authorization: Bearer $STAFF" \
  -H 'Idempotency-Key: demo-key-001' \
  -H 'Content-Type: application/json' \
  -d '{"customerId":"01900000-0000-7000-8000-00000000ee01",
       "vehicleId":"01900000-0000-7000-8000-00000000ff01",
       "serviceTypeId":"01900000-0000-7000-8000-00000000cc01",
       "desiredStartTime":"2026-09-07T02:00:00Z"}'
# => 422 IDEMPOTENCY_KEY_REUSE
```

## See the invariant reject a double-booking

With the appointment above in place, book the same window with a **new** key:

```bash
curl -i -X POST $BASE/appointments \
  -H "Authorization: Bearer $STAFF" \
  -H 'Idempotency-Key: demo-key-002' \
  -H 'Content-Type: application/json' \
  -d '{"customerId":"01900000-0000-7000-8000-00000000ee02",
       "vehicleId":"01900000-0000-7000-8000-00000000ff02",
       "serviceTypeId":"01900000-0000-7000-8000-00000000cc02",
       "desiredStartTime":"2026-09-07T02:00:00Z"}'
# => 409 NO_AVAILABILITY
```

### The race, from a shell

Twenty simultaneous bookings for the one contested slot — exactly one `201`:

```bash
seq 1 20 | xargs -P 20 -I{} curl -s -o /dev/null -w '%{http_code}\n' \
  -X POST $BASE/appointments \
  -H "Authorization: Bearer $STAFF" \
  -H 'Idempotency-Key: race-{}' \
  -H 'Content-Type: application/json' \
  -d '{"customerId":"01900000-0000-7000-8000-00000000ee01",
       "vehicleId":"01900000-0000-7000-8000-00000000ff01",
       "serviceTypeId":"01900000-0000-7000-8000-00000000cc02",
       "desiredStartTime":"2026-09-08T02:00:00Z"}' \
  | sort | uniq -c
#       1 201
#      19 409
```

Note the **new date** — reuse a window that is already taken and you will (correctly) get twenty
`409`s and prove nothing.

## Read and list

```bash
curl -s $BASE/appointments/<id> -H "Authorization: Bearer $STAFF" | jq

# Keyset pagination — pass the previous response's nextCursor back as ?cursor=
curl -s -G $BASE/appointments -H "Authorization: Bearer $STAFF" \
  --data-urlencode 'limit=2' | jq '{items: [.items[].id], nextCursor}'

curl -s -G $BASE/appointments -H "Authorization: Bearer $STAFF" \
  --data-urlencode 'limit=2' --data-urlencode 'cursor=<nextCursor>' | jq

# Filters
curl -s -G $BASE/appointments -H "Authorization: Bearer $STAFF" \
  --data-urlencode 'status=CONFIRMED' \
  --data-urlencode 'from=2026-09-07T00:00:00Z' \
  --data-urlencode 'to=2026-09-08T00:00:00Z' | jq
```

A **CUSTOMER** token sees only its own rows, even without a filter:

```bash
curl -s $BASE/appointments -H "Authorization: Bearer $CUSTOMER" | jq '.items | length'
```

## Cancel (idempotent)

```bash
curl -i -X POST $BASE/appointments/<id>/cancel \
  -H "Authorization: Bearer $STAFF" \
  -H 'Content-Type: application/json' \
  -d '{"reason":"Customer rescheduled"}'
# => 200, status CANCELLED

# Run it again — still 200. A retried cancel is a success, not a conflict.
# 404 happens only when the id does not exist in your dealership.
```

The slot is free for re-booking the instant this commits, because both exclusion constraints are
partial on `status = 'CONFIRMED'`.

## Tenant isolation

```bash
# A service type that exists — but belongs to the other seeded dealership.
curl -i -X POST $BASE/appointments \
  -H "Authorization: Bearer $STAFF" \
  -H 'Idempotency-Key: cross-tenant-demo' \
  -H 'Content-Type: application/json' \
  -d '{"customerId":"01900000-0000-7000-8000-00000000ee01",
       "vehicleId":"01900000-0000-7000-8000-00000000ff01",
       "serviceTypeId":"01900000-0000-7000-8000-00000000cc99",
       "desiredStartTime":"2026-09-07T02:00:00Z"}'
# => 404 NOT_FOUND — identical to a row that does not exist anywhere. Never 403:
#    a different status would confirm the row exists somewhere, which is the leak.
```

Trying to name your own tenant is rejected outright rather than quietly ignored:

```bash
curl -i -X POST $BASE/appointments \
  -H "Authorization: Bearer $STAFF" -H 'Idempotency-Key: k' -H 'Content-Type: application/json' \
  -d '{"dealershipId":"01900000-0000-7000-8000-00000000d002", "customerId":"...", ...}'
# => 400 VALIDATION_ERROR
```

## Operational endpoints

```bash
curl -s http://localhost:3000/health | jq   # liveness
curl -s http://localhost:3000/ready  | jq   # readiness: DB hard-dep, Redis reported but non-fatal
curl -s http://localhost:3000/metrics | grep -E '^booking_|^outbox_'
```

Stop Redis (`docker compose stop redis`) and `/ready` reports `degraded` with a `200` — bookings
keep working, because Redis is not in the correctness path.
