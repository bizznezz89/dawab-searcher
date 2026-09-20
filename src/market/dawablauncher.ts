import {
  formatEther,
  formatUnits,
} from "ethers";

import { config } from "../config.js";
import type {
  EthereumVerification,
  MarketObservation,
  RhcVerification,
  SearcherStateV03,
  VenueSignal,
} from "../types.js";

function requiredNumber(
  value: string,
  field: string,
): number {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    throw new Error(
      `Invalid numeric field ${field}: ${value}`,
    );
  }

  return parsed;
}

function venueSignalFromSpread(
  spreadPct: number,
): VenueSignal {
  if (spreadPct < 0) return "RHC_CHEAPER";
  if (spreadPct > 0) return "ETHEREUM_CHEAPER";
  return "PARITY";
}

function validateState(
  state: unknown,
): asserts state is SearcherStateV03 {
  if (
    typeof state !== "object" ||
    state === null
  ) {
    throw new Error(
      "Searcher endpoint returned a non-object payload",
    );
  }

  const candidate = state as Partial<SearcherStateV03>;

  if (candidate.ok !== true) {
    throw new Error(
      "Searcher endpoint returned ok != true",
    );
  }

  if (candidate.schemaVersion !== "0.3") {
    throw new Error(
      `Expected Searcher Beacon schema 0.3; received ${String(
        candidate.schemaVersion,
      )}`,
    );
  }

  const same =
    candidate.marketSignal?.sameNotionalBuy;

  if (
    candidate.marketSignal?.available !== true ||
    same?.available !== true ||
    same?.comparable !== true
  ) {
    throw new Error(
      "Same-notional market signal is unavailable or not comparable",
    );
  }
}

export async function fetchDaWabState(): Promise<SearcherStateV03> {
  const response = await fetch(config.stateUrl, {
    headers: {
      Accept: "application/json",
      "User-Agent":
        "DaWabLauncher-Reference-Searcher/0.1",
    },
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(
      `Searcher endpoint returned HTTP ${response.status}`,
    );
  }

  const state: unknown = await response.json();

  validateState(state);

  const generatedAtMs = Date.parse(state.generatedAt);

  if (!Number.isFinite(generatedAtMs)) {
    throw new Error(
      `Invalid generatedAt timestamp: ${state.generatedAt}`,
    );
  }

  const ageMs = Date.now() - generatedAtMs;

  if (ageMs < -30_000) {
    throw new Error(
      `Searcher state timestamp is unexpectedly in the future (${Math.round(
        Math.abs(ageMs) / 1000,
      )}s)`,
    );
  }

  if (ageMs > config.maxStateAgeMs) {
    throw new Error(
      `Searcher state is stale (${Math.round(
        ageMs / 1000,
      )}s old)`,
    );
  }

  return state;
}

export function observePublicMarket(
  state: SearcherStateV03,
): MarketObservation {
  const same =
    state.marketSignal.sameNotionalBuy;

  const priceSpreadPct = requiredNumber(
    same.priceSpreadPct.pct,
    "marketSignal.sameNotionalBuy.priceSpreadPct.pct",
  );

  const outputDifferencePct = requiredNumber(
    same.outputDifferencePct.pct,
    "marketSignal.sameNotionalBuy.outputDifferencePct.pct",
  );

  return {
    generatedAt: state.generatedAt,
    ageMs: Date.now() - Date.parse(state.generatedAt),

    rhcBlock: state.rhc.blockNumber,
    ethereumBlock: state.ethereumReference.blockNumber,
    rhcVenue: state.rhc.venue.name,

    notionalWeth: same.notionalWeth.formatted,

    ethereumWabitOut:
      same.ethereum.netWabitOut.formatted,

    rhcWabitOut:
      same.rhc.outputWabit.formatted,

    ethereumEffectiveWethPerWabit:
      same.ethereum.effectiveWethPerWabitApprox,

    rhcEffectiveWethPerWabit:
      same.rhc.effectiveWethPerWabitApprox,

    priceSpreadPct,
    outputDifferencePct,

    venueSignal: venueSignalFromSpread(
      priceSpreadPct,
    ),

    // Intentionally conservative.
    // Independent chain verification arrives in Phase 2.
    executionStatus: "UNVERIFIED",
  };
}

function percentDifference(
  numerator:
    bigint,
  denominator:
    bigint,
): number {
  if (
    denominator === 0n
  ) {
    throw new Error(
      "Cannot calculate market percentage against a zero denominator.",
    );
  }

  const scale =
    1_000_000n;

  const delta =
    numerator -
    denominator;

  const scaled =
    (
      delta *
      100n *
      scale
    ) /
    denominator;

  return (
    Number(
      scaled,
    ) /
    Number(
      scale,
    )
  );
}

export function observeDirectMarket(
  ethereum:
    EthereumVerification,
  rhc:
    RhcVerification,
): MarketObservation {
  const priceSpreadPct =
    percentDifference(
      ethereum
        .netWabitOutRaw,
      rhc
        .amountOutWabitRaw,
    );

  const outputDifferencePct =
    percentDifference(
      rhc
        .amountOutWabitRaw,
      ethereum
        .netWabitOutRaw,
    );

  return {
    generatedAt:
      new Date().toISOString(),

    ageMs:
      0,

    rhcBlock:
      rhc.blockNumber
        .toString(),

    ethereumBlock:
      ethereum.blockNumber
        .toString(),

    rhcVenue:
      rhc.venueName,

    notionalWeth:
      formatEther(
        ethereum
          .amountInWethRaw,
      ),

    ethereumWabitOut:
      formatUnits(
        ethereum
          .netWabitOutRaw,
        18,
      ),

    rhcWabitOut:
      formatUnits(
        rhc
          .amountOutWabitRaw,
        18,
      ),

    /*
     * These fields are not used as an execution authority. Keep them
     * informational and derive the actual executable route from raw RPC state.
     */
    ethereumEffectiveWethPerWabit:
      "",

    rhcEffectiveWethPerWabit:
      "",

    priceSpreadPct,

    outputDifferencePct,

    venueSignal:
      venueSignalFromSpread(
        priceSpreadPct,
      ),

    executionStatus:
      "UNVERIFIED",
  };
}

