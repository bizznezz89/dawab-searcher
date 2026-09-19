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

async function main(): Promise<void> {
  const state = await fetchDaWabState();
  const observation =
    observePublicMarket(state);
  const assessment =
    assessPhaseOne(observation);

  process.stdout.write(
    renderObservation(
      observation,
      assessment,
    ),
  );
}

main().catch((error: unknown) => {
  const message =
    error instanceof Error
      ? error.message
      : String(error);

  console.error(
    `DaWab Searcher scan failed: ${message}`,
  );

  process.exitCode = 1;
});
