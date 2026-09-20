import { config } from "../config.js";
import {
  fetchDaWabState,
  observePublicMarket,
} from "../market/dawablauncher.js";
import {
  verifyEthereumBuy,
} from "../market/ethereum.js";
import {
  verifyRhcBuy,
} from "../market/rhc.js";
import {
  assessPhaseOne,
} from "../strategy/crossChainArb.js";
import {
  evaluateOpportunitySweep,
} from "../strategy/opportunity.js";
import {
  renderObservation,
  renderOpportunitySweep,
  renderVerification,
} from "../format.js";
import {
  verifyAgainstFeed,
} from "../verification.js";
import {
  simulateBestOpportunity,
} from "../simulation/fork.js";
import {
  evaluatePaperExecutionGate,
  renderPaperExecutionGate,
} from "../execution/paperGate.js";
import {
  executeHotOpportunity,
} from "../execution/hotExecutor.js";
import type {
  HotExecutionResult,
} from "../execution/hotExecutor.js";
import type {
  IndependentVerification,
  OpportunitySweep,
  SearcherStateV03,
} from "../types.js";

let stopping = false;

let lastVerification:
  | IndependentVerification
  | null = null;

let lastSweep:
  | OpportunitySweep
  | null = null;

let lastPaperGate:
  | Awaited<
      ReturnType<
        typeof evaluatePaperExecutionGate
      >
    >
  | null = null;

let lastPaperGateError:
  | string
  | null = null;

let lastVerifiedAt = 0;
let lastSweepAt = 0;
let lastPaperGateAt = 0;

let lastLiveExecution:
  | HotExecutionResult
  | null = null;

let executionCircuitOpen =
  false;

/*
 * First-live-deployment latch.
 *
 * A process may attempt at most one autonomous live execution. Restarting the
 * watcher is an explicit operator action. Persistent autonomous multi-trade
 * operation comes only after the durable journal/circuit-breaker phase.
 */
let liveExecutionAttempted =
  false;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) =>
    setTimeout(resolve, ms),
  );
}

async function verify(
  state: SearcherStateV03,
): Promise<IndependentVerification> {
  const [ethereum, rhc] =
    await Promise.all([
      verifyEthereumBuy(),
      verifyRhcBuy(),
    ]);

  return verifyAgainstFeed(
    state,
    ethereum,
    rhc,
  );
}

