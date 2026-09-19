import { config } from "../config.js";
import {
  fetchDaWabState,
  observePublicMarket,
} from "../market/dawablauncher.js";
import {
  assessPhaseOne,
} from "../strategy/crossChainArb.js";
import {
  renderObservation,
} from "../format.js";

let stopping = false;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) =>
    setTimeout(resolve, ms),
  );
}

async function runOnce(): Promise<void> {
  const state = await fetchDaWabState();
  const observation =
    observePublicMarket(state);
  const assessment =
    assessPhaseOne(observation);

  console.clear();

  process.stdout.write(
    renderObservation(
      observation,
      assessment,
    ),
  );

  console.log(
    `Watching every ${(
      config.pollIntervalMs / 1000
    ).toFixed(1)}s — Ctrl+C to stop.`,
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

  console.log("\nDaWab Searcher stopped.");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
