import {
  Contract,
  FetchRequest,
  JsonRpcProvider,
  MaxUint256,
  type Provider,
  Wallet,
} from "ethers";

import { config } from "../config.js";

import {
  ADDRESSES,
  ERC20_ABI,
  RHC_TRADE_ROUTER_ABI,
  UNISWAP_V2_ROUTER02_ABI,
  WETH_ABI,
} from "../contracts.js";

import {
  modelEthereumBuy,
  verifyEthereumBuy,
} from "../market/ethereum.js";

import type {
  Phase4Simulation,
} from "../simulation/fork.js";

import {
  evaluatePaperExecutionGate,
} from "./paperGate.js";

import type {
  PaperExecutionGate,
} from "./paperGate.js";

const DEADLINE_SECONDS =
  120n;

const GAS_LIMIT_PADDING_NUMERATOR =
  125n;

const GAS_LIMIT_PADDING_DENOMINATOR =
  100n;

const MIN_GAS_RESERVE_MULTIPLIER =
  10n;

export type LiveExecutionStatus =
  | "EXECUTED"
  | "ABORTED"
  | "CRITICAL_HEDGE_FAILED";

export interface LiveTransactionResult {
  chain:
    | "Ethereum"
    | "RHC";

  action:
    string;

  txHash:
    string;

  gasUsed:
    bigint;

  feePaidWei:
    bigint;
}

export interface LiveBootstrapSummary {
  wrappedWethRaw:
    bigint;

  ethereumApprovalExecuted:
    boolean;

  rhcApprovalExecuted:
    boolean;

  transactions:
    LiveTransactionResult[];
}

export interface LiveExecutionResult {
  status:
    LiveExecutionStatus;

  wallet:
    string;

  reason:
    string;

  bootstrap:
    LiveBootstrapSummary;

  rhcSell:
    LiveTransactionResult
    | null;

  ethereumBuy:
    LiveTransactionResult
    | null;

  rhcWethReceivedRaw:
    bigint;

  ethereumWabitReceivedRaw:
    bigint;

  soldWabitRaw:
    bigint;

  inputWethRaw:
    bigint;

  realizedGasWei:
    bigint;

  realizedNetWethRaw:
    bigint | null;

  openedCircuitBreaker:
    boolean;
}

interface Providers {
  ethereum:
    JsonRpcProvider;

  rhc:
    JsonRpcProvider;
}

interface Signers {
  ethereum:
    Wallet;

  rhc:
    Wallet;

  address:
    string;
}

function ethereumProvider():
  JsonRpcProvider {
  const request =
    new FetchRequest(
      config.ethereumRpcUrl,
    );

  if (
    config.ethereumRpcApiKey
  ) {
    request.setHeader(
      "x-api-key",
      config.ethereumRpcApiKey,
    );
  }

  return new JsonRpcProvider(
    request,
    ADDRESSES.ethereum
      .chainId,
    {
      staticNetwork:
        true,
      batchMaxCount: 1,
    },
  );
}

function rhcProvider():
  JsonRpcProvider {
  return new JsonRpcProvider(
    config.rhcRpcUrl,
    {
      chainId:
        ADDRESSES.rhc
          .chainId,
      name:
        "Robinhood Chain",
    },
    {
      staticNetwork:
        true,
      batchMaxCount: 1,
    },
  );
}

function loadPrivateKey():
  string {
  const raw =
    process.env
      .EXECUTOR_PRIVATE_KEY
      ?.trim();

  if (!raw) {
    throw new Error(
      "EXECUTOR_PRIVATE_KEY is missing.",
    );
  }

  return raw.startsWith(
    "0x",
  )
    ? raw
    : `0x${raw}`;
}

function paddedGasLimit(
  estimate: bigint,
): bigint {
  return (
    estimate *
      GAS_LIMIT_PADDING_NUMERATOR +
    GAS_LIMIT_PADDING_DENOMINATOR -
    1n
  ) /
    GAS_LIMIT_PADDING_DENOMINATOR;
}

