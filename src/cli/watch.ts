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
  renderObservation,
  renderVerification,
} from "../format.js";
import {
  verifyAgainstFeed,
} from "../verification.js";
import type {
  IndependentVerification,
} from "../types.js";

let stopping = false;

let lastVerification:
  | IndependentVerification
  | null = null;

let lastVerifiedAt = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) =>
    setTimeout(resolve, ms),
  );
}

async function maybeVerify(
  state: Awaited<
    ReturnType<typeof fetchDaWabState>
  >,
): Promise<IndependentVerification | null> {
  const now = Date.now();

  if (
    lastVerification &&
    now - lastVerifiedAt <
      config.verificationIntervalMs
  ) {
    return lastVerification;
  }

  const [ethereum, rhc] =
    await Promise.all([
      verifyEthereumBuy(),
      verifyRhcBuy(),
    ]);

  lastVerification =
    verifyAgainstFeed(
      state,
      ethereum,
      rhc,
    );

  lastVerifiedAt = now;

  return lastVerification;
}

async function runOnce(): Promise<void> {
  const state = await fetchDaWabState();

  const observation =
    observePublicMarket(state);

  const assessment =
    assessPhaseOne(observation);

  const verification =
    await maybeVerify(state);

  console.clear();

  process.stdout.write(
    renderObservation(
      observation,
      assessment,
    ),
  );

  if (verification) {
    process.stdout.write(
      renderVerification(
        verification,
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

  console.log(
    `Public feed: every ${(
      config.pollIntervalMs / 1000
    ).toFixed(1)}s`,
  );

  console.log(
    `Independent RPC verification: every ${(
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
      await sleep(config.pollIntervalMs);
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
