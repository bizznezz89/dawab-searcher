import {
  Contract,
  JsonRpcProvider,
} from "ethers";

import { config } from "../config.js";
import {
  ADDRESSES,
  RHC_TRADE_ROUTER_ABI,
  SAME_NOTIONAL_WETH,
  venueName,
} from "../contracts.js";
import type {
  RhcVerification,
} from "../types.js";

const provider = new JsonRpcProvider(
  config.rhcRpcUrl,
  {
    chainId: ADDRESSES.rhc.chainId,
    name: "Robinhood Chain",
  },
  {
    staticNetwork: true,
  },
);

const router = new Contract(
  ADDRESSES.rhc.tradeRouter,
  RHC_TRADE_ROUTER_ABI,
  provider,
);

export async function verifyRhcBuy(): Promise<RhcVerification> {
  const [
    network,
    blockNumber,
    quote,
  ] = await Promise.all([
    provider.getNetwork(),
    provider.getBlockNumber(),
    router.quoteExactInput(
      ADDRESSES.rhc.weth,
      ADDRESSES.rhc.wabit,
      SAME_NOTIONAL_WETH,
    ),
  ]);

  if (
    network.chainId !==
    BigInt(ADDRESSES.rhc.chainId)
  ) {
    throw new Error(
      `RHC RPC returned chain ID ${network.chainId.toString()}, expected ${ADDRESSES.rhc.chainId}`,
    );
  }

  const venue = BigInt(quote[0]);
  const amountInUsedRaw = BigInt(quote[1]);
  const amountOutWabitRaw = BigInt(quote[2]);
  const refundWethRaw = BigInt(quote[3]);

  if (
    amountInUsedRaw + refundWethRaw !==
    SAME_NOTIONAL_WETH
  ) {
    throw new Error(
      "RHC router quote does not reconcile amountInUsed + refundAmount to requested input",
    );
  }

  return {
    chainId: network.chainId,
    blockNumber,

    venue,
    venueName: venueName(venue),

    amountInRequestedRaw:
      SAME_NOTIONAL_WETH,
    amountInUsedRaw,
    amountOutWabitRaw,
    refundWethRaw,
  };
}