async function gasPrice(
  provider:
    Provider,
): Promise<bigint> {
  const feeData =
    await provider
      .getFeeData();

  if (
    feeData.gasPrice ==
    null
  ) {
    throw new Error(
      "RPC did not return gasPrice.",
    );
  }

  return feeData.gasPrice;
}

async function deadline(
  provider:
    Provider,
): Promise<bigint> {
  const block =
    await provider.getBlock(
      "latest",
    );

  if (!block) {
    throw new Error(
      "Unable to read latest block for transaction deadline.",
    );
  }

  return (
    BigInt(
      block.timestamp,
    ) +
    DEADLINE_SECONDS
  );
}

async function createSigners(
  providers:
    Providers,
): Promise<Signers> {
  if (
    !config.liveExecution ||
    !config.executorAddress
  ) {
    throw new Error(
      "Live signer requested while live execution is disabled.",
    );
  }

  const privateKey =
    loadPrivateKey();

  const ethereum =
    new Wallet(
      privateKey,
      providers.ethereum,
    );

  const rhc =
    new Wallet(
      privateKey,
      providers.rhc,
    );

  const [
    ethAddress,
    rhcAddress,
  ] =
    await Promise.all([
      ethereum.getAddress(),
      rhc.getAddress(),
    ]);

  const expected =
    config.executorAddress;

  if (
    ethAddress.toLowerCase() !==
      expected.toLowerCase() ||
    rhcAddress.toLowerCase() !==
      expected.toLowerCase()
  ) {
    throw new Error(
      `Signer mismatch: derived ${ethAddress}, expected ${expected}.`,
    );
  }

  const [
    ethNetwork,
    rhcNetwork,
  ] =
    await Promise.all([
      providers.ethereum
        .getNetwork(),
      providers.rhc
        .getNetwork(),
    ]);

  if (
    ethNetwork.chainId !==
    BigInt(
      ADDRESSES.ethereum
        .chainId,
    )
  ) {
    throw new Error(
      `Ethereum provider chain mismatch: ${ethNetwork.chainId.toString()}`,
    );
  }

  if (
    rhcNetwork.chainId !==
    BigInt(
      ADDRESSES.rhc
        .chainId,
    )
  ) {
    throw new Error(
      `RHC provider chain mismatch: ${rhcNetwork.chainId.toString()}`,
    );
  }

  return {
    ethereum,
    rhc,
    address:
      expected,
  };
}

async function receiptResult(
  chain:
    | "Ethereum"
    | "RHC",
  action:
    string,
  tx: {
    hash:
      string;

    wait:
      () =>
        Promise<
          | {
              status:
                number | null;

              gasUsed:
                bigint;

              fee:
                bigint;
            }
          | null
        >;
  },
): Promise<
  LiveTransactionResult
> {
  const receipt =
    await tx.wait();

  if (!receipt) {
    throw new Error(
      `${chain} ${action} returned no receipt.`,
    );
  }

  if (
    receipt.status !== 1
  ) {
    throw new Error(
      `${chain} ${action} reverted: ${tx.hash}`,
    );
  }

  return {
    chain,
    action,
    txHash:
      tx.hash,
    gasUsed:
      receipt.gasUsed,
    feePaidWei:
      receipt.fee,
  };
}

async function bootstrapIfNeeded(
  signers:
    Signers,
  gate:
    PaperExecutionGate,
): Promise<
  LiveBootstrapSummary
