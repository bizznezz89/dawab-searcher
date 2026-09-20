# Phase 5E.2 — Live hot path

Phase 5E.2 removes local fork startup from the live opportunity path.

## Cold path vs hot path

### Cold / development path

Paper mode retains the expensive proof stack:

```text
Phase 3 optimize
→ Ethereum Anvil fork
→ RHC Forge fork
→ Phase 5 cold paper gate
→ bootstrap fork proof
```

Use this for development, route changes, contract changes, and lifecycle
validation.

### Live hot path

When:

```env
MODE=live
ENABLE_EXECUTION=true
```

the watcher does **not** launch Anvil or Forge.

The live path is:

```text
fresh public feed + direct RPC verification
→ Phase 3 optimize
→ assert signer
→ fresh route/capacity check
→ inspect wallet
→ auto-wrap exact WETH shortfall if needed
→ auto-approve only if needed
→ fresh route verification again
→ exact static-call both live routes
→ exact estimateGas() both live routes
→ fresh gas prices
→ derive automatic protection
→ final protected static-call + exact estimateGas
→ RHC protected sell
→ Ethereum protected hedge
```

## Why this is faster

The old live attempt inherited development validation and started:

```text
anvil
forge
```

inside the opportunity cycle.

That produced multi-minute stale cycles.

Phase 5E.2 removes both subprocesses from live mode entirely.

## Gas

There is no manual gas-unit profile in the live path.

The executor uses:

```text
provider.getFeeData()
contract.method.estimateGas(...)
```

for the actual current calls.

A 25% gas-limit headroom is applied to the estimates.

The only fixed gas number remaining is a pre-bootstrap **native-ETH reserve
guard** of 500,000 gas units per chain. It is not used to calculate trade
profit. Its only purpose is to prevent the autowrapper from consuming native
ETH that may be needed before exact post-bootstrap swap gas can be estimated.

## Autowrapper

If Ethereum WETH is short:

```text
required WETH
- current WETH
= exact wrap amount
```

Only the shortfall is wrapped.

If the wallet is already funded, no wrapping occurs.

## Approvals

Approvals are idempotent:

```text
Ethereum WETH → Uniswap V2 Router02
RHC WABIT     → ReLaunchTradeRouter
```

`MaxUint256` is used only when the current allowance is insufficient.

## Bootstrap economics

Before sending a wrap or approval, the live executor estimates those setup
transactions and refuses bootstrap if their maximum estimated fee is greater
than or equal to the current gross arbitrage edge.

After any bootstrap transaction mines, the original market decision is thrown
away and the market is revalidated from scratch.

## Protection

Protection is derived from **padded current live gas estimates**, not historical
Phase 4 gas.

The existing policy remains:

```text
retain at least 50% of fresh modeled net
```

The final protected calls are then static-called and estimated again.

If final maximum gas exposure would weaken protected net below the retained
floor, no swap is broadcast.

## Transaction order

The capacity-sensitive RHC leg remains first:

```text
RHC WABIT → WETH
then
Ethereum WETH → WABIT
```

If RHC fails, Ethereum is untouched.

If RHC succeeds, the Ethereum leg becomes a mandatory hedge.

## Ctrl+C semantics

Before the first RHC swap broadcast:

```text
Ctrl+C → operator abort accepted
       → no swap is broadcast
       → process exits after current safe await returns
```

After the RHC transaction has been broadcast:

```text
Ctrl+C → stop request remembered
       → Ethereum hedge is still attempted
       → process exits after committed hedge sequence
```

This prevents an operator interrupt from deliberately stranding a one-legged
cross-chain trade.

## First-live one-shot latch

The first-deployment safety latch remains.

A process gets at most one live execution attempt:

```text
Live one-shot latch: ARMED
→ attempt starts
Live one-shot latch: CONSUMED
```

Restarting the process is required for another attempt.

## Apply

Extract this delta over the repository.

Then:

```bash
npm run check
```

The user's local `.env` controls the mode. No `.env` file is included in this
delta.

For cold paper validation:

```env
MODE=paper
ENABLE_EXECUTION=false
```

For the one-shot hot live executor:

```env
MODE=live
ENABLE_EXECUTION=true
```

`EXECUTOR_ADDRESS` and `EXECUTOR_PRIVATE_KEY` must be populated only in the
ignored local `.env`.
