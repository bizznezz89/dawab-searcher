# DaWabLauncher Reference Searcher

Open-source reference searcher for DaWabLauncher.

The project is designed to independently detect, verify, simulate, and eventually support opt-in execution of cross-chain WABIT opportunities between Ethereum and Robinhood Chain.

## Safety model

- Paper mode is the default.
- No trading capital is supplied by DaWabLauncher.
- No private keys are required for Phase 1.
- Phase 1 does not broadcast transactions.
- A public market signal is not treated as proof of executable profit.
- Searchers bring their own infrastructure, inventory, RPCs, and risk controls.

## Phase 1 — public feed reader

Phase 1 consumes:

`https://dawabit.tech/searcher/state.json`

It validates Searcher Beacon schema `0.3`, checks freshness, and reports the same-notional 0.01 WETH market comparison.

Run one scan:

```bash
npm run scan
```

Watch continuously:

```bash
npm run watch
```

Type-check:

```bash
npm run check
```

## Roadmap

### Phase 1
Read and validate DaWabLauncher public state.

### Phase 2
Independently query Ethereum and Robinhood Chain and verify both sides of the market.

### Phase 3
Optimize trade sizing and estimate gas / gross / net P&L.

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