> {
  const readiness =
    gate.walletReadiness;

  if (!readiness) {
    throw new Error(
      "Wallet readiness is unavailable.",
    );
  }

  if (
    readiness.wallet
      .toLowerCase() !==
    signers.address
      .toLowerCase()
  ) {
    throw new Error(
      "Readiness wallet does not match live signer.",
    );
  }

  const ethWeth =
    new Contract(
      ADDRESSES.ethereum
        .weth,
      WETH_ABI,
      signers.ethereum,
    );

  const rhcWabit =
    new Contract(
      ADDRESSES.rhc.wabit,
      ERC20_ABI,
      signers.rhc,
    );

  const [
    currentWeth,
    currentEthAllowance,
    currentRhcWabit,
    currentRhcAllowance,
    currentEthNative,
    currentRhcNative,
  ] =
    await Promise.all([
      ethWeth.balanceOf(
        signers.address,
      ),
      ethWeth.allowance(
        signers.address,
        ADDRESSES.ethereum
          .uniswapV2Router02,
      ),
      rhcWabit.balanceOf(
        signers.address,
      ),
      rhcWabit.allowance(
        signers.address,
        ADDRESSES.rhc
          .tradeRouter,
      ),
      signers.ethereum
        .provider!
        .getBalance(
          signers.address,
        ),
      signers.rhc
        .provider!
        .getBalance(
          signers.address,
        ),
    ]);

  const wethBalance =
    BigInt(currentWeth);

  const ethAllowance =
    BigInt(
      currentEthAllowance,
    );

  const rhcWabitBalance =
    BigInt(
      currentRhcWabit,
    );

  const rhcAllowance =
    BigInt(
      currentRhcAllowance,
    );

  const requiredWeth =
    readiness.ethereum
      .requiredTradeAssetRaw;

  const requiredRhcWabit =
    readiness.rhc
      .requiredTradeAssetRaw;

  if (
    rhcWabitBalance <
    requiredRhcWabit
  ) {
    throw new Error(
      "Live RHC WABIT inventory is below the protected sell requirement.",
    );
  }

  const wrapShortfall =
    wethBalance >=
      requiredWeth
      ? 0n
      : requiredWeth -
        wethBalance;

  const transactions:
    LiveTransactionResult[] =
    [];

  /*
   * Keep a larger native-gas cushion than Phase 5D's minimum.
   * The autowrapper is allowed to consume only ETH above ten modeled trade
   * gas budgets.
   */
  const ethGasReserve =
    readiness.ethereum
      .requiredGasWei *
    MIN_GAS_RESERVE_MULTIPLIER;

  const rhcGasReserve =
    readiness.rhc
      .requiredGasWei *
    MIN_GAS_RESERVE_MULTIPLIER;

  if (
    currentEthNative <
    wrapShortfall +
      ethGasReserve
  ) {
    throw new Error(
      "Ethereum native balance cannot fund the WETH shortfall while preserving the live gas reserve.",
    );
  }

  if (
    currentRhcNative <
    rhcGasReserve
  ) {
    throw new Error(
      "RHC native balance is below the live gas reserve.",
    );
  }

  if (
    wrapShortfall >
    0n
  ) {
    const estimate =
      BigInt(
        await ethWeth
          .deposit
          .estimateGas({
            value:
              wrapShortfall,
          }),
      );

    const tx =
      await ethWeth.deposit({
        value:
          wrapShortfall,

        gasLimit:
          paddedGasLimit(
            estimate,
          ),

        gasPrice:
          await gasPrice(
            signers.ethereum
              .provider!,
          ),
      });

    transactions.push(
      await receiptResult(
        "Ethereum",
        "WRAP_ETH_TO_WETH",
        tx,
      ),
    );
  }

  let ethereumApprovalExecuted =
    false;

  if (
    ethAllowance <
    requiredWeth
  ) {
    const estimate =
      BigInt(
        await ethWeth
          .approve
          .estimateGas(
            ADDRESSES.ethereum
              .uniswapV2Router02,
            MaxUint256,
          ),
      );

    const tx =
      await ethWeth.approve(
        ADDRESSES.ethereum
          .uniswapV2Router02,
        MaxUint256,
        {
          gasLimit:
            paddedGasLimit(
              estimate,
            ),

          gasPrice:
            await gasPrice(
              signers.ethereum
                .provider!,
            ),
        },
      );

    transactions.push(
      await receiptResult(
        "Ethereum",
        "APPROVE_WETH_ROUTER02",
        tx,
      ),
    );

    ethereumApprovalExecuted =
      true;
  }

  let rhcApprovalExecuted =
    false;

  if (
    rhcAllowance <
    requiredRhcWabit
  ) {
    const estimate =
      BigInt(
        await rhcWabit
          .approve
          .estimateGas(
            ADDRESSES.rhc
              .tradeRouter,
            MaxUint256,
          ),
      );

    const tx =
      await rhcWabit.approve(
        ADDRESSES.rhc
          .tradeRouter,
        MaxUint256,
        {
          gasLimit:
            paddedGasLimit(
              estimate,
            ),

          gasPrice:
            await gasPrice(
              signers.rhc
                .provider!,
            ),
        },
      );

    transactions.push(
      await receiptResult(
        "RHC",
        "APPROVE_WABIT_TRADE_ROUTER",
        tx,
      ),
    );

    rhcApprovalExecuted =
      true;
  }

  return {
    wrappedWethRaw:
      wrapShortfall,

    ethereumApprovalExecuted,

    rhcApprovalExecuted,

    transactions,
  };
}