async function runOnce(): Promise<void> {
  const state =
    await fetchDaWabState();

  const observation =
    observePublicMarket(state);

  const assessment =
    assessPhaseOne(observation);

  const now = Date.now();
  const verificationDue =
    config.liveExecution
      ? (
          !liveExecutionAttempted &&
          !executionCircuitOpen
        )
      : (
          !lastVerification ||
          now - lastVerifiedAt >=
            config.verificationIntervalMs
        );

  if (verificationDue) {
    lastVerification =
      await verify(state);

    lastVerifiedAt = Date.now();

    const sweepTriggered =
      Math.abs(
        observation.priceSpreadPct,
      ) >=
      config.opportunityTriggerPct;

    if (
      lastVerification.status === "PASS" &&
      sweepTriggered
    ) {
      lastSweep =
        await evaluateOpportunitySweep(
          lastVerification.ethereum,
        );

      lastSweepAt = Date.now();

      lastPaperGate = null;
      lastPaperGateError = null;
      lastPaperGateAt = 0;

      const candidate =
        lastSweep.bestGross;

      if (
        candidate != null &&
        candidate.grossProfitWethRaw != null &&
        candidate.grossProfitWethRaw > 0n
      ) {
        if (
          candidate.direction !==
          "BUY_ETH_SELL_RHC"
        ) {
          lastPaperGateError =
            "SKIP — best opportunity is RHC→ETH, but that execution route has not yet passed Phase 4 fork validation.";
        } else {
          try {
            if (
              config.liveExecution
            ) {
              /*
               * LIVE HOT PATH
               *
               * No Anvil.
               * No Forge.
               * No Phase 5D fork bootstrap simulation.
               *
               * The route has already been cold-proven. The live executor
               * revalidates current chain state, estimates the exact calls,
               * maintains the wallet, derives protection, and broadcasts only
               * if every hot-path gate still passes.
               */
              if (
                !executionCircuitOpen &&
                !liveExecutionAttempted &&
                !stopping
              ) {
                liveExecutionAttempted =
                  true;

                lastLiveExecution =
                  await executeHotOpportunity(
                    candidate,
                    {
                      shouldAbort:
                        () =>
                          stopping,

                      log:
                        (message) =>
                          console.log(
                            message,
                          ),
                    },
                  );

                if (
                  lastLiveExecution
                    .openedCircuitBreaker
                ) {
                  executionCircuitOpen =
                    true;
                }
              }
            } else {
              /*
               * PAPER / COLD VALIDATION PATH
               *
               * Preserve the expensive fork proof here for development and
               * manual validation. It is intentionally absent from live mode.
               */
              const simulation =
                await simulateBestOpportunity(
                  lastSweep,
                );

              lastPaperGate =
                await evaluatePaperExecutionGate(
                  simulation,
                );

              lastPaperGateAt =
                Date.now();
            }
          } catch (error: unknown) {
            lastPaperGateError =
              error instanceof Error
                ? `SKIP — ${error.message}`
                : `SKIP — ${String(error)}`;

            lastPaperGateAt =
              Date.now();
          }
        }
      } else {
        lastPaperGateError =
          "SKIP — no positive optimized gross opportunity.";
        lastPaperGateAt =
          Date.now();
      }
    } else if (!sweepTriggered) {
      lastSweep = null;
      lastSweepAt = 0;
      lastPaperGate = null;
      lastPaperGateError = null;
      lastPaperGateAt = 0;
    }
  }

  if (!config.liveExecution) {
    console.clear();
  }

  process.stdout.write(
    renderObservation(
      observation,
      assessment,
    ),
  );

  if (lastVerification) {
    process.stdout.write(
      renderVerification(
        lastVerification,
      ),
    );

    const verificationAge =
      Math.max(
        0,
        Date.now() - lastVerifiedAt,
      ) / 1000;

    console.log(
      `RPC verification age: ${verificationAge.toFixed(
        1,
      )}s`,
    );
  }

  if (lastSweep) {
    console.log("");

    process.stdout.write(
      renderOpportunitySweep(
        lastSweep,
      ),
    );

    const sweepAge =
      Math.max(
        0,
        Date.now() - lastSweepAt,
      ) / 1000;

    console.log(
      `Opportunity sweep age: ${sweepAge.toFixed(
        1,
      )}s`,
    );

    if (lastPaperGate) {
      process.stdout.write(
        renderPaperExecutionGate(
          lastPaperGate,
        ),
      );

      const gateAge =
        Math.max(
          0,
          Date.now() -
            lastPaperGateAt,
        ) / 1000;

      console.log(
        `Paper execution gate age: ${gateAge.toFixed(
          1,
        )}s`,
      );


    } else if (
      lastPaperGateError
    ) {
      console.log("");
      console.log(
        "Phase 5E integrated execution gate",
      );
      console.log(
        "────────────────────────────────────────",
      );
      console.log(
        `PAPER ACTION:           ${lastPaperGateError}`,
      );
      console.log(
        "Signing:                DISABLED",
      );
      console.log(
        "Broadcast:              DISABLED",
      );
    }
  } else {
    console.log("");
    console.log(
      `Opportunity sweep: waiting for |public spread| >= ${config.opportunityTriggerPct}%`,
    );
  }

  if (
    config.liveExecution
  ) {
    console.log("");
    console.log(
      "Phase 5E.2 hot live executor",
    );
    console.log(
      "────────────────────────────",
    );

    if (
      lastLiveExecution
    ) {
      console.log(
        `Status:                 ${lastLiveExecution.status}`,
      );
      console.log(
        `Wallet:                 ${lastLiveExecution.wallet}`,
      );
      console.log(
        `Reason:                 ${lastLiveExecution.reason}`,
      );

      for (
        const tx of
        lastLiveExecution
          .bootstrapTransactions
      ) {
        console.log(
          `${tx.chain} ${tx.action}: ${tx.txHash}`,
        );
      }

      if (
        lastLiveExecution.rhcSell
      ) {
        console.log(
          `RHC sell tx:            ${lastLiveExecution.rhcSell.txHash}`,
        );
      }

      if (
        lastLiveExecution
          .ethereumBuy
      ) {
        console.log(
          `Ethereum hedge tx:      ${lastLiveExecution.ethereumBuy.txHash}`,
        );
      }

      if (
        lastLiveExecution
          .protection
      ) {
        console.log(
          `Protected slippage:     ${lastLiveExecution.protection.maxSymmetricSlippageBps} bps / leg`,
        );
      }

      if (
        lastLiveExecution
          .realizedNetWethRaw !=
        null
      ) {
        console.log(
          `Realized net raw:       ${lastLiveExecution.realizedNetWethRaw.toString()} wei-WETH`,
        );
      }
    } else {
      console.log(
        "Status:                 ARMED — waiting for first qualifying opportunity",
      );
    }

    console.log(
      `Circuit breaker:        ${executionCircuitOpen ? "OPEN" : "CLOSED"}`,
    );

    console.log(
      `Live one-shot latch:    ${liveExecutionAttempted ? "CONSUMED" : "ARMED"}`,
    );

    console.log(
      `Operator stop:          ${stopping ? "REQUESTED" : "not requested"}`,
    );
  }

  console.log(
    `Public feed: every ${(
      config.pollIntervalMs / 1000
    ).toFixed(1)}s`,
  );

  console.log(
    `Independent verification/sweep: every ${(
      config.verificationIntervalMs /
      1000
    ).toFixed(1)}s`,
  );

  console.log(
    config.liveExecution
      ? "Ctrl+C: abort before first swap; after RHC broadcast, finish hedge then stop."
      : "Ctrl+C to stop.",
  );
}

async function main(): Promise<void> {
  process.on("SIGINT", () => {
    stopping = true;
  });

  process.on("SIGTERM", () => {
    stopping = true;
  });

  while (!stopping) {
    try {
      await runOnce();
    } catch (error: unknown) {
      const message =
        error instanceof Error
          ? error.message
          : String(error);

      console.error(
        `[${new Date().toISOString()}] ${message}`,
      );
    }

    if (!stopping) {
      await sleep(
        config.pollIntervalMs,
      );
    }
  }

  console.log(
    "\nDaWab Searcher stopped.",
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
