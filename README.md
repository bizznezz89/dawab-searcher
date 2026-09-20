# Phase 5E.1 — First-live safety lock

This delta hardens the integrated Phase 5E executor before the first public
transaction.

## One live attempt per process

`npm run watch` may make at most one autonomous live-execution attempt during
that process.

After the attempt begins:

```text
Live one-shot latch: CONSUMED
```

No second opportunity can submit another trade until the operator explicitly
stops and restarts the process.

This is intentionally temporary. Multi-trade unattended operation will be
enabled only after the persistent execution journal and durable circuit breaker
exist.

## Exact live gas-profit preflight

Immediately before the first RHC swap, after any automatic wrap/approval and
after the fresh post-bootstrap paper gate, Phase 5E now:

```text
static-preflights protected RHC sell
static-preflights protected Ethereum buy
estimateGas() exact RHC swap
estimateGas() exact Ethereum swap
reads fresh gas prices on both chains
```

It then requires:

```text
protected net using exact live gas estimates
    >= Phase 5B retained-profit floor

AND

protected net assuming both 25%-padded gas limits are fully consumed
    > 0
```

If either condition fails, no swap is submitted.

## Canonical `.env`

The obsolete manual `GAS CALIBRATION` section has been removed from
`.env.example`.

The live executor obtains current gas price and exact transaction gas estimates
programmatically.

## First live deployment

Do not add the private key until this delta compiles and passes another paper
run.

Safe state:

```env
MODE=paper
ENABLE_EXECUTION=false
EXECUTOR_ADDRESS=0x981FB95d4101D1F6238456b680cCa1fa818e86a4
EXECUTOR_PRIVATE_KEY=
```

Then:

```bash
npm run check
npm run watch
```

Only after that remains green should the local private key be populated and the
two live gates intentionally enabled.