function emptyBootstrap():
  LiveBootstrapSummary {
  return {
    wrappedWethRaw: 0n,
    ethereumApprovalExecuted:
      false,
    rhcApprovalExecuted:
      false,
    transactions: [],
  };
}

function bootstrapGasWei(
  bootstrap:
    LiveBootstrapSummary,
): bigint {
  return bootstrap
    .transactions
    .reduce(
      (
        total,
        tx,
      ) =>
        total +
        tx.feePaidWei,
      0n,
    );
}

async function executeRhcSell(
  signers:
    Signers,
  gate:
    PaperExecutionGate,
): Promise<{
  tx:
    LiveTransactionResult;

  wethReceivedRaw:
    bigint;

  soldWabitRaw:
    bigint;
}> {
  const protection =
    gate.protection;

  if (!protection) {
    throw new Error(
      "Execution protection is unavailable.",
    );
  }

  const router =
    new Contract(
      ADDRESSES.rhc
        .tradeRouter,
      RHC_TRADE_ROUTER_ABI,
      signers.rhc,
    );

  const weth =
    new Contract(
      ADDRESSES.rhc.weth,
      ERC20_ABI,
      signers.rhc,
    );

  const amountIn =
    protection
      .rhcSellInputWabitRaw;

  const amountOutMin =
    protection
      .rhcMinimumWethRaw;

  const txDeadline =
    await deadline(
      signers.rhc
        .provider!,
    );

  const args = [
    ADDRESSES.rhc.wabit,
    ADDRESSES.rhc.weth,
    amountIn,
    amountOutMin,
    signers.address,
    txDeadline,
  ] as const;

  const preview =
    await router
      .swapExactInput
      .staticCall(
        ...args,
      );

  const previewInUsed =
    BigInt(
      preview[0],
    );

  const previewOut =
    BigInt(
      preview[1],
    );

  const previewRefund =
    BigInt(
      preview[2],
    );

  if (
    previewInUsed !==
      amountIn ||
    previewRefund !== 0n ||
    previewOut <
      amountOutMin
  ) {
    throw new Error(
      "Final RHC static preflight no longer satisfies the protected execution envelope.",
    );
  }

  const before =
    BigInt(
      await weth.balanceOf(
        signers.address,
      ),
    );

  const estimate =
    BigInt(
      await router
        .swapExactInput
        .estimateGas(
          ...args,
        ),
    );

  const tx =
    await router
      .swapExactInput(
        ...args,
        {
          gasLimit:
            paddedGasLimit(
              estimate,
            ),

          gasPrice:
            await gasPrice(
              signers.rhc
                .provider!,
            ),
        },
      );

  const result =
    await receiptResult(
      "RHC",
      "SELL_WABIT_FOR_WETH",
      tx,
    );

  const after =
    BigInt(
      await weth.balanceOf(
        signers.address,
      ),
    );

  const received =
    after - before;

  if (
    received <
    amountOutMin
  ) {
    throw new Error(
      "RHC sell mined but recipient WETH delta is below amountOutMin.",
    );
  }

  return {
    tx:
      result,

    wethReceivedRaw:
      received,

    soldWabitRaw:
      amountIn,
  };
}

