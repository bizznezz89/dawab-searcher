import { config } from "../config.js";

import {
  fetchDaWabState,
  observeDirectMarket,
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
  renderLiveDirectVerification,
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

import {
  beginExecutionAttempt,
  currentExecutionState,
  executionJournalPath,
  executionStatePath,
  finalizeExecutionAttempt,
  initializeExecutionJournal,
  recordExecutionError,
  recordExecutionLifecycle,
} from "../execution/journal.js";

import type {
  PersistentExecutionState,
} from "../execution/journal.js";

import type {
  EthereumVerification,
  IndependentVerification,
  MarketObservation,
  OpportunitySweep,
  RhcVerification,
  SearcherStateV03,
} from "../types.js";

let stopping =
  false;

let lastVerification:
  IndependentVerification | null =
  null;

let lastLiveEthereum:
  EthereumVerification | null =
  null;

let lastLiveRhc:
  RhcVerification | null =
  null;

let lastLiveFeedCrossCheck:
  IndependentVerification | null =
  null;

let lastLiveFeedError:
  string | null =
  null;

let lastObservation:
  MarketObservation | null =
  null;

let lastSweep:
  OpportunitySweep | null =
  null;

let lastPaperGate:
  | Awaited<
      ReturnType<
        typeof evaluatePaperExecutionGate
      >
    >
  | null = null;

let lastPaperGateError:
  string | null =
  null;

let lastLiveExecution:
  HotExecutionResult | null =
  null;

let lastLiveExecutionError:
  string | null =
  null;

let lastVerifiedAt =
  0;

let lastSweepAt =
  0;

let lastPaperGateAt =
  0;

let executionState:
  PersistentExecutionState | null =
  null;

function sleep(
  ms:
    number,
): Promise<void> {
  return new Promise(
    (resolve) =>
      setTimeout(
        resolve,
        ms,
      ),
  );
}

async function verifyPaper(
  state:
    SearcherStateV03,
): Promise<IndependentVerification> {
  const [
    ethereum,
    rhc,
  ] =
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

function errorMessage(
  error:
    unknown,
): string {
  return error instanceof Error
    ? error.message
    : String(error);
}

async function tryFetchLiveFeed():
  Promise<{
    state:
      SearcherStateV03 | null;

    error:
      string | null;
  }> {
  try {
    return {
      state:
        await fetchDaWabState(),

      error:
        null,
    };
  } catch (error: unknown) {
    return {
      state:
        null,

      error:
        errorMessage(
          error,
        ),
    };
  }
}

async function runPaperOnce():
  Promise<void> {
  const state =
    await fetchDaWabState();

  const observation =
    observePublicMarket(
      state,
    );

  lastObservation =
    observation;

  const assessment =
    assessPhaseOne(
      observation,
    );

  const now =
    Date.now();

  const verificationDue =
    !lastVerification ||
    now -
      lastVerifiedAt >=
      config
        .verificationIntervalMs;

  if (
    verificationDue
  ) {
    lastVerification =
      await verifyPaper(
        state,
      );

    lastVerifiedAt =
      Date.now();

    const sweepTriggered =
      Math.abs(
        observation
          .priceSpreadPct,
      ) >=
      config
        .opportunityTriggerPct;

    if (
      lastVerification.status ===
        "PASS" &&
      sweepTriggered
    ) {
      lastSweep =
        await evaluateOpportunitySweep(
          lastVerification
            .ethereum,
        );

      lastSweepAt =
        Date.now();

      lastPaperGate =
        null;

      lastPaperGateError =
        null;

      lastPaperGateAt =
        0;

      const candidate =
        lastSweep.bestGross;

      if (
        candidate != null &&
        candidate
          .grossProfitWethRaw !=
          null &&
        candidate
          .grossProfitWethRaw >
          0n
      ) {
        if (
          candidate.direction !==
          "BUY_ETH_SELL_RHC"
        ) {
          lastPaperGateError =
            "SKIP — best opportunity is RHC→ETH, but that execution route has not passed cold fork validation.";

          lastPaperGateAt =
            Date.now();
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
          } catch (
            error:
              unknown
          ) {
            lastPaperGateError =
              `SKIP — ${errorMessage(
                error,
              )}`;

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
    } else if (
      !sweepTriggered
    ) {
      lastSweep =
        null;

      lastSweepAt =
        0;

      lastPaperGate =
        null;

      lastPaperGateError =
        null;

      lastPaperGateAt =
        0;
    }
  }

  console.clear();

  process.stdout.write(
    renderObservation(
      observation,
      assessment,
      {
        searcherMode:
          "PAPER",

        marketSource:
          "PUBLIC_FEED",

        publicFeedStatus:
          "REQUIRED",
      },
    ),
  );

  if (
    lastVerification
  ) {
    process.stdout.write(
      renderVerification(
        lastVerification,
      ),
    );

    const verificationAge =
      Math.max(
        0,
        Date.now() -
          lastVerifiedAt,
      ) /
      1000;

    console.log(
      `RPC verification age: ${verificationAge.toFixed(1)}s`,
    );
  }

  if (
    lastSweep
  ) {
    console.log("");

    process.stdout.write(
      renderOpportunitySweep(
        lastSweep,
        {
          executionMode:
            "paper",
        },
      ),
    );

    const sweepAge =
      Math.max(
        0,
        Date.now() -
          lastSweepAt,
      ) /
      1000;

    console.log(
      `Opportunity sweep age: ${sweepAge.toFixed(1)}s`,
    );

    if (
      lastPaperGate
    ) {
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
        ) /
        1000;

      console.log(
        `Paper execution gate age: ${gateAge.toFixed(1)}s`,
      );
    } else if (
      lastPaperGateError
    ) {
      console.log("");
      console.log(
        "Cold paper execution gate",
      );
      console.log(
        "─────────────────────────",
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
      config.pollIntervalMs /
      1000
    ).toFixed(1)}s`,
  );

  console.log(
    `Independent verification/sweep: every ${(
      config
        .verificationIntervalMs /
      1000
    ).toFixed(1)}s`,
  );

  console.log(
    "Ctrl+C to stop.",
  );
}

async function runLiveOnce():
  Promise<void> {
  /*
   * Public state.json is advisory in live mode.
   *
   * Start its fetch concurrently, but build the executable market state from
   * direct Ethereum/RHC RPC reads. A 502, stale cache, or feed mismatch cannot
   * blind the live searcher.
   */
  const feedPromise =
    tryFetchLiveFeed();

  const [
    ethereum,
    rhc,
  ] =
    await Promise.all([
      verifyEthereumBuy(),
      verifyRhcBuy(),
    ]);

  /*
   * The feed gets the duration of the direct RPC reads plus a small grace
   * window. It is never allowed to add the full feed timeout to the hot path.
   */
  const feed =
    await Promise.race([
      feedPromise,

      sleep(
        250,
      ).then(
        () => ({
          state:
            null,

          error:
            "Public feed did not complete within the live advisory budget",
        }),
      ),
    ]);

  lastLiveEthereum =
    ethereum;

  lastLiveRhc =
    rhc;

  lastVerifiedAt =
    Date.now();

  const observation =
    observeDirectMarket(
      ethereum,
      rhc,
    );

  lastObservation =
    observation;

  const assessment =
    assessPhaseOne(
      observation,
    );

  if (
    feed.state
  ) {
    try {
      lastLiveFeedCrossCheck =
        verifyAgainstFeed(
          feed.state,
          ethereum,
          rhc,
        );

      lastLiveFeedError =
        null;
    } catch (
      error:
        unknown
    ) {
      lastLiveFeedCrossCheck =
        null;

      lastLiveFeedError =
        `Public feed cross-check failed: ${errorMessage(
          error,
        )}`;
    }
  } else {
    lastLiveFeedCrossCheck =
      null;

    lastLiveFeedError =
      feed.error;
  }

  const sweepTriggered =
    Math.abs(
      observation
        .priceSpreadPct,
    ) >=
    config
      .opportunityTriggerPct;

  if (
    sweepTriggered
  ) {
    lastSweep =
      await evaluateOpportunitySweep(
        ethereum,
      );

    lastSweepAt =
      Date.now();

    const candidate =
      lastSweep.bestGross;

    lastLiveExecutionError =
      null;

    if (
      candidate == null ||
      candidate
        .grossProfitWethRaw ==
        null ||
      candidate
        .grossProfitWethRaw <=
        0n
    ) {
      lastLiveExecutionError =
        "SKIP — no positive optimized gross opportunity.";
    } else if (
      candidate.direction !==
      "BUY_ETH_SELL_RHC"
    ) {
      lastLiveExecutionError =
        "SKIP — best opportunity is RHC→ETH, but reverse live execution has not been proven.";
    } else {
      const current =
        currentExecutionState();

      executionState =
        current;

      if (
        current.circuitOpen
      ) {
        lastLiveExecutionError =
          `BLOCKED — durable circuit breaker OPEN: ${current.circuitReason ?? "manual reconciliation required"}`;
      } else if (
        !stopping
      ) {
        const attempt =
          await beginExecutionAttempt(
            candidate,
          );

        executionState =
          currentExecutionState();

        try {
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

                onLifecycle:
                  async (
                    event,
                  ) => {
                    await recordExecutionLifecycle(
                      attempt.id,
                      event,
                    );

                    executionState =
                      currentExecutionState();
                  },
              },
            );

          executionState =
            await finalizeExecutionAttempt(
              attempt.id,
              lastLiveExecution,
            );

          if (
            lastLiveExecution
              .openedCircuitBreaker
          ) {
            lastLiveExecutionError =
              `BLOCKED — ${lastLiveExecution.reason}`;
          }
        } catch (
          error:
            unknown
        ) {
          executionState =
            await recordExecutionError(
              attempt.id,
              error,
            );

          lastLiveExecutionError =
            executionState
              .circuitOpen
              ? `BLOCKED — durable circuit breaker OPEN: ${executionState.circuitReason}`
              : `SKIP — ${errorMessage(
                  error,
                )}`;
        }
      }
    }
  } else {
    lastSweep =
      null;

    lastSweepAt =
      0;

    lastLiveExecutionError =
      null;
  }

  /*
   * Do not clear live output. Transaction hashes and lifecycle messages are
   * operational evidence and must remain visible.
   */
  process.stdout.write(
    renderObservation(
      observation,
      assessment,
      {
        searcherMode:
          "LIVE",

        marketSource:
          "DIRECT_RPC",

        publicFeedStatus:
          feed.state
            ? lastLiveFeedCrossCheck
                ?.status ===
              "PASS"
              ? "AVAILABLE / MATCH"
              : "AVAILABLE / MISMATCH (advisory)"
            : `UNAVAILABLE (advisory)${
                feed.error
                  ? ` — ${feed.error}`
                  : ""
              }`,
      },
    ),
  );

  process.stdout.write(
    renderLiveDirectVerification(
      ethereum,
      rhc,
      lastLiveFeedCrossCheck,
      lastLiveFeedError,
    ),
  );

  if (
    lastSweep
  ) {
    console.log("");

    process.stdout.write(
      renderOpportunitySweep(
        lastSweep,
        {
          executionMode:
            "live",
        },
      ),
    );

    const sweepAge =
      Math.max(
        0,
        Date.now() -
          lastSweepAt,
      ) /
      1000;

    console.log(
      `Opportunity sweep age: ${sweepAge.toFixed(1)}s`,
    );
  } else {
    console.log("");
    console.log(
      `Opportunity sweep: waiting for |direct RPC spread| >= ${config.opportunityTriggerPct}%`,
    );
  }

  console.log("");
  console.log(
    "Phase 6 autonomous live executor",
  );
  console.log(
    "────────────────────────────────",
  );

  if (
    lastLiveExecution
  ) {
    console.log(
      `Last status:            ${lastLiveExecution.status}`,
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
      "Last status:            no Phase 6 trade in this process",
    );
  }

  if (
    lastLiveExecutionError
  ) {
    console.log(
      `Executor:               ${lastLiveExecutionError}`,
    );
  }

  const persistent =
    executionState ??
    currentExecutionState();

  console.log(
    `Circuit breaker:        ${persistent.circuitOpen ? "OPEN" : "CLOSED"}`,
  );

  if (
    persistent.circuitReason
  ) {
    console.log(
      `Circuit reason:         ${persistent.circuitReason}`,
    );
  }

  console.log(
    `Completed trades:       ${persistent.completedTrades}`,
  );

  console.log(
    `In-flight attempt:      ${
      persistent.inFlight
        ? `${persistent.inFlight.id} / ${persistent.inFlight.stage}`
        : "none"
    }`,
  );

  console.log(
    `Execution state:        ${executionStatePath}`,
  );

  console.log(
    `Execution journal:      ${executionJournalPath}`,
  );

  console.log(
    `Live verification:      every ${(
      config.pollIntervalMs /
      1000
    ).toFixed(1)}s`,
  );

  console.log(
    "Ctrl+C: abort before first swap; after RHC broadcast, finish hedge then stop.",
  );
}

async function runOnce():
  Promise<void> {
  if (
    config.liveExecution
  ) {
    await runLiveOnce();
    return;
  }

  await runPaperOnce();
}

async function main():
  Promise<void> {
  process.on(
    "SIGINT",
    () => {
      stopping =
        true;
    },
  );

  process.on(
    "SIGTERM",
    () => {
      stopping =
        true;
    },
  );

  if (
    config.liveExecution
  ) {
    executionState =
      await initializeExecutionJournal();

    if (
      executionState
        .circuitOpen
    ) {
      console.error(
        `[PHASE6] Durable circuit breaker is OPEN: ${executionState.circuitReason ?? "manual reconciliation required"}`,
      );
    }
  }

  while (
    !stopping
  ) {
    try {
      await runOnce();
    } catch (
      error:
        unknown
    ) {
      console.error(
        `[${new Date().toISOString()}] ${errorMessage(
          error,
        )}`,
      );
    }

    if (
      !stopping
    ) {
      await sleep(
        config.pollIntervalMs,
      );
    }
  }

  console.log(
    "\nDaWab Searcher stopped.",
  );
}

main().catch(
  (
    error:
      unknown,
  ) => {
    console.error(
      error,
    );

    process.exitCode =
      1;
  },
);
