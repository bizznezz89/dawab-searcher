# Phase 4 — Hybrid fork execution simulation

Phase 4 executes the currently profitable cross-chain route against forked
live state without broadcasting any public-chain transactions.

## Engines

- Ethereum leg: Anvil fork
- RHC leg: Forge fork

RHC intentionally uses Forge because the Robinhood Chain bridged WABIT proxy
executes correctly in Forge fork tests but did not execute reliably through the
temporary Anvil RHC fork.

## Requirements

- Existing Phase 3 searcher is green.
- `anvil` is on PATH.
- `forge` is on PATH.
- `ETHEREUM_RPC_URL` is a working Ethereum mainnet endpoint.
- `RHC_RPC_URL` is a working Robinhood Chain mainnet endpoint.
- No new `.env` variables are required.

The Forge harness is self-contained under:

```text
forge/rhc-sim/
```

It does not depend on the separate `relaunchpad` repository.

## Run

```bash
npm run check
npm run simulate
```

## Execution flow

1. Verify the public market feed independently.
2. Re-run the Phase 3 sweep and optimizer.
3. Start an Ethereum Anvil fork.
4. Execute the optimized WETH -> WABIT buy through canonical Uniswap V2.
5. Record the actual WABIT balance delta and Ethereum receipt gas.
6. Stop the Ethereum fork.
7. Pass that exact raw WABIT amount to the Forge RHC harness.
8. Forge forks current RHC mainnet state.
9. Seed a fork-only trader from the known WABIT genesis inventory source.
10. Approve the deployed ReLaunchTradeRouter on the fork.
11. Quote that exact WABIT input against the live bonding curve.
12. Execute WABIT -> WETH through the deployed TradeRouter.
13. Verify the recipient WETH delta equals the router output.
14. Measure the deployed router-call gas.
15. Apply a conservative maximum intrinsic-calldata allowance to model a
    complete RHC EOA transaction.
16. Apply the current Phase 3 gas prices.
17. Report executed-fork gross profit and modeled gas-adjusted net profit.

## Gas accounting

Ethereum uses the actual fork transaction receipt `gasUsed`.

Forge measures the RHC deployed router-call execution. The searcher then adds:

```text
21,000 base intrinsic gas
+ max 16 gas × 196 calldata bytes
= 24,136 gas
```

This is intentionally conservative because real ABI calldata contains zero
bytes, which cost less than 16 gas each. The Forge external-call measurement
also contains a small call overhead that a direct EOA transaction does not.

Setup operations remain excluded from recurring arbitrage gas:

- wrapping fork ETH into WETH,
- fork-only RHC inventory seeding,
- ERC-20 approvals.

Production assumes pre-positioned inventory and reusable allowances.

## Safety

No `--broadcast` flag is used.

Both fork legs use `amountOutMin = 0` only inside isolated simulation state.
Live execution must use fresh quotes and slippage-protected minimum outputs.

Phase 4 currently implements only:

```text
BUY ETH -> SELL RHC
```

If the profitable direction flips, the simulator stops rather than pretending
the reverse route has been validated.