async function executeEthereumHedge(
  signers:
    Signers,
  simulation:
    Phase4Simulation,
  soldWabitRaw:
    bigint,
): Promise<{
  tx:
    LiveTransactionResult;

  wabitReceivedRaw:
    bigint;
}> {
  /*
   * Once the RHC sell has mined, the Ethereum buy is a hedge/replenishment
   * obligation. Re-check that the current pool still models at least the
   * WABIT amount already sold on RHC.
   */
  const ethereum =
    await verifyEthereumBuy();

  const modeled =
    modelEthereumBuy(
      simulation.candidate
        .requestedWethRaw,
      ethereum,
    );

  if (
    modeled.netWabitOutRaw <
    soldWabitRaw
  ) {
    throw new Error(
      `Ethereum hedge no longer models enough WABIT to replenish the RHC sale: expected ${modeled.netWabitOutRaw.toString()}, required ${soldWabitRaw.toString()}.`,
    );
  }

  const router =
    new Contract(
      ADDRESSES.ethereum
        .uniswapV2Router02,
      UNISWAP_V2_ROUTER02_ABI,
      signers.ethereum,
    );

  const wabit =
    new Contract(
      ADDRESSES.ethereum
        .wabit,
      ERC20_ABI,
      signers.ethereum,
    );

  const txDeadline =
    await deadline(
      signers.ethereum
        .provider!,
    );

  const args = [
    simulation.candidate
      .requestedWethRaw,
    soldWabitRaw,
    [
      ADDRESSES.ethereum
        .weth,
      ADDRESSES.ethereum
        .wabit,
    ],
    signers.address,
    txDeadline,
  ] as const;

  /*
   * eth_call preflight from the funded/approved signer.
   * The supporting-fee-on-transfer router function returns no value, so
   * success is represented by a non-reverting call.
   */
  await router
    .swapExactTokensForTokensSupportingFeeOnTransferTokens
    .staticCall(
      ...args,
    );

  const before =
    BigInt(
      await wabit.balanceOf(
        signers.address,
      ),
    );

  const estimate =
    BigInt(
      await router
        .swapExactTokensForTokensSupportingFeeOnTransferTokens
        .estimateGas(
          ...args,
        ),
    );

  const tx =
    await router
      .swapExactTokensForTokensSupportingFeeOnTransferTokens(
        ...args,
        {
          gasLimit:
            paddedGasLimit(
              estimate,
            ),

          gasPrice:
            await gasPrice(
              signers.ethereum
                .provider!,
            ),
        },
      );

  const result =
    await receiptResult(
      "Ethereum",
      "BUY_WABIT_WITH_WETH",
      tx,
    );

  const after =
    BigInt(
      await wabit.balanceOf(
        signers.address,
      ),
    );

  const received =
    after - before;

  if (
    received <
    soldWabitRaw
  ) {
    throw new Error(
      `Ethereum hedge mined but received ${received.toString()} WABIT, below the ${soldWabitRaw.toString()} WABIT already sold on RHC.`,
    );
  }

  return {
    tx:
      result,

    wabitReceivedRaw:
      received,
  };
}

interface LiveTradePreflight {
  ethereumGasEstimate:
    bigint;

  rhcGasEstimate:
    bigint;

  ethereumGasPriceWei:
    bigint;

  rhcGasPriceWei:
    bigint;

  estimatedTradeGasWei:
    bigint;

  maximumTradeGasWei:
    bigint;

