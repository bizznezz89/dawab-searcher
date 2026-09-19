export type VenueSignal =
  | "RHC_CHEAPER"
  | "ETHEREUM_CHEAPER"
  | "PARITY";

export interface SearcherStateV03 {
  ok: true;
  schemaVersion: "0.3";
  generatedAt: string;

  rhc: {
    chainId: number;
    blockNumber: string;
    market: string;
    venue: {
      id: string;
      name: string;
    };
  };

  ethereumReference: {
    available: boolean;
    chainId: number;
    blockNumber: string;
  };

  marketSignal: {
    available: boolean;
    referenceType: string;

    sameNotionalBuy: {
      available: boolean;
      comparable: boolean;

      notionalWeth: {
        raw: string;
        formatted: string;
      };

      method: string;

      ethereum: {
        venue: string;
        pair: string;
        inputWeth: {
          raw: string;
          formatted: string;
        };
        netWabitOut: {
          raw: string;
          formatted: string;
        };
        effectiveWethPerWabitApprox: string;
      };

      rhc: {
        venue: string;
        inputWeth: {
          raw: string;
          formatted: string;
        };
        outputWabit: {
          raw: string;
          formatted: string;
        };
        refundWeth: {
          raw: string;
          formatted: string;
        };
        effectiveWethPerWabitApprox: string;
      };

      priceSpreadPct: {
        pct: string;
        label: "discount" | "premium" | string;
        definition: string;
      };

      outputDifferencePct: {
        pct: string;
        definition: string;
      };

      note: string;
    };
  };

  execution: {
    capitalProvided: boolean;
    privateKeysHandled: boolean;
    transactionsBroadcast: boolean;
  };
}

export interface MarketObservation {
  generatedAt: string;
  ageMs: number;

  rhcBlock: string;
  ethereumBlock: string;
  rhcVenue: string;

  notionalWeth: string;

  ethereumWabitOut: string;
  rhcWabitOut: string;

  ethereumEffectiveWethPerWabit: string;
  rhcEffectiveWethPerWabit: string;

  priceSpreadPct: number;
  outputDifferencePct: number;

  venueSignal: VenueSignal;

  executionStatus: "UNVERIFIED";
}
