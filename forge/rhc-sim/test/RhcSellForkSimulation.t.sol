// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

/*
 * Self-contained Forge fork harness for the RHC leg.
 *
 * No forge-std dependency is required. The Node searcher supplies
 * DAWAB_RHC_WABIT_IN and launches this test with --fork-url.
 *
 * Nothing is broadcast to RHC.
 */

interface Vm {
    function envUint(
        string calldata name
    )
        external
        returns (uint256);

    function prank(
        address msgSender
    )
        external;
}

interface IERC20Like {
    function balanceOf(
        address account
    )
        external
        view
        returns (uint256);

    function transfer(
        address to,
        uint256 amount
    )
        external
        returns (bool);

    function approve(
        address spender,
        uint256 amount
    )
        external
        returns (bool);
}

interface IReLaunchTradeRouterLike {
    function quoteExactInput(
        address tokenIn,
        address tokenOut,
        uint256 amountIn
    )
        external
        view
        returns (
            uint8 venue,
            uint256 amountInUsed,
            uint256 amountOut,
            uint256 refundAmount
        );

    function swapExactInput(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOutMin,
        address recipient,
        uint256 deadline
    )
        external
        returns (
            uint256 amountInUsed,
            uint256 amountOut,
            uint256 refundAmount
        );
}

contract RhcSellForkSimulation {
    address internal constant WABIT =
        0xcE39cA04C9c924c949172FDeeFF588Ab586a7Db1;

    address internal constant WETH =
        0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;

    address internal constant TRADE_ROUTER =
        0x48AcF9c62384A6C15cCA80F6307cc29a5be2580B;

    address internal constant INVENTORY_SOURCE =
        0x981FB95d4101D1F6238456b680cCa1fa818e86a4;

    address internal constant TRADER =
        address(0xB0B);

    Vm internal constant vm =
        Vm(
            address(
                uint160(
                    uint256(
                        keccak256(
                            "hevm cheat code"
                        )
                    )
                )
            )
        );

    IERC20Like internal constant WABIT_TOKEN =
        IERC20Like(WABIT);

    IERC20Like internal constant WETH_TOKEN =
        IERC20Like(WETH);

    IReLaunchTradeRouterLike internal constant ROUTER =
        IReLaunchTradeRouterLike(
            TRADE_ROUTER
        );

    /*
     * Foundry recognizes the classic DSTest log event signatures and prints
     * them in the Logs section. Node parses only the DAWAB_* keys below.
     */
    event log_named_uint(
        string key,
        uint256 val
    );

    uint256 internal wabitIn;
    uint256 internal quotedWethOut;
    uint256 internal traderWethBefore;

    function setUp()
        public
    {
        wabitIn =
            vm.envUint(
                "DAWAB_RHC_WABIT_IN"
            );

        require(
            wabitIn > 0,
            "WABIT input is zero"
        );

        uint256 sourceBalance =
            WABIT_TOKEN.balanceOf(
                INVENTORY_SOURCE
            );

        require(
            sourceBalance >=
                wabitIn,
            "inventory source too small"
        );

        uint256 traderWabitBefore =
            WABIT_TOKEN.balanceOf(
                TRADER
            );

        vm.prank(
            INVENTORY_SOURCE
        );

        require(
            WABIT_TOKEN.transfer(
                TRADER,
                wabitIn
            ),
            "fork WABIT seed failed"
        );

        uint256 receivedWabit =
            WABIT_TOKEN.balanceOf(
                TRADER
            ) -
            traderWabitBefore;

        require(
            receivedWabit ==
                wabitIn,
            "RHC WABIT seed changed amount"
        );

        vm.prank(TRADER);

        require(
            WABIT_TOKEN.approve(
                TRADE_ROUTER,
                type(uint256).max
            ),
            "router approval failed"
        );

        (
            uint8 venue,
            uint256 amountInUsed,
            uint256 amountOut,
            uint256 refundAmount
        ) = ROUTER.quoteExactInput(
            WABIT,
            WETH,
            wabitIn
        );

        require(
            venue == 1,
            "venue is not BondingCurve"
        );

        require(
            amountInUsed ==
                wabitIn,
            "quote is not full-fill"
        );

        require(
            refundAmount == 0,
            "unexpected quote refund"
        );

        quotedWethOut =
            amountOut;

        traderWethBefore =
            WETH_TOKEN.balanceOf(
                TRADER
            );
    }

    function testSimulateRhcSell()
        public
    {
        /*
         * setUp() is complete before this test invocation. The actual route
         * call therefore begins in a fresh test-call access context rather
         * than inheriting the quote/seeding warm accesses.
         *
         * amountOutMin = 0 is fork-only. Live execution must never do this.
         */
        vm.prank(TRADER);

        uint256 gasBefore =
            gasleft();

        (
            uint256 amountInUsed,
            uint256 amountOut,
            uint256 refundAmount
        ) = ROUTER.swapExactInput(
            WABIT,
            WETH,
            wabitIn,
            0,
            TRADER,
            block.timestamp +
                1 hours
        );

        uint256 routerCallGasUsed =
            gasBefore -
            gasleft();

        require(
            amountInUsed ==
                wabitIn,
            "execution input mismatch"
        );

        require(
            refundAmount == 0,
            "unexpected execution refund"
        );

        require(
            amountOut ==
                quotedWethOut,
            "execution differs from fork quote"
        );

        uint256 actualWethOut =
            WETH_TOKEN.balanceOf(
                TRADER
            ) -
            traderWethBefore;

        require(
            actualWethOut ==
                amountOut,
            "recipient WETH delta mismatch"
        );

        emit log_named_uint(
            "DAWAB_RHC_ROUTER_CALL_GAS",
            routerCallGasUsed
        );

        emit log_named_uint(
            "DAWAB_RHC_QUOTED_WETH_OUT",
            quotedWethOut
        );

        emit log_named_uint(
            "DAWAB_RHC_ACTUAL_WETH_OUT",
            actualWethOut
        );
    }
}
