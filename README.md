# DaWab Searcher — Phase 6 Autonomous Production Loop

DaWab Searcher is the reference execution searcher for the DaWabLauncher
Searcher Kit.

Phase 6 keeps the proven Phase 5E.2 hot executor, removes the temporary
one-trade process latch, and adds durable execution safety for continuous live
operation.

## Operating modes

The operator still changes only the searcher mode.

### Paper / cold validation

```env
MODE=paper
ENABLE_EXECUTION=false
```

Paper mode keeps the full development proof stack:

```text
public state.json
→ independent Ethereum + RHC verification
→ opportunity sweep / optimizer
→ Ethereum Anvil fork
→ RHC Forge fork
→ protected paper gate
→ fork bootstrap proof
```

Paper mode never signs or broadcasts.

### Live / autonomous hot path

```env
MODE=live
ENABLE_EXECUTION=true
```

Live mode does not launch Anvil or Forge.

```text
direct Ethereum + RHC RPC reads
→ optional public-feed cross-check
→ opportunity sweep / optimizer
→ persistent attempt journal
→ signer / wallet / allowance checks
→ direct route + capacity revalidation
→ exact live staticCall + estimateGas
→ protection envelope
→ final exact preflight
→ protected RHC sell
→ mandatory Ethereum hedge
→ journal result
→ fresh market read on the next loop
```

After a successful trade, the prior candidate is discarded. The next loop
re-reads both chains and re-optimizes from current state before another trade
can execute.

## Public `state.json` is advisory in live mode

The public DaWabLauncher state feed is still fetched and cross-checked when
available, but it is no longer an execution dependency.

If the feed returns a temporary 502, times out, is stale, or disagrees with
fresh chain state:

```text
LIVE:
state.json unavailable/mismatch
→ log advisory status
→ continue from direct Ethereum + RHC RPC state

PAPER:
state.json remains required
```

Direct RPC state is the live execution authority.

## Durable execution journal

Phase 6 writes local runtime state under:

```text
.dawab/execution-state.json
.dawab/execution-journal.jsonl
```

`.dawab/` is gitignored.

The state file tracks:

```text
circuit-open status
circuit reason
in-flight attempt and stage
RHC / Ethereum transaction hashes
completed trade count
last realized net
```

The JSONL journal is append-only operational history.

## Durable circuit breaker

Before a live attempt begins, Phase 6 persists an in-flight attempt.

Lifecycle stages are journaled as execution progresses:

```text
PREPARING
RHC_SELL_BROADCAST
RHC_SELL_MINED
ETH_HEDGE_BROADCAST
ETH_HEDGE_MINED
```

If both legs finish successfully:

```text
attempt resolved
→ circuit CLOSED
→ next market loop starts fresh
```

If the RHC leg succeeds but the Ethereum hedge fails:

```text
CRITICAL_HEDGE_FAILED
→ circuit OPEN
→ state survives process restart
→ no further autonomous trades
```

If the process restarts with any unresolved in-flight attempt, Phase 6 opens
the circuit conservatively and requires operator reconciliation.

Unexpected errors before any RHC trade broadcast do not permanently open the
circuit.

## Clearing the circuit

Never clear the circuit until the listed transaction hashes and balances have
been reconciled on both chains.

Inspect / clear with:

```bash
npm run circuit:clear
```

That command is read-only unless explicitly confirmed.

After reconciliation:

```bash
npm run circuit:clear -- --confirm
```

This clears the durable breaker and unresolved attempt record. The clear action
is appended to the execution journal.

## Transaction order

The proven route remains:

```text
BUY Ethereum WETH → WABIT
SELL RHC WABIT → WETH
```

Execution remains deliberately ordered:

```text
1. RHC protected WABIT sell
2. Ethereum protected WABIT buy / inventory hedge
```

The capacity-sensitive RHC leg goes first. If it fails, Ethereum remains
untouched. Once it succeeds, the Ethereum hedge is mandatory.

Reverse-direction live execution remains disabled until separately proven.

## Protection

The live path still uses:

```text
fresh direct chain state
exact static calls
exact estimateGas()
fresh gas prices
25% gas-limit padding
automatic symmetric per-leg protection
50% fresh modeled-net retention policy
```

No manual gas-unit profile is required by the live execution gate.

## Ctrl+C behavior

Before the first RHC swap broadcast:

```text
Ctrl+C → abort safely
```

After RHC broadcast:

```text
Ctrl+C → stop request remembered
       → mandatory Ethereum hedge still attempted
       → exit afterward
```

## Runtime safety

Do not commit `.env`.

The live signer still requires both gates:

```env
MODE=live
ENABLE_EXECUTION=true
```

and:

```env
EXECUTOR_ADDRESS=
EXECUTOR_PRIVATE_KEY=
```

For no-money monitoring / development:

```env
MODE=paper
ENABLE_EXECUTION=false
```

## Commands

```bash
npm run check
npm run scan
npm run simulate
npm run watch
npm run circuit:clear
```

`npm run watch` is the only watcher command. The selected `.env` mode determines
whether it runs the cold paper pipeline or the autonomous live hot path.
