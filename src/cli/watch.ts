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

let lastVerifiedAt = 0;
let lastSweepAt = 0;

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
    } else if (!sweepTriggered) {
      lastSweep = null;
      lastSweepAt = 0;
    }
  }

  console.clear();

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
