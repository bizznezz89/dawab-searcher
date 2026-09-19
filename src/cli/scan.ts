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

async function main(): Promise<void> {
  const state = await fetchDaWabState();

  const observation =
    observePublicMarket(state);

  const assessment =
    assessPhaseOne(observation);

  const [ethereum, rhc] =
    await Promise.all([
      verifyEthereumBuy(),
      verifyRhcBuy(),
    ]);

  const verification =
    verifyAgainstFeed(
      state,
      ethereum,
      rhc,
    );

  process.stdout.write(
    renderObservation(
      observation,
      assessment,
    ),
  );

  process.stdout.write(
    renderVerification(
      verification,
    ),
  );

  if (verification.status !== "PASS") {
    process.exitCode = 2;
  }
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
