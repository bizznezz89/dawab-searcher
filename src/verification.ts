import { config } from "./config.js";
import type {
  EthereumVerification,
  FeedLegVerification,
  IndependentVerification,
  RhcVerification,
  SearcherStateV03,
} from "./types.js";

function absoluteDifference(
  a: bigint,
  b: bigint,
): bigint {
  return a >= b ? a - b : b - a;
}

function differenceBps(
  feed: bigint,
  rpc: bigint,
): number {
  if (feed === 0n && rpc === 0n) {
    return 0;
  }

  const denominator =
    feed > rpc ? feed : rpc;

  if (denominator === 0n) {
    return Number.POSITIVE_INFINITY;
  }

  // Calculate to 0.0001 bps precision without floating
  // point loss on the token quantities themselves.
  const scaled =
    (absoluteDifference(feed, rpc) *
      100_000_000n) /
    denominator;

  return Number(scaled) / 10_000;
}

function compareLeg(
  feedRaw: bigint,
  rpcRaw: bigint,
): FeedLegVerification {
  const diff =
    differenceBps(feedRaw, rpcRaw);

  return {
    status:
      diff <=
      config.verificationToleranceBps
        ? "PASS"
        : "FAIL",
    feedRaw,
    rpcRaw,
    differenceBps: diff,
  };
}

export function verifyAgainstFeed(
  feed: SearcherStateV03,
  ethereum: EthereumVerification,
  rhc: RhcVerification,
): IndependentVerification {
  const same =
    feed.marketSignal.sameNotionalBuy;

  const ethereumFeedMatch = compareLeg(
    BigInt(same.ethereum.netWabitOut.raw),
    ethereum.netWabitOutRaw,
  );

  const rhcFeedMatch = compareLeg(
    BigInt(same.rhc.outputWabit.raw),
    rhc.amountOutWabitRaw,
  );

  const factoryPass =
    ethereum.canonicalUniswapV2Factory;

  const venuePass =
    rhc.venueName === same.rhc.venue;

  const inputPass =
    ethereum.amountInWethRaw ===
      BigInt(same.notionalWeth.raw) &&
    rhc.amountInRequestedRaw ===
      BigInt(same.notionalWeth.raw);

  const status =
    ethereumFeedMatch.status === "PASS" &&
    rhcFeedMatch.status === "PASS" &&
    factoryPass &&
    venuePass &&
    inputPass
      ? "PASS"
      : "FAIL";

  return {
    status,

    ethereum,
    rhc,

    ethereumFeedMatch,
    rhcFeedMatch,

    toleranceBps:
      config.verificationToleranceBps,

    executionBasis:
      status === "PASS"
        ? "VERIFIED_MARKET_STATE"
        : "UNVERIFIED_MARKET_STATE",

    // Phase 2 proves the observed market state.
    // It does not yet prove an economically executable
    // two-leg cross-chain arbitrage.
    arbExecution: "NOT_YET_PROVEN",
  };
}
