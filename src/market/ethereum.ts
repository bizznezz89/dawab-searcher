import {
  Contract,
  FetchRequest,
  JsonRpcProvider,
  getAddress,
} from "ethers";

import { config } from "../config.js";
import {
  ADDRESSES,
  BPS_DENOMINATOR,
  SAME_NOTIONAL_WETH,
  UNISWAP_V2_PAIR_ABI,
  V2_FEE_DENOMINATOR,
  V2_FEE_NUMERATOR,
  WABIT_TRANSFER_BURN_BPS,
} from "../contracts.js";
import type {
  EthereumVerification,
} from "../types.js";

/*
 * Build an authenticated request object when an API key is present.
 *
 * Tatum expects:
 *   x-api-key: <key>
 *
 * Providers such as Infura and Alchemy normally embed authentication
 * in the RPC URL, so ETHEREUM_RPC_API_KEY can remain unset for them.
 */
const ethereumRequest = new FetchRequest(
  config.ethereumRpcUrl,
);

if (config.ethereumRpcApiKey) {
  ethereumRequest.setHeader(
    "x-api-key",
    config.ethereumRpcApiKey,
  );
}

/*
 * batchMaxCount: 1 disables ethers v6 JSON-RPC batching.
 * This keeps Phase 2 compatible with free RPC tiers that reject batch calls.
 */
const provider = new JsonRpcProvider(
  ethereumRequest,
  ADDRESSES.ethereum.chainId,
  {
    staticNetwork: true,
    batchMaxCount: 1,
  },
);

const pair = new Contract(
  ADDRESSES.ethereum.wabitWethPair,
  UNISWAP_V2_PAIR_ABI,
  provider,
);

function v2AmountOut(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
): bigint {
  if (
    amountIn <= 0n ||
    reserveIn <= 0n ||
    reserveOut <= 0n
  ) {
    return 0n;
  }

  const amountInWithFee =
    amountIn * V2_FEE_NUMERATOR;

  const numerator =
    amountInWithFee * reserveOut;

  const denominator =
    reserveIn * V2_FEE_DENOMINATOR +
    amountInWithFee;

  return numerator / denominator;
}

function applyWabitTransferBurn(
  grossAmount: bigint,
): {
  burn: bigint;
  net: bigint;
} {
  const burn =
    (grossAmount * WABIT_TRANSFER_BURN_BPS) /
    BPS_DENOMINATOR;

  return {
    burn,
    net: grossAmount - burn,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) =>
    setTimeout(resolve, ms),
  );
}

/*
 * Keep reads deliberately sequential.
 * This is a verification path, not a latency race.
 */
export async function verifyEthereumBuy(): Promise<EthereumVerification> {
  const network = await provider.getNetwork();

  if (
    network.chainId !==
    BigInt(ADDRESSES.ethereum.chainId)
  ) {
    throw new Error(
      `Ethereum RPC returned chain ID ${network.chainId.toString()}, expected ${ADDRESSES.ethereum.chainId}`,
    );
  }

  const blockNumber =
    await provider.getBlockNumber();

  await sleep(375);

  const token0 = getAddress(
    await pair.token0(),
  );

  await sleep(375);

  const token1 = getAddress(
    await pair.token1(),
  );

  await sleep(375);

  const factory = getAddress(
    await pair.factory(),
  );

  await sleep(375);

  const reserves =
    await pair.getReserves();

  const reserve0 = BigInt(reserves[0]);
  const reserve1 = BigInt(reserves[1]);

  let wethReserveRaw: bigint;
  let wabitReserveRaw: bigint;

  if (
    token0 === ADDRESSES.ethereum.weth &&
    token1 === ADDRESSES.ethereum.wabit
  ) {
    wethReserveRaw = reserve0;
    wabitReserveRaw = reserve1;
  } else if (
    token1 === ADDRESSES.ethereum.weth &&
    token0 === ADDRESSES.ethereum.wabit
  ) {
    wethReserveRaw = reserve1;
    wabitReserveRaw = reserve0;
  } else {
    throw new Error(
      `Unexpected WABIT/WETH pair tokens: ${token0}/${token1}`,
    );
  }

  const grossWabitOutRaw = v2AmountOut(
    SAME_NOTIONAL_WETH,
    wethReserveRaw,
    wabitReserveRaw,
  );

  const transfer =
    applyWabitTransferBurn(
      grossWabitOutRaw,
    );

  return {
    chainId: network.chainId,
    blockNumber,

    pair: ADDRESSES.ethereum.wabitWethPair,
    factory,
    canonicalUniswapV2Factory:
      factory ===
      ADDRESSES.ethereum.uniswapV2Factory,

    token0,
    token1,

    wethReserveRaw,
    wabitReserveRaw,

    amountInWethRaw: SAME_NOTIONAL_WETH,
    grossWabitOutRaw,
    transferBurnRaw: transfer.burn,
    netWabitOutRaw: transfer.net,
  };
}