  estimatedProtectedNetWethRaw:
    bigint;

  maximumFeeProtectedNetWethRaw:
    bigint;
}

async function preflightLiveTrade(
  signers:
    Signers,
  simulation:
    Phase4Simulation,
  gate:
    PaperExecutionGate,
): Promise<LiveTradePreflight> {
  const protection =
    gate.protection;

  if (!protection) {
    throw new Error(
      "Live preflight requires an execution-protection envelope.",
    );
  }

  const rhcRouter =
    new Contract(
      ADDRESSES.rhc
        .tradeRouter,
      RHC_TRADE_ROUTER_ABI,
      signers.rhc,
    );

  const ethereumRouter =
    new Contract(
      ADDRESSES.ethereum
        .uniswapV2Router02,
      UNISWAP_V2_ROUTER02_ABI,
      signers.ethereum,
    );

  const rhcDeadline =
    await deadline(
      signers.rhc.provider!,
    );

  const ethereumDeadline =
    await deadline(
      signers.ethereum.provider!,
    );

  const rhcArgs = [
    ADDRESSES.rhc.wabit,
    ADDRESSES.rhc.weth,
    protection
      .rhcSellInputWabitRaw,
    protection
      .rhcMinimumWethRaw,
    signers.address,
    rhcDeadline,
  ] as const;

  const rhcPreview =
    await rhcRouter
      .swapExactInput
      .staticCall(
        ...rhcArgs,
      );

  const rhcPreviewInUsed =
    BigInt(
      rhcPreview[0],
    );

  const rhcPreviewOut =
    BigInt(
      rhcPreview[1],
    );

  const rhcPreviewRefund =
    BigInt(
      rhcPreview[2],
    );

  if (
    rhcPreviewInUsed !==
      protection
        .rhcSellInputWabitRaw ||
    rhcPreviewRefund !== 0n ||
    rhcPreviewOut <
      protection
        .rhcMinimumWethRaw
  ) {
    throw new Error(
      "Final live RHC static preflight no longer satisfies the protected route.",
    );
  }

  const ethereum =
    await verifyEthereumBuy();

  const modeledEthereum =
    modelEthereumBuy(
      simulation.candidate
        .requestedWethRaw,
      ethereum,
    );

  if (
    modeledEthereum
      .netWabitOutRaw <
    protection
      .rhcSellInputWabitRaw
  ) {
    throw new Error(
      "Final live Ethereum model no longer replenishes the protected RHC WABIT sale.",
    );
  }

  const ethereumArgs = [
    simulation.candidate
      .requestedWethRaw,
    protection
      .rhcSellInputWabitRaw,
    [
      ADDRESSES.ethereum
        .weth,
      ADDRESSES.ethereum
        .wabit,
    ],
    signers.address,
    ethereumDeadline,
  ] as const;

  await ethereumRouter
    .swapExactTokensForTokensSupportingFeeOnTransferTokens
    .staticCall(
      ...ethereumArgs,
    );

  const [
    rhcGasEstimateRaw,
    ethereumGasEstimateRaw,
    rhcGasPriceWei,
    ethereumGasPriceWei,
  ] =
    await Promise.all([
      rhcRouter
        .swapExactInput
        .estimateGas(
          ...rhcArgs,
        ),

      ethereumRouter
        .swapExactTokensForTokensSupportingFeeOnTransferTokens
        .estimateGas(
          ...ethereumArgs,
        ),

      gasPrice(
        signers.rhc
          .provider!,
      ),

      gasPrice(
        signers.ethereum
          .provider!,
      ),
    ]);

  const rhcGasEstimate =
    BigInt(
      rhcGasEstimateRaw,
    );

  const ethereumGasEstimate =
    BigInt(
      ethereumGasEstimateRaw,
    );

  const estimatedTradeGasWei =
    rhcGasEstimate *
      rhcGasPriceWei +
    ethereumGasEstimate *
      ethereumGasPriceWei;

  const maximumTradeGasWei =
    paddedGasLimit(
      rhcGasEstimate,
    ) *
      rhcGasPriceWei +
    paddedGasLimit(
      ethereumGasEstimate,
    ) *
      ethereumGasPriceWei;

  const protectedGrossAfterInput =
    protection
      .rhcMinimumWethRaw -
    simulation.candidate
      .requestedWethRaw;

  const estimatedProtectedNetWethRaw =
    protectedGrossAfterInput -
    estimatedTradeGasWei;

  const maximumFeeProtectedNetWethRaw =
    protectedGrossAfterInput -
    maximumTradeGasWei;

  /*
   * Preserve the Phase 5B policy using the exact current live-call gas
   * estimates, rather than relying only on historical/fork gas units.
   */
  if (
    estimatedProtectedNetWethRaw <
    protection
      .protectedNetFloorWethRaw
  ) {
    throw new Error(
      `Exact live gas estimates reduce protected net below the retained-profit floor: ${estimatedProtectedNetWethRaw.toString()} < ${protection.protectedNetFloorWethRaw.toString()}.`,
    );
  }

  /*
   * Even if both transactions consume the full 25%-padded gas limits,
   * the protected route must not become negative.
   */
  if (
    maximumFeeProtectedNetWethRaw <=
    0n
  ) {
    throw new Error(
      "Maximum live gas exposure would erase the protected trade profit.",
    );
  }

  return {
    ethereumGasEstimate,
    rhcGasEstimate,
    ethereumGasPriceWei,
    rhcGasPriceWei,
    estimatedTradeGasWei,
    maximumTradeGasWei,
    estimatedProtectedNetWethRaw,
    maximumFeeProtectedNetWethRaw,
  };
}

