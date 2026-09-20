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
  fetchDaWabState,
} from "../market/dawablauncher.js";

import {
  modelEthereumBuy,
  verifyEthereumBuy,
} from "../market/ethereum.js";

import {
  getRhcCurveState,
  tryQuoteRhcExactInput,
  verifyRhcBuy,
} from "../market/rhc.js";

import type {
  OpportunityCandidate,
} from "../types.js";

import {
  verifyAgainstFeed,
} from "../verification.js";

import {
  deriveAutomaticProtection,
} from "./paperGate.js";

import type {
  AutomaticProtectionEnvelope,
} from "./paperGate.js";

const DEADLINE_SECONDS =
  120n;

const GAS_LIMIT_PADDING_NUMERATOR =
  125n;

const GAS_LIMIT_PADDING_DENOMINATOR =
  100n;

/*
 * This is not a gas-calibration profile.
 *
 * It is only a pre-bootstrap native-ETH safety reserve. Exact swap gas is
 * obtained later with estimateGas() after the wallet is ready.
 */
const PREBOOTSTRAP_GAS_RESERVE_UNITS =
  500_000n;

export type HotExecutionStatus =
  | "EXECUTED"
  | "ABORTED"
  | "CRITICAL_HEDGE_FAILED";

export interface HotTransactionResult {
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

export interface HotExecutionResult {
  status:
    HotExecutionStatus;

  wallet:
    string;

  reason:
    string;

  bootstrapTransactions:
    HotTransactionResult[];

  rhcSell:
    HotTransactionResult
    | null;

  ethereumBuy:
    HotTransactionResult
    | null;

  protection:
    AutomaticProtectionEnvelope
    | null;

  inputWethRaw:
    bigint;

  soldWabitRaw:
    bigint;

  rhcWethReceivedRaw:
    bigint;

  ethereumWabitReceivedRaw:
    bigint;

  realizedGasWei:
    bigint;

  realizedNetWethRaw:
    bigint | null;

  openedCircuitBreaker:
    boolean;
}

export interface HotExecutorControl {
  shouldAbort:
    () => boolean;

  log?:
    (message: string) => void;
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

interface FreshRoute {
  ethereumBlock:
    number;

  rhcBlock:
    number;

  expectedWabitRaw:
    bigint;

  expectedRhcWethRaw:
    bigint;

  grossProfitWethRaw:
    bigint;
}

interface BootstrapPlan {
  wrapShortfallRaw:
    bigint;

  ethereumApprovalNeeded:
    boolean;

  rhcApprovalNeeded:
    boolean;

  wrapGasEstimate:
    bigint;

  ethereumApprovalGasEstimate:
    bigint;

  rhcApprovalGasEstimate:
    bigint;

  ethereumGasPriceWei:
    bigint;

  rhcGasPriceWei:
    bigint;

  estimatedMaximumBootstrapFeeWei:
    bigint;
}

interface PreliminaryGas {
  ethereumGasEstimate:
    bigint;

  rhcGasEstimate:
    bigint;

  ethereumGasPriceWei:
    bigint;

  rhcGasPriceWei:
    bigint;

  conservativeGasCostWei:
    bigint;
}

function log(
  control:
    HotExecutorControl,
  message:
    string,
): void {
  control.log?.(
    `[HOT] ${message}`,
  );
}

function abortIfRequested(
  control:
    HotExecutorControl,
  stage:
    string,
): void {
  if (
    control.shouldAbort()
  ) {
    throw new Error(
      `OPERATOR_ABORT:${stage}`,
    );
  }
}

function isOperatorAbort(
  error:
    unknown,
): boolean {
  return (
    error instanceof Error &&
    error.message.startsWith(
      "OPERATOR_ABORT:",
    )
  );
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

function privateKey():
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

  const normalized =
    raw.startsWith("0x")
      ? raw
      : `0x${raw}`;

  if (
    !/^0x[0-9a-fA-F]{64}$/.test(
      normalized,
    )
  ) {
    throw new Error(
      "EXECUTOR_PRIVATE_KEY is not a valid 32-byte EVM private key.",
    );
  }

  return normalized;
}

function paddedGasLimit(
  estimate:
    bigint,
): bigint {
  return (
    estimate *
      GAS_LIMIT_PADDING_NUMERATOR +
    GAS_LIMIT_PADDING_DENOMINATOR -
    1n
  ) /
    GAS_LIMIT_PADDING_DENOMINATOR;
}

async function currentGasPrice(
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
      "RPC did not return a current gas price.",
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
      "Unable to read latest block timestamp.",
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
      "Hot live executor requested while live execution is disabled.",
    );
  }

