import { getAddress } from "ethers";

export const ADDRESSES = Object.freeze({
  ethereum: Object.freeze({
    chainId: 1,
    wabit: getAddress(
      "0x5857cf3fd35d1fb4ec56151b5dcff289e7be8000",
    ),
    weth: getAddress(
      "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    ),
    wabitWethPair: getAddress(
      "0xB5C6ee9949aB5323B266a8507DC2D80285e55774",
    ),
    uniswapV2Factory: getAddress(
      "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f",
    ),
    uniswapV2Router02: getAddress(
      "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
    ),
  }),

  rhc: Object.freeze({
    chainId: 4663,
    relaunchFactory: getAddress(
      "0x0E54a12dB2d6B8f309269ef98F8b9c2764aa3A92",
    ),
    wabitInventorySource: getAddress(
      "0x981FB95d4101D1F6238456b680cCa1fa818e86a4",
    ),
    wabit: getAddress(
      "0xcE39cA04C9c924c949172FDeeFF588Ab586a7Db1",
    ),
    weth: getAddress(
      "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
    ),
    curve: getAddress(
      "0x66c44133aE27929B4d8e5c4392D516b5558f4F3E",
    ),
    tradeRouter: getAddress(
      "0x48AcF9c62384A6C15cCA80F6307cc29a5be2580B",
    ),
  }),
});

export const SAME_NOTIONAL_WETH =
  10_000_000_000_000_000n; // 0.01 WETH

export const V2_FEE_NUMERATOR = 997n;
export const V2_FEE_DENOMINATOR = 1000n;

export const WABIT_TRANSFER_BURN_BPS = 1n;
export const BPS_DENOMINATOR = 10_000n;

export const ERC20_ABI = [
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner,address spender) view returns (uint256)",
  "function approve(address spender,uint256 amount) returns (bool)",
  "function transfer(address to,uint256 amount) returns (bool)",
] as const;

export const WETH_ABI = [
  ...ERC20_ABI,
  "function deposit() payable",
  "function withdraw(uint256 amount)",
] as const;

export const UNISWAP_V2_ROUTER02_ABI = [
  "function swapExactTokensForTokensSupportingFeeOnTransferTokens(uint256 amountIn,uint256 amountOutMin,address[] path,address to,uint256 deadline)",
] as const;

export const UNISWAP_V2_PAIR_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112 reserve0,uint112 reserve1,uint32 blockTimestampLast)",
  "function factory() view returns (address)",
] as const;

export const RHC_TRADE_ROUTER_ABI = [
  "function quoteExactInput(address tokenIn,address tokenOut,uint256 amountIn) view returns (uint8 venue,uint256 amountInUsed,uint256 amountOut,uint256 refundAmount)",
  "function swapExactInput(address tokenIn,address tokenOut,uint256 amountIn,uint256 amountOutMin,address recipient,uint256 deadline) returns (uint256 amountInUsed,uint256 amountOut,uint256 refundAmount)",
] as const;

export const RHC_CURVE_ABI = [
  "function tokensSold() view returns (uint256)",
  "function quoteReserve() view returns (uint256)",
  "function activated() view returns (bool)",
  "function graduated() view returns (bool)",
  "function quoteSell(uint256 tokenAmount) view returns (uint256 quoteAmount)",
] as const;

export function venueName(
  venue: bigint,
): string {
  if (venue === 0n) return "Unavailable";
  if (venue === 1n) return "BondingCurve";
  if (venue === 2n) return "AMM";
  return `Unknown(${venue.toString()})`;
}
