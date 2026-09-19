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
      id: string | number;
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
        factory?: string;
        inputWeth: {
          raw: string;
          formatted: string;
        };
        grossWabitOut?: {
          raw: string;
          formatted: string;
        };
        transferBurn?: {
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
        amountInUsed?: {
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

export interface EthereumVerification {
  chainId: bigint;
  blockNumber: number;

  pair: string;
  factory: string;
  canonicalUniswapV2Factory: boolean;

  token0: string;
  token1: string;

  wethReserveRaw: bigint;
  wabitReserveRaw: bigint;

  amountInWethRaw: bigint;
  grossWabitOutRaw: bigint;
  transferBurnRaw: bigint;
  netWabitOutRaw: bigint;
}

export interface RhcVerification {
  chainId: bigint;
  blockNumber: number;

  venue: bigint;
  venueName: string;

  amountInRequestedRaw: bigint;
  amountInUsedRaw: bigint;
  amountOutWabitRaw: bigint;
  refundWethRaw: bigint;
}

export interface FeedLegVerification {
  status: "PASS" | "FAIL";
  feedRaw: bigint;
  rpcRaw: bigint;
  differenceBps: number;
}

export interface IndependentVerification {
  status: "PASS" | "FAIL";

  ethereum: EthereumVerification;
  rhc: RhcVerification;

  ethereumFeedMatch: FeedLegVerification;
  rhcFeedMatch: FeedLegVerification;

  toleranceBps: number;

  executionBasis:
    | "VERIFIED_MARKET_STATE"
    | "UNVERIFIED_MARKET_STATE";

  arbExecution:
    | "NOT_YET_PROVEN";
}