  const key =
    privateKey();

  const ethereum =
    new Wallet(
      key,
      providers.ethereum,
    );

  const rhc =
    new Wallet(
      key,
      providers.rhc,
    );

  const [
    ethereumAddress,
    rhcAddress,
    ethereumNetwork,
    rhcNetwork,
  ] =
    await Promise.all([
      ethereum.getAddress(),
      rhc.getAddress(),
      providers.ethereum
        .getNetwork(),
      providers.rhc
        .getNetwork(),
    ]);

  const expected =
    config.executorAddress;

  if (
    ethereumAddress
      .toLowerCase() !==
      expected.toLowerCase() ||
    rhcAddress
      .toLowerCase() !==
      expected.toLowerCase()
  ) {
    throw new Error(
      `Signer mismatch: derived ${ethereumAddress}, expected ${expected}.`,
    );
  }

  if (
    ethereumNetwork
      .chainId !==
    BigInt(
      ADDRESSES.ethereum
        .chainId,
    )
  ) {
    throw new Error(
      `Ethereum provider is on chain ${ethereumNetwork.chainId.toString()}, expected 1.`,
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
      `RHC provider is on chain ${rhcNetwork.chainId.toString()}, expected 4663.`,
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
    "Ethereum" | "RHC",
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
  HotTransactionResult
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

async function readFreshRoute(
  candidate:
    OpportunityCandidate,
): Promise<FreshRoute> {
  const state =
    await fetchDaWabState();

  const [
    ethereum,
    rhc,
    rhcCurve,
  ] =
    await Promise.all([
      verifyEthereumBuy(),
      verifyRhcBuy(),
      getRhcCurveState(),
    ]);

  const verification =
    verifyAgainstFeed(
      state,
      ethereum,
      rhc,
    );

  if (
    verification.status !==
    "PASS"
  ) {
    throw new Error(
      "Fresh independent market verification failed.",
    );
  }

  if (
    rhc.venue !== 1n ||
    rhcCurve.graduated ||
    !rhcCurve.activated
  ) {
    throw new Error(
      `RHC route is no longer the proven active BondingCurve venue (${rhc.venueName}).`,
    );
  }

  const ethereumBuy =
    modelEthereumBuy(
      candidate
        .requestedWethRaw,
      ethereum,
    );

  const capacity =
    rhcCurve
      .maxExecutableSellRaw;

  if (
    capacity != null &&
    ethereumBuy
      .netWabitOutRaw >
      capacity
  ) {
    throw new Error(
      "Fresh Ethereum output exceeds current RHC sell capacity.",
    );
  }

  const quoteResult =
    await tryQuoteRhcExactInput(
      ADDRESSES.rhc.wabit,
      ADDRESSES.rhc.weth,
      ethereumBuy
        .netWabitOutRaw,
    );

  if (!quoteResult.ok) {
    throw new Error(
      `Fresh RHC sell quote reverted: ${quoteResult.failure.errorName}`,
    );
  }

  const quote =
    quoteResult.quote;

  if (
    quote.venue !== 1n ||
    quote.amountInUsedRaw !==
      ethereumBuy
        .netWabitOutRaw ||
    quote.refundAmountRaw !==
      0n
  ) {
    throw new Error(
      "Fresh RHC quote is not a full active-curve fill.",
    );
  }

  const grossProfitWethRaw =
    quote.amountOutRaw -
    candidate
      .requestedWethRaw;

  if (
    grossProfitWethRaw <=
    0n
  ) {
    throw new Error(
      "Fresh two-leg route is no longer gross-profitable.",
    );
  }

  return {
    ethereumBlock:
      ethereum.blockNumber,

    rhcBlock:
      rhc.blockNumber,

    expectedWabitRaw:
      ethereumBuy
        .netWabitOutRaw,

    expectedRhcWethRaw:
      quote.amountOutRaw,

    grossProfitWethRaw,
  };
}

async function planBootstrap(
  signers:
    Signers,
  candidate:
    OpportunityCandidate,
  expectedRhcWabitRaw:
    bigint,
): Promise<BootstrapPlan> {
  const ethereumWeth =
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
    wethBalanceRaw,
    ethereumAllowanceRaw,
    rhcWabitBalanceRaw,
    rhcAllowanceRaw,
    ethereumNativeRaw,
    rhcNativeRaw,
    ethereumGasPriceWei,
    rhcGasPriceWei,
  ] =
    await Promise.all([
      ethereumWeth
        .balanceOf(
          signers.address,
        ),

      ethereumWeth
        .allowance(
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

      currentGasPrice(
        signers.ethereum
          .provider!,
      ),

      currentGasPrice(
        signers.rhc
          .provider!,
      ),
    ]);

  const wethBalance =
    BigInt(
      wethBalanceRaw,
    );

  const ethereumAllowance =
    BigInt(
      ethereumAllowanceRaw,
    );

  const rhcWabitBalance =
    BigInt(
      rhcWabitBalanceRaw,
    );

  const rhcAllowance =
    BigInt(
      rhcAllowanceRaw,
    );

  if (
    rhcWabitBalance <
    expectedRhcWabitRaw
  ) {
    throw new Error(
      `RHC WABIT inventory is insufficient: have ${rhcWabitBalance.toString()}, need up to ${expectedRhcWabitRaw.toString()}.`,
    );
  }

  const wrapShortfallRaw =
    wethBalance >=
      candidate
        .requestedWethRaw
      ? 0n
      : candidate
          .requestedWethRaw -
        wethBalance;

  const ethereumApprovalNeeded =
    ethereumAllowance <
    candidate
      .requestedWethRaw;

  const rhcApprovalNeeded =
    rhcAllowance <
    expectedRhcWabitRaw;

  let wrapGasEstimate =
    0n;

  if (
    wrapShortfallRaw >
    0n
  ) {
    wrapGasEstimate =
      BigInt(
        await ethereumWeth
          .deposit
          .estimateGas({
            value:
              wrapShortfallRaw,
          }),
      );
  }

  let ethereumApprovalGasEstimate =
    0n;

  if (
    ethereumApprovalNeeded
  ) {
    ethereumApprovalGasEstimate =
      BigInt(
        await ethereumWeth
          .approve
          .estimateGas(
            ADDRESSES.ethereum
              .uniswapV2Router02,
            MaxUint256,
          ),
      );
  }

  let rhcApprovalGasEstimate =
    0n;

  if (
    rhcApprovalNeeded
  ) {
    rhcApprovalGasEstimate =
      BigInt(
        await rhcWabit
          .approve
          .estimateGas(
            ADDRESSES.rhc
              .tradeRouter,
            MaxUint256,
          ),
      );
  }

  const ethereumBootstrapGas =
    paddedGasLimit(
      wrapGasEstimate,
    ) +
    paddedGasLimit(
      ethereumApprovalGasEstimate,
    );

  const rhcBootstrapGas =
    paddedGasLimit(
      rhcApprovalGasEstimate,
    );

  const ethereumGasReserveWei =
    PREBOOTSTRAP_GAS_RESERVE_UNITS *
    ethereumGasPriceWei;

  const rhcGasReserveWei =
    PREBOOTSTRAP_GAS_RESERVE_UNITS *
    rhcGasPriceWei;

  const ethereumNativeRequired =
    wrapShortfallRaw +
    ethereumBootstrapGas *
      ethereumGasPriceWei +
    ethereumGasReserveWei;

  const rhcNativeRequired =
    rhcBootstrapGas *
      rhcGasPriceWei +
    rhcGasReserveWei;

  if (
    ethereumNativeRaw <
    ethereumNativeRequired
  ) {
    throw new Error(
      "Ethereum native balance cannot cover autowrap/bootstrap while preserving the hot-path gas reserve.",
    );
  }

  if (
    rhcNativeRaw <
    rhcNativeRequired
  ) {
    throw new Error(
      "RHC native balance cannot cover bootstrap while preserving the hot-path gas reserve.",
    );
  }

  const estimatedMaximumBootstrapFeeWei =
    ethereumBootstrapGas *
      ethereumGasPriceWei +
    rhcBootstrapGas *
      rhcGasPriceWei;

  return {
    wrapShortfallRaw,
    ethereumApprovalNeeded,
    rhcApprovalNeeded,
    wrapGasEstimate,
    ethereumApprovalGasEstimate,
    rhcApprovalGasEstimate,
    ethereumGasPriceWei,
    rhcGasPriceWei,
    estimatedMaximumBootstrapFeeWei,
  };
}

async function executeBootstrap(
  signers:
    Signers,
  plan:
    BootstrapPlan,
  control:
    HotExecutorControl,
): Promise<
  HotTransactionResult[]
> {
  const transactions:
    HotTransactionResult[] =
    [];

  const ethereumWeth =
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

  abortIfRequested(
    control,
    "before bootstrap",
  );

  if (
    plan.wrapShortfallRaw >
    0n
  ) {
    log(
      control,
      `Auto-wrapping ${plan.wrapShortfallRaw.toString()} wei ETH into WETH...`,
    );

    const tx =
      await ethereumWeth
        .deposit({
          value:
            plan.wrapShortfallRaw,

          gasLimit:
            paddedGasLimit(
              plan
                .wrapGasEstimate,
            ),

          gasPrice:
            plan
              .ethereumGasPriceWei,
        });

    log(
      control,
      `Ethereum wrap submitted: ${tx.hash}`,
    );

    transactions.push(
      await receiptResult(
        "Ethereum",
        "WRAP_ETH_TO_WETH",
        tx,
      ),
    );

    log(
      control,
      "Ethereum wrap mined.",
    );

    abortIfRequested(
      control,
      "after WETH wrap",
    );
  }

  if (
    plan
      .ethereumApprovalNeeded
  ) {
    log(
      control,
      "Approving WETH to canonical Uniswap V2 Router02...",
    );

    const tx =
      await ethereumWeth
        .approve(
          ADDRESSES.ethereum
            .uniswapV2Router02,
          MaxUint256,
          {
            gasLimit:
              paddedGasLimit(
                plan
                  .ethereumApprovalGasEstimate,
              ),

            gasPrice:
              plan
                .ethereumGasPriceWei,
          },
        );

    log(
      control,
      `Ethereum approval submitted: ${tx.hash}`,
    );

    transactions.push(
      await receiptResult(
        "Ethereum",
        "APPROVE_WETH_ROUTER02",
        tx,
      ),
    );

    log(
      control,
      "Ethereum WETH approval mined.",
    );

    abortIfRequested(
      control,
      "after Ethereum approval",
    );
  }

  if (
    plan.rhcApprovalNeeded
  ) {
    log(
      control,
      "Approving RHC WABIT to ReLaunchTradeRouter...",
    );

    const tx =
      await rhcWabit
        .approve(
          ADDRESSES.rhc
            .tradeRouter,
          MaxUint256,
          {
            gasLimit:
              paddedGasLimit(
                plan
                  .rhcApprovalGasEstimate,
              ),

            gasPrice:
              plan
                .rhcGasPriceWei,
          },
        );

    log(
      control,
      `RHC approval submitted: ${tx.hash}`,
    );

    transactions.push(
      await receiptResult(
        "RHC",
        "APPROVE_WABIT_TRADE_ROUTER",
        tx,
      ),
    );

    log(
      control,
      "RHC WABIT approval mined.",
    );

    abortIfRequested(
      control,
      "after RHC approval",
    );
  }

  return transactions;
}

async function estimatePreliminaryGas(
  signers:
    Signers,
  candidate:
    OpportunityCandidate,
  route:
    FreshRoute,
): Promise<PreliminaryGas> {
  const ethereumRouter =
    new Contract(
      ADDRESSES.ethereum
        .uniswapV2Router02,
      UNISWAP_V2_ROUTER02_ABI,
      signers.ethereum,
    );

  const rhcRouter =
    new Contract(
      ADDRESSES.rhc
        .tradeRouter,
      RHC_TRADE_ROUTER_ABI,
      signers.rhc,
    );

  const [
    ethereumDeadline,
    rhcDeadline,
  ] =
    await Promise.all([
      deadline(
        signers.ethereum
          .provider!,
      ),

      deadline(
        signers.rhc
          .provider!,
      ),
    ]);

  const ethereumArgs = [
    candidate
      .requestedWethRaw,
    1n,
    [
      ADDRESSES.ethereum.weth,
      ADDRESSES.ethereum.wabit,
    ],
    signers.address,
    ethereumDeadline,
  ] as const;

  const rhcArgs = [
    ADDRESSES.rhc.wabit,
    ADDRESSES.rhc.weth,
    route.expectedWabitRaw,
    1n,
    signers.address,
    rhcDeadline,
  ] as const;

  /*
   * Static calls prove the funded/approved signer can currently execute both
   * routes. No transaction is broadcast.
   */
  await Promise.all([
    ethereumRouter
      .swapExactTokensForTokensSupportingFeeOnTransferTokens
      .staticCall(
        ...ethereumArgs,
      ),

    rhcRouter
      .swapExactInput
      .staticCall(
        ...rhcArgs,
      ),
  ]);

  const [
    ethereumGasEstimateRaw,
    rhcGasEstimateRaw,
    ethereumGasPriceWei,
    rhcGasPriceWei,
  ] =
    await Promise.all([
      ethereumRouter
        .swapExactTokensForTokensSupportingFeeOnTransferTokens
        .estimateGas(
          ...ethereumArgs,
        ),

      rhcRouter
        .swapExactInput
        .estimateGas(
          ...rhcArgs,
        ),

      currentGasPrice(
        signers.ethereum
          .provider!,
      ),

      currentGasPrice(
        signers.rhc
          .provider!,
      ),
    ]);

  const ethereumGasEstimate =
    BigInt(
      ethereumGasEstimateRaw,
    );

  const rhcGasEstimate =
    BigInt(
      rhcGasEstimateRaw,
    );

  /*
   * Derive protection from padded live gas exposure, not historical gas
   * profiles. This intentionally biases the envelope conservative.
   */
  const conservativeGasCostWei =
    paddedGasLimit(
      ethereumGasEstimate,
    ) *
      ethereumGasPriceWei +
    paddedGasLimit(
      rhcGasEstimate,
    ) *
      rhcGasPriceWei;

  return {
    ethereumGasEstimate,
    rhcGasEstimate,
    ethereumGasPriceWei,
    rhcGasPriceWei,
    conservativeGasCostWei,
  };
}

async function finalProtectedPreflight(
  signers:
    Signers,
  candidate:
    OpportunityCandidate,
  protection:
    AutomaticProtectionEnvelope,
): Promise<{
  ethereumGasEstimate:
    bigint;

  rhcGasEstimate:
    bigint;

  ethereumGasPriceWei:
    bigint;

  rhcGasPriceWei:
    bigint;

  maximumGasCostWei:
    bigint;
}> {
  /*
   * Re-read Ethereum immediately before constructing the final calls.
   */
  const ethereum =
    await verifyEthereumBuy();

  const freshEthereumBuy =
    modelEthereumBuy(
      candidate
        .requestedWethRaw,
      ethereum,
    );

  if (
    freshEthereumBuy
      .netWabitOutRaw <
    protection
      .ethereumMinimumWabitRaw
  ) {
    throw new Error(
      "Ethereum output moved below the protected minimum during final preflight.",
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

  const [
    rhcDeadline,
    ethereumDeadline,
  ] =
    await Promise.all([
      deadline(
        signers.rhc
          .provider!,
      ),

      deadline(
        signers.ethereum
          .provider!,
      ),
    ]);

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

  const ethereumArgs = [
    candidate
      .requestedWethRaw,
    protection
      .ethereumMinimumWabitRaw,
    [
      ADDRESSES.ethereum.weth,
      ADDRESSES.ethereum.wabit,
    ],
    signers.address,
    ethereumDeadline,
  ] as const;

  const finalQuote =
    await tryQuoteRhcExactInput(
      ADDRESSES.rhc.wabit,
      ADDRESSES.rhc.weth,
      protection
        .rhcSellInputWabitRaw,
    );

  if (
    !finalQuote.ok ||
    finalQuote.quote.venue !==
      1n ||
    finalQuote.quote
      .amountInUsedRaw !==
      protection
        .rhcSellInputWabitRaw ||
    finalQuote.quote
      .refundAmountRaw !== 0n ||
    finalQuote.quote
      .amountOutRaw <
      protection
        .rhcMinimumWethRaw
  ) {
    throw new Error(
      "Final RHC venue/quote check no longer matches the proven active BondingCurve route.",
    );
  }

  const rhcPreview =
    await rhcRouter
      .swapExactInput
      .staticCall(
        ...rhcArgs,
      );

  if (
    BigInt(
      rhcPreview[0],
    ) !==
      protection
        .rhcSellInputWabitRaw ||
    BigInt(
      rhcPreview[2],
    ) !== 0n ||
    BigInt(
      rhcPreview[1],
    ) <
      protection
        .rhcMinimumWethRaw
  ) {
    throw new Error(
      "Final RHC static preflight no longer satisfies the protection envelope.",
    );
  }

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

      currentGasPrice(
        signers.rhc
          .provider!,
      ),

      currentGasPrice(
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

  const maximumGasCostWei =
    paddedGasLimit(
      rhcGasEstimate,
    ) *
      rhcGasPriceWei +
    paddedGasLimit(
      ethereumGasEstimate,
    ) *
      ethereumGasPriceWei;

  const maximumFeeProtectedNet =
    protection
      .rhcMinimumWethRaw -
    candidate
      .requestedWethRaw -
    maximumGasCostWei;

  if (
    maximumFeeProtectedNet <
    protection
      .protectedNetFloorWethRaw
  ) {
    throw new Error(
      `Final exact gas exposure weakens protected net below its floor: ${maximumFeeProtectedNet.toString()} < ${protection.protectedNetFloorWethRaw.toString()}.`,
    );
  }

  return {
    ethereumGasEstimate,
    rhcGasEstimate,
    ethereumGasPriceWei,
    rhcGasPriceWei,
    maximumGasCostWei,
  };
}

async function executeRhcSell(
  signers:
    Signers,
  protection:
    AutomaticProtectionEnvelope,
  preflight: {
    rhcGasEstimate:
      bigint;

    rhcGasPriceWei:
      bigint;
  },
  control:
    HotExecutorControl,
): Promise<{
  tx:
    HotTransactionResult;

  wethReceivedRaw:
    bigint;
}> {
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

  const before =
    BigInt(
      await weth.balanceOf(
        signers.address,
      ),
    );

  const txDeadline =
    await deadline(
      signers.rhc
        .provider!,
    );

  abortIfRequested(
    control,
    "immediately before first swap broadcast",
  );

  log(
    control,
    `Submitting protected RHC sell: ${protection.rhcSellInputWabitRaw.toString()} raw WABIT...`,
  );

  const tx =
    await router
      .swapExactInput(
        ADDRESSES.rhc.wabit,
        ADDRESSES.rhc.weth,
        protection
          .rhcSellInputWabitRaw,
        protection
          .rhcMinimumWethRaw,
        signers.address,
        txDeadline,
        {
          gasLimit:
            paddedGasLimit(
              preflight
                .rhcGasEstimate,
            ),

          gasPrice:
            preflight
              .rhcGasPriceWei,
        },
      );

  /*
   * From this point forward the operator-abort signal is intentionally ignored
   * until the Ethereum hedge is attempted.
   */
  log(
    control,
    `RHC sell BROADCAST: ${tx.hash}`,
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
    protection
      .rhcMinimumWethRaw
  ) {
    throw new Error(
      "RHC sell mined below protected recipient WETH minimum.",
    );
  }

  log(
    control,
    "RHC sell mined. Ethereum hedge is now mandatory.",
  );

  return {
    tx:
      result,

    wethReceivedRaw:
      received,
  };
}

async function executeEthereumHedge(
  signers:
    Signers,
  candidate:
    OpportunityCandidate,
  protection:
    AutomaticProtectionEnvelope,
  preflight: {
    ethereumGasEstimate:
      bigint;

    ethereumGasPriceWei:
      bigint;
  },
  control:
    HotExecutorControl,
): Promise<{
  tx:
    HotTransactionResult;

  wabitReceivedRaw:
    bigint;
}> {
  const router =
    new Contract(
      ADDRESSES.ethereum
        .uniswapV2Router02,
      UNISWAP_V2_ROUTER02_ABI,
      signers.ethereum,
    );

  const wabit =
    new Contract(
      ADDRESSES.ethereum.wabit,
      ERC20_ABI,
      signers.ethereum,
    );

  /*
   * Even after RHC mined, re-read the Ethereum reserve model before sending
   * the hedge. If it moved below the minimum, throw and open the circuit
   * breaker rather than sending an unprotected transaction.
   */
  const ethereum =
    await verifyEthereumBuy();

  const freshBuy =
    modelEthereumBuy(
      candidate
        .requestedWethRaw,
      ethereum,
    );

  if (
    freshBuy.netWabitOutRaw <
    protection
      .ethereumMinimumWabitRaw
  ) {
    throw new Error(
      "Ethereum market moved below the protected hedge minimum after the RHC leg mined.",
    );
  }

  const before =
    BigInt(
      await wabit.balanceOf(
        signers.address,
      ),
    );

  const txDeadline =
    await deadline(
      signers.ethereum
        .provider!,
    );

  log(
    control,
    "Submitting mandatory protected Ethereum hedge...",
  );

  const tx =
    await router
      .swapExactTokensForTokensSupportingFeeOnTransferTokens(
        candidate
          .requestedWethRaw,
        protection
          .ethereumMinimumWabitRaw,
        [
          ADDRESSES.ethereum.weth,
          ADDRESSES.ethereum.wabit,
        ],
        signers.address,
        txDeadline,
        {
          gasLimit:
            paddedGasLimit(
              preflight
                .ethereumGasEstimate,
            ),

          gasPrice:
            preflight
              .ethereumGasPriceWei,
        },
      );

  log(
    control,
    `Ethereum hedge BROADCAST: ${tx.hash}`,
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
    protection
      .ethereumMinimumWabitRaw
  ) {
    throw new Error(
      "Ethereum hedge mined below the protected WABIT minimum.",
    );
  }

  log(
    control,
    "Ethereum hedge mined.",
  );

  return {
    tx:
      result,

    wabitReceivedRaw:
      received,
  };
}

function totalFees(
  transactions:
    HotTransactionResult[],
): bigint {
  return transactions
    .reduce(
      (
        total,
        transaction,
      ) =>
        total +
        transaction
          .feePaidWei,
      0n,
    );
}

export async function executeHotOpportunity(
  candidate:
    OpportunityCandidate,
  control:
    HotExecutorControl,
): Promise<
  HotExecutionResult
> {
  if (
    !config.liveExecution
  ) {
    throw new Error(
      "Hot executor called while live execution is disabled.",
    );
  }

  if (
    candidate.direction !==
      "BUY_ETH_SELL_RHC" ||
    candidate
      .grossProfitWethRaw ==
      null ||
    candidate
      .grossProfitWethRaw <=
      0n
  ) {
    throw new Error(
      "Hot executor received an unsupported or non-profitable candidate.",
    );
  }

  const providers:
    Providers = {
      ethereum:
        ethereumProvider(),

      rhc:
        rhcProvider(),
  };

  const bootstrapTransactions:
    HotTransactionResult[] =
    [];

  let protection:
    AutomaticProtectionEnvelope
    | null = null;

  try {
    abortIfRequested(
      control,
      "before signer initialization",
    );

    log(
      control,
      "Initializing live signer and asserting both chain IDs...",
    );

    const signers =
      await createSigners(
        providers,
      );

    log(
      control,
      `Signer verified: ${signers.address}`,
    );

    abortIfRequested(
      control,
      "before fresh route verification",
    );

    log(
      control,
      "Fresh market verification...",
    );

    let route =
      await readFreshRoute(
        candidate,
      );

    log(
      control,
      `Route ARMED — ETH block ${route.ethereumBlock}, RHC block ${route.rhcBlock}.`,
    );

    abortIfRequested(
      control,
      "before wallet bootstrap planning",
    );

    log(
      control,
      "Checking wallet inventory, WETH shortfall, and allowances...",
    );

    const bootstrapPlan =
      await planBootstrap(
        signers,
        candidate,
        route
          .expectedWabitRaw,
      );

    if (
      bootstrapPlan
        .estimatedMaximumBootstrapFeeWei >=
      route
        .grossProfitWethRaw
    ) {
      throw new Error(
        "Estimated one-time bootstrap gas is greater than or equal to the current gross arbitrage edge.",
      );
    }

    if (
      bootstrapPlan
        .wrapShortfallRaw >
        0n ||
      bootstrapPlan
        .ethereumApprovalNeeded ||
      bootstrapPlan
        .rhcApprovalNeeded
    ) {
      log(
        control,
        "Wallet bootstrap required.",
      );

      bootstrapTransactions.push(
        ...await executeBootstrap(
          signers,
          bootstrapPlan,
          control,
        ),
      );

      /*
       * Bootstrap consumed blocks/time. Throw away the old market decision.
       */
      log(
        control,
        "Bootstrap complete. Revalidating market from scratch...",
      );

      route =
        await readFreshRoute(
          candidate,
        );
    } else {
      log(
        control,
        "Wallet already execution-ready.",
      );
    }

    abortIfRequested(
      control,
      "before live gas estimation",
    );

    log(
      control,
      "Estimating both live swap calls and reading fresh gas prices...",
    );

    const preliminaryGas =
      await estimatePreliminaryGas(
        signers,
        candidate,
        route,
      );

    const conservativeNet =
      route
        .grossProfitWethRaw -
      preliminaryGas
        .conservativeGasCostWei;

    if (
      conservativeNet <= 0n
    ) {
      throw new Error(
        "Exact live gas estimates erase the current arbitrage profit.",
      );
    }

    log(
      control,
      "Deriving automatic protected execution envelope...",
    );

    protection =
      await deriveAutomaticProtection(
        route.expectedWabitRaw,
        candidate
          .requestedWethRaw,
        preliminaryGas
          .conservativeGasCostWei,
        conservativeNet,
      );

    if (
      protection == null ||
      protection
        .maxSymmetricSlippageBps <=
        0
    ) {
      throw new Error(
        "No positive protected execution envelope survives current live gas economics.",
      );
    }

    log(
      control,
      `Protection derived: ${protection.maxSymmetricSlippageBps} bps per leg.`,
    );

    abortIfRequested(
      control,
      "before final protected preflight",
    );

    log(
      control,
      "Final protected static-call + estimateGas preflight...",
    );

    const finalPreflight =
      await finalProtectedPreflight(
        signers,
        candidate,
        protection,
      );

    abortIfRequested(
      control,
      "before first swap broadcast",
    );

    log(
      control,
      "All hot-path gates PASS. First swap is about to broadcast.",
    );

    const rhcSell =
      await executeRhcSell(
        signers,
        protection,
        {
          rhcGasEstimate:
            finalPreflight
              .rhcGasEstimate,

          rhcGasPriceWei:
            finalPreflight
              .rhcGasPriceWei,
        },
        control,
      );

    try {
      const ethereumBuy =
        await executeEthereumHedge(
          signers,
          candidate,
          protection,
          {
            ethereumGasEstimate:
              finalPreflight
                .ethereumGasEstimate,

            ethereumGasPriceWei:
              finalPreflight
                .ethereumGasPriceWei,
          },
          control,
        );

      const realizedGasWei =
        totalFees(
          bootstrapTransactions,
        ) +
        rhcSell.tx
          .feePaidWei +
        ethereumBuy.tx
          .feePaidWei;

      const realizedNetWethRaw =
        rhcSell
          .wethReceivedRaw -
        candidate
          .requestedWethRaw -
        realizedGasWei;

      log(
        control,
        "LIVE ARBITRAGE COMPLETE.",
      );

      return {
        status:
          "EXECUTED",

        wallet:
          signers.address,

        reason:
          control.shouldAbort()
            ? "Both legs completed successfully; operator requested stop during the committed hedge sequence."
            : "Both protected live legs mined successfully.",

        bootstrapTransactions,

        rhcSell:
          rhcSell.tx,

        ethereumBuy:
          ethereumBuy.tx,

        protection,

        inputWethRaw:
          candidate
            .requestedWethRaw,

        soldWabitRaw:
          protection
            .rhcSellInputWabitRaw,

        rhcWethReceivedRaw:
          rhcSell
            .wethReceivedRaw,

        ethereumWabitReceivedRaw:
          ethereumBuy
            .wabitReceivedRaw,

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

      log(
        control,
        `CRITICAL: RHC sell succeeded but Ethereum hedge failed: ${message}`,
      );

      return {
        status:
          "CRITICAL_HEDGE_FAILED",

        wallet:
          signers.address,

        reason:
          `RHC sell succeeded but Ethereum hedge failed: ${message}`,

        bootstrapTransactions,

        rhcSell:
          rhcSell.tx,

        ethereumBuy:
          null,

        protection,

        inputWethRaw:
          candidate
            .requestedWethRaw,

        soldWabitRaw:
          protection
            .rhcSellInputWabitRaw,

        rhcWethReceivedRaw:
          rhcSell
            .wethReceivedRaw,

        ethereumWabitReceivedRaw:
          0n,

        realizedGasWei:
          totalFees(
            bootstrapTransactions,
          ) +
          rhcSell.tx
            .feePaidWei,

        realizedNetWethRaw:
          null,

        openedCircuitBreaker:
          true,
      };
    }
  } catch (error: unknown) {
    if (
      isOperatorAbort(
        error,
      )
    ) {
      const message =
        error instanceof Error
          ? error.message
          : "OPERATOR_ABORT";

      log(
        control,
        "Operator abort accepted before first swap broadcast.",
      );

      return {
        status:
          "ABORTED",

        wallet:
          config.executorAddress ??
          "unknown",

        reason:
          message.replace(
            "OPERATOR_ABORT:",
            "Operator requested stop ",
          ),

        bootstrapTransactions,

        rhcSell:
          null,

        ethereumBuy:
          null,

        protection,

        inputWethRaw:
          candidate
            .requestedWethRaw,

        soldWabitRaw:
          0n,

        rhcWethReceivedRaw:
          0n,

        ethereumWabitReceivedRaw:
          0n,

        realizedGasWei:
          totalFees(
            bootstrapTransactions,
          ),

        realizedNetWethRaw:
          null,

        openedCircuitBreaker:
          false,
      };
    }

    throw error;
  } finally {
    providers.ethereum
      .destroy();

    providers.rhc
      .destroy();
  }
}