export function gateCanReachLiveExecution(
  gate:
    PaperExecutionGate,
): boolean {
  if (
    gate.protection == null ||
    gate.netProfitWethRaw <=
      0n
  ) {
    return false;
  }

  if (
    gate.walletReadiness
      ?.ready
  ) {
    return true;
  }

  return (
    gate.bootstrapSimulation
      ?.simulatedReady ===
    true
  );
}

export async function executeLiveOpportunity(
  simulation:
    Phase4Simulation,
  initialGate:
    PaperExecutionGate,
): Promise<
  LiveExecutionResult
> {
  if (
    !config.liveExecution
  ) {
    throw new Error(
      "executeLiveOpportunity called while live execution is disabled.",
    );
  }

  if (
    !gateCanReachLiveExecution(
      initialGate,
    )
  ) {
    throw new Error(
      "Initial gate does not qualify for bootstrap/live execution.",
    );
  }

  /*
   * Before spending bootstrap gas, make sure the one-time bootstrap itself
   * does not consume the entire protected profit floor.
   */
  if (
    initialGate
      .bootstrapSimulation
      ?.simulatedReady
  ) {
    const simulatedBootstrapGas =
      initialGate
        .bootstrapSimulation
        .ethereumWrap
        .gasCostWei +
      initialGate
        .bootstrapSimulation
        .ethereumApproval
        .gasCostWei +
      initialGate
        .bootstrapSimulation
        .rhcApproval
        .gasCostWei;

    if (
      initialGate.protection &&
      initialGate
        .protection
        .protectedNetWethRaw <=
      simulatedBootstrapGas
    ) {
      throw new Error(
        "One-time bootstrap gas would consume the protected profit floor; live execution refused.",
      );
    }
  }

  const providers:
    Providers = {
      ethereum:
        ethereumProvider(),

      rhc:
        rhcProvider(),
  };

  let bootstrap =
    emptyBootstrap();

  try {
    const signers =
      await createSigners(
        providers,
      );

    bootstrap =
      await bootstrapIfNeeded(
        signers,
        initialGate,
      );

    /*
     * Bootstrap may take multiple blocks. Throw away the old execution
     * decision and rebuild it from fresh chain state before any swap.
     */
    const finalGate =
      await evaluatePaperExecutionGate(
        simulation,
      );

    if (
      finalGate.action !==
        "WOULD_EXECUTE" ||
      finalGate.protection ==
        null ||
      finalGate
        .walletReadiness
        ?.ready !== true
    ) {
      return {
        status:
          "ABORTED",

        wallet:
          signers.address,

        reason:
          `Fresh post-bootstrap gate refused execution: ${finalGate.reason}`,

        bootstrap,

        rhcSell:
          null,

        ethereumBuy:
          null,

        rhcWethReceivedRaw:
          0n,

        ethereumWabitReceivedRaw:
          0n,

        soldWabitRaw:
          0n,

        inputWethRaw:
          simulation
            .candidate
            .requestedWethRaw,

        realizedGasWei:
          bootstrapGasWei(
            bootstrap,
          ),

        realizedNetWethRaw:
          null,

        openedCircuitBreaker:
          false,
      };
    }

    /*
     * Final exact live-call preflight.
     *
     * Uses fresh gas prices + estimateGas() for both protected swap calls.
     * The transaction is refused if exact current gas economics no longer
     * preserve the Phase 5B retained-profit floor.
     */
    await preflightLiveTrade(
      signers,
      simulation,
      finalGate,
    );

    /*
     * Capacity-sensitive RHC leg first.
     *
     * If it fails, Ethereum is untouched.
     */
    const rhcSell =
      await executeRhcSell(
        signers,
        finalGate,
      );

    try {
      /*
       * Once the RHC leg succeeds, complete the Ethereum hedge. Failure here
       * is a critical partial execution: stop future autonomous executions.
       */
      const ethereumBuy =
        await executeEthereumHedge(
          signers,
          simulation,
          rhcSell
            .soldWabitRaw,
        );

      const realizedGasWei =
        bootstrapGasWei(
          bootstrap,
        ) +
        rhcSell.tx
          .feePaidWei +
        ethereumBuy.tx
          .feePaidWei;

      const realizedNetWethRaw =
        rhcSell
          .wethReceivedRaw -
        simulation.candidate
          .requestedWethRaw -
        realizedGasWei;

      return {
        status:
          "EXECUTED",

        wallet:
          signers.address,

        reason:
          "Both protected live legs mined successfully.",

        bootstrap,

        rhcSell:
          rhcSell.tx,

        ethereumBuy:
          ethereumBuy.tx,

        rhcWethReceivedRaw:
          rhcSell
            .wethReceivedRaw,

        ethereumWabitReceivedRaw:
          ethereumBuy
            .wabitReceivedRaw,

        soldWabitRaw:
          rhcSell
            .soldWabitRaw,

        inputWethRaw:
          simulation
            .candidate
            .requestedWethRaw,

        realizedGasWei,

        realizedNetWethRaw,

        openedCircuitBreaker:
          false,
      };
    } catch (error: unknown) {
      const message =
        error instanceof Error
          ? error.message
          : String(error);

      return {
        status:
          "CRITICAL_HEDGE_FAILED",

        wallet:
          signers.address,

        reason:
          `RHC sell succeeded but Ethereum hedge failed: ${message}`,

        bootstrap,

        rhcSell:
          rhcSell.tx,

        ethereumBuy:
          null,

        rhcWethReceivedRaw:
          rhcSell
            .wethReceivedRaw,

        ethereumWabitReceivedRaw:
          0n,

        soldWabitRaw:
          rhcSell
            .soldWabitRaw,

        inputWethRaw:
          simulation
            .candidate
            .requestedWethRaw,

        realizedGasWei:
          bootstrapGasWei(
            bootstrap,
          ) +
          rhcSell.tx
            .feePaidWei,

        realizedNetWethRaw:
          null,

        openedCircuitBreaker:
          true,
      };
    }
  } finally {
    providers.ethereum
      .destroy();

    providers.rhc
      .destroy();
  }
}
