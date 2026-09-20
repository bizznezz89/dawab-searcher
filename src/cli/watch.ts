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
  executeLiveOpportunity,
  gateCanReachLiveExecution,
} from "../execution/liveExecutor.js";
import type {
  LiveExecutionResult,
} from "../execution/liveExecutor.js";
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
  | LiveExecutionResult
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
    !lastVerification ||
    now - lastVerifiedAt >=
      config.verificationIntervalMs;

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

            if (
              config.liveExecution &&
              !executionCircuitOpen &&
              !liveExecutionAttempted &&
              gateCanReachLiveExecution(
                lastPaperGate,
              )
            ) {
              /*
               * Consume the one-shot latch before entering the live executor.
               * Even an aborted attempt requires an explicit process restart.
               */
              liveExecutionAttempted =
                true;

              lastLiveExecution =
                await executeLiveOpportunity(
                  simulation,
                  lastPaperGate,
                );

              if (
                lastLiveExecution
                  .openedCircuitBreaker
              ) {
                executionCircuitOpen =
                  true;
              }
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

      if (
        lastLiveExecution
      ) {
        console.log("");
        console.log(
          "Phase 5E integrated live executor",
        );
        console.log(
          "────────────────────────────────",
        );
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
          lastLiveExecution.bootstrap.transactions
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
          lastLiveExecution.ethereumBuy
        ) {
          console.log(
            `Ethereum buy tx:        ${lastLiveExecution.ethereumBuy.txHash}`,
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

        console.log(
          `Circuit breaker:        ${executionCircuitOpen ? "OPEN" : "CLOSED"}`,
        );

        console.log(
          `Live one-shot latch:    ${liveExecutionAttempted ? "CONSUMED" : "ARMED"}`,
        );
      }
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
    "Ctrl+C to stop.",
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
