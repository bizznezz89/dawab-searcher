// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

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

    function allowance(
        address owner,
        address spender
    )
        external
        view
        returns (uint256);

    function approve(
        address spender,
        uint256 amount
    )
        external
        returns (bool);
}

contract RhcBootstrapSimulation {
    address internal constant WABIT =
        0xcE39cA04C9c924c949172FDeeFF588Ab586a7Db1;

    address internal constant TRADE_ROUTER =
        0x48AcF9c62384A6C15cCA80F6307cc29a5be2580B;

    address internal constant WALLET =
        0x981FB95d4101D1F6238456b680cCa1fa818e86a4;

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

    event log_named_uint(
        string key,
        uint256 val
    );

    function testSimulateApproval()
        public
    {
        uint256 required =
            vm.envUint(
                "DAWAB_RHC_REQUIRED_WABIT"
            );

        require(
            WABIT_TOKEN.balanceOf(
                WALLET
            ) >= required,
            "RHC WABIT inventory insufficient"
        );

        uint256 beforeAllowance =
            WABIT_TOKEN.allowance(
                WALLET,
                TRADE_ROUTER
            );

        if (
            beforeAllowance <
            required
        ) {
            vm.prank(WALLET);

            uint256 gasBefore =
                gasleft();

            bool ok =
                WABIT_TOKEN.approve(
                    TRADE_ROUTER,
                    type(uint256).max
                );

            uint256 callGasUsed =
                gasBefore -
                gasleft();

            require(
                ok,
                "RHC WABIT approval failed"
            );

            emit log_named_uint(
                "DAWAB_RHC_APPROVE_CALL_GAS",
                callGasUsed
            );
        } else {
            emit log_named_uint(
                "DAWAB_RHC_APPROVE_CALL_GAS",
                0
            );
        }

        uint256 afterAllowance =
            WABIT_TOKEN.allowance(
                WALLET,
                TRADE_ROUTER
            );

        require(
            afterAllowance >=
                required,
            "post-approval allowance insufficient"
        );

        emit log_named_uint(
            "DAWAB_RHC_POST_ALLOWANCE",
            afterAllowance
        );
    }
}
