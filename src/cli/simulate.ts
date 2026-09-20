import {
  fetchDaWabState,
} from "../market/dawablauncher.js";
import {
  verifyEthereumBuy,
} from "../market/ethereum.js";
import {
  verifyRhcBuy,
} from "../market/rhc.js";
import {
  evaluateOpportunitySweep,
} from "../strategy/opportunity.js";
import {
  verifyAgainstFeed,
} from "../verification.js";
import {
  renderPhase4Simulation,
  simulateBestOpportunity,
} from "../simulation/fork.js";

async function main(): Promise<void> {
  console.log(
    "DaWab Searcher Phase 4",
  );
  console.log(
    "Local-fork execution simulation only — no public transactions will be broadcast.",
  );
  console.log("");

  const state =
    await fetchDaWabState();

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

  if (
    verification.status !== "PASS"
  ) {
    throw new Error(
      "Independent market verification failed; refusing to simulate stale or mismatched state",
    );
  }

  console.log(
    "Independent market verification: PASS",
  );

  const sweep =
    await evaluateOpportunitySweep(
      ethereum,
    );

  if (
    sweep.bestGross == null
  ) {
    throw new Error(
      "Phase 3 found no complete opportunity candidate",
    );
  }

  console.log(
    `Phase 3 best gross: ${sweep.bestGross.direction} @ ${Number(
      sweep.bestGross.requestedWethRaw,
    ) / 1e18} WETH`,
  );

  console.log(
    "Launching hybrid Ethereum/Anvil + RHC/Forge fork simulation...",
  );

  const result =
    await simulateBestOpportunity(
      sweep,
    );

  process.stdout.write(
    renderPhase4Simulation(
      result,
    ),
  );
}

main().catch((error: unknown) => {
  const message =
    error instanceof Error
      ? error.message
      : String(error);

  console.error(
    `Phase 4 simulation failed: ${message}`,
  );

  process.exitCode = 1;
});
