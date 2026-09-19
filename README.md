# Phase 3 — Two-leg opportunity engine

Phase 3 extends the independently verified market state into complete cross-chain opportunity modeling.

## Why this exists

A cheaper buy quote on one chain does not prove arbitrage.

The economically relevant question is whether the WABIT acquired on the cheaper venue can be sold on the other venue for more WETH than was spent after:

- venue fees,
- price impact,
- WABIT transfer burn on Ethereum,
- RHC router behavior,
- partial fills/refunds,
- and eventually gas.

## Evaluated directions

For every configured WETH size:

### BUY_ETH_SELL_RHC

1. Model a WETH -> WABIT buy against the live Ethereum Uniswap V2 reserves.
2. Apply the canonical WABIT 1 bp transfer burn on pair -> trader output.
3. Quote selling that exact net WABIT amount through the live RHC TradeRouter.
4. Compare RHC WETH output with Ethereum WETH input.

If the RHC sell returns WABIT, the candidate is marked PARTIAL and no round-trip profit is claimed because inventory would be left unmatched.

### BUY_RHC_SELL_ETH

1. Quote WETH -> WABIT through the live RHC TradeRouter.
2. Use the router's actual `amountInUsed` as WETH cost.
3. Model selling the resulting WABIT into the live Ethereum pair.
4. Apply WABIT's 1 bp trader -> pair transfer burn before Uniswap V2 swap math.
5. Compare Ethereum WETH output with actual RHC WETH spent.

## Size sweep

Default:

```env
SWEEP_WETH=0.001,0.0025,0.005,0.01,0.02,0.05,0.1
```

`npm run scan` always performs a full sweep after market verification passes.

`npm run watch` performs the sweep on the verification cadence only when the public spread magnitude exceeds:

```env
OPPORTUNITY_TRIGGER_PCT=2
```

This keeps normal monitoring inexpensive.

## Gas

Phase 3 reads live gas prices from both chains.

Exact transaction gas usage depends on the concrete execution path, allowance state, account state, and router transaction. The public reference searcher therefore does not invent gas-unit constants.

Optional measured gas-unit inputs:

```env
ETH_BUY_GAS_UNITS=
ETH_SELL_GAS_UNITS=
RHC_BUY_GAS_UNITS=
RHC_SELL_GAS_UNITS=
```

When all four are configured, the searcher reports modeled net WETH P&L as:

```text
gross P&L
- Ethereum gas price × route gas units
- RHC gas price × route gas units
= modeled net P&L
```

Phase 4 will add transaction-level simulation before execution is ever considered.

## Status semantics

`VERIFIED_MARKET_STATE`

means the public feed has been independently reproduced from Ethereum and RHC RPC data.

Positive `gross` Phase 3 P&L means the modeled/quoted two-leg economics are positive before gas.

`NOT_SIMULATED`

means it is still not considered executable. Transaction simulation, balances, allowances, slippage limits, deadlines, and failure handling belong to Phase 4.

## Run

```bash
npm run check
npm run scan
```

Then:

```bash
npm run watch
```
