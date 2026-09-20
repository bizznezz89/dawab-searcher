import {
  clearExecutionCircuit,
  initializeExecutionJournal,
} from "../execution/journal.js";

async function main():
  Promise<void> {
  const confirmed =
    process.argv.includes(
      "--confirm",
    );

  const state =
    await initializeExecutionJournal();

  console.log(
    JSON.stringify(
      {
        circuitOpen:
          state.circuitOpen,

        circuitReason:
          state.circuitReason,

        inFlight:
          state.inFlight,
      },
      null,
      2,
    ),
  );

  if (
    !confirmed
  ) {
    console.log("");
    console.log(
      "No changes made.",
    );
    console.log(
      "After reconciling both chains and any listed transaction hashes, run:",
    );
    console.log(
      "npm run circuit:clear -- --confirm",
    );
    return;
  }

  const cleared =
    await clearExecutionCircuit(
      "Operator confirmed external chain reconciliation via --confirm.",
    );

  console.log("");
  console.log(
    "Execution circuit cleared.",
  );

  console.log(
    JSON.stringify(
      {
        circuitOpen:
          cleared.circuitOpen,

        inFlight:
          cleared.inFlight,
      },
      null,
      2,
    ),
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
