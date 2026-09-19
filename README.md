# DaWabLauncher Reference Searcher

Open-source reference searcher for DaWabLauncher.

The project is designed to independently detect, verify, simulate, and eventually support opt-in execution of cross-chain WABIT opportunities between Ethereum and Robinhood Chain.

## Safety model

- Paper mode is the default.
- No trading capital is supplied by DaWabLauncher.
- No private keys are required for Phases 1–2.
- Phases 1–2 do not broadcast transactions.
- A public market signal is not treated as proof of executable profit.
- Searchers bring their own infrastructure, inventory, RPCs, and risk controls.

## Configuration

Copy `.env.example` to `.env`.

Robinhood Chain has an official public RPC configured by default.

Bring your own Ethereum RPC provider. Common choices include Infura, Alchemy, and Tatum.

Never commit `.env`.

## Phase 1 — public feed reader

The scanner consumes:

`https://dawabit.tech/searcher/state.json`

It validates Searcher Beacon schema `0.3`, checks freshness, and reports the public same-notional 0.01 WETH comparison.

## Phase 2 — independent RPC verification

Phase 2 no longer trusts the public feed as sufficient proof.

It independently queries:

### Ethereum

- chain ID and current block
- canonical WABIT/WETH pair
- pair token ordering
- pair factory
- live reserves
- Uniswap V2 0.30% fee math
- WABIT 0.01% transfer burn
- net WABIT acquired for the same 0.01 WETH input

### Robinhood Chain

- chain ID and current block
- live DaWabLauncher TradeRouter
- `quoteExactInput(RHC-WETH, WABIT, 0.01 WETH)`
- active venue
- amount consumed
- WABIT output
- refund amount

The independently calculated outputs are compared with the public Searcher Beacon. A small configurable tolerance accounts for state changing between the website snapshot and independent RPC reads.

A Phase 2 `PASS` means:

`VERIFIED_MARKET_STATE`

It does **not** yet mean:

`EXECUTABLE_ARBITRAGE`

That requires opposite-leg verification, gas, sizing, inventory, and net P&L work in Phase 3.

## Commands

One full scan with independent verification:

```bash
npm run scan
```

Continuous monitoring:

```bash
npm run watch
```

The public state feed is read every 5 seconds by default. Independent RPC verification runs every 60 seconds by default so the reference searcher does not unnecessarily hammer RPC providers.

Type-check:

```bash
npm run check
```

## Roadmap

### Phase 1
Read and validate DaWabLauncher public state.

### Phase 2
Independently query Ethereum and Robinhood Chain and verify the public market state.

### Phase 3
Verify both directional execution legs, optimize trade sizing, estimate gas, and calculate gross/net P&L.

### Phase 4
Simulate both execution legs before any transaction is allowed.

### Phase 5
Optional bring-your-own-wallet live execution behind explicit safety gates.

## Execution model

Cross-chain arbitrage is expected to use pre-positioned inventory on both chains. Bridging is inventory rebalancing, not part of an atomic trade.

Example when RHC is cheaper:

1. Buy WABIT on RHC using pre-positioned RHC-WETH.
2. Sell pre-positioned WABIT on Ethereum.
3. Rebalance inventory separately when appropriate.

## License

Not yet selected.
