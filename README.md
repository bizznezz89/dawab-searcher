# Phase 5A — Autonomous paper execution gate

Phase 5A converts the existing continuous watcher into a deterministic paper
execution agent.

It does not require a wallet address, private key, signing provider, manual
slippage value, or any new `.env` setting.

It does not broadcast transactions.

## Flow

The existing `npm run watch` loop now performs:

```text
public feed
    ↓
independent Ethereum + RHC verification
    ↓
Phase 3 directional sweep + optimizer
    ↓
positive supported opportunity?
    ↓ yes
Phase 4 hybrid fork execution
    ↓
fresh public feed + fresh independent RPC reads
    ↓
re-evaluate the SAME Phase 4 trade size
    ↓
fresh gas prices × Phase 4 measured gas units
    ↓
fresh gas-adjusted net
    ↓
WOULD_EXECUTE or SKIP
```

## Why Phase 5A re-reads the market

Phase 4 takes several seconds because it executes both legs against forks.

The market may move during that time.

Phase 5A therefore does not treat the original optimizer snapshot as the final
paper decision. After Phase 4 succeeds it fetches a new public state, performs
new independent Ethereum and RHC verification, recalculates the Ethereum output
for the exact Phase 4 input size, requotes that WABIT amount on the deployed
RHC TradeRouter, fetches fresh gas prices, and recalculates net P&L.

## Current paper gate

`WOULD_EXECUTE` currently requires:

- the refreshed public feed still independently verifies;
- the route is still the active RHC BondingCurve route proven by Phase 4;
- the refreshed Ethereum output fits inside current conservative RHC sell
  capacity;
- the RHC quote is a full fill with no refund;
- fresh gross profit is positive after the measured Phase 4 gas units are
  repriced at current gas prices.

Otherwise the action is `SKIP`.

## Deliberately not included yet

Phase 5A is not the final live-execution gate.

It does not yet:

- derive production `amountOutMin` values;
- sign transactions;
- broadcast transactions;
- manage a private key;
- inspect live execution-wallet inventory or allowances;
- execute the reverse RHC -> Ethereum direction.

Those belong in later Phase 5 hardening after the autonomous paper gate is
stable.

## Run

No new command is required:

```bash
npm run watch
```

When a positive supported opportunity is found, the watcher automatically runs
Phase 4 and Phase 5A.

The terminal will show either:

```text
PAPER ACTION:           WOULD_EXECUTE
Signing:                DISABLED
Broadcast:              DISABLED
```

or a `SKIP` reason.

`ENABLE_EXECUTION=true` remains rejected by configuration.
