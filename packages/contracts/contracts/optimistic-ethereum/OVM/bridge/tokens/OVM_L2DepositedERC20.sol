// SPDX-License-Identifier: MIT
pragma solidity >0.5.0 <0.8.0;
pragma experimental ABIEncoderV2;

/* Interface Imports */
import { iOVM_L1TokenGateway } from "../../../iOVM/bridge/tokens/iOVM_L1TokenGateway.sol";
import { iOVM_L2DepositedToken } from "../../../iOVM/bridge/tokens/iOVM_L2DepositedToken.sol";

/* Contract Imports */
import { UniswapV2ERC20 } from "../../../libraries/standards/UniswapV2ERC20.sol";

/* Library Imports */
import { OVM_CrossDomainEnabled } from "../../../libraries/bridge/OVM_CrossDomainEnabled.sol";

/**
 * @title OVM_L2DepositedERC20
 * @dev The L2 Deposited ERC20 is an ERC20 implementation which represents L1 assets deposited into L2.
 * This contract mints new tokens when it hears about deposits into the L1 ERC20 gateway.
 * This contract also burns the tokens intended for withdrawal, informing the L1 gateway to release L1 funds.
 *
 * Compiler used: optimistic-solc
 * Runtime target: OVM
 */
contract OVM_L2DepositedERC20 is iOVM_L2DepositedToken, OVM_CrossDomainEnabled, UniswapV2ERC20 {
    /*******************
     * Contract Events *
     *******************/

    event Initialized(iOVM_L1TokenGateway _l1TokenGateway);

    /********************************
     * External Contract References *
     ********************************/

    iOVM_L1TokenGateway public l1TokenGateway;

    /********************************
     * Constructor & Initialization *
     ********************************/

    /**
     * @param _l2CrossDomainMessenger Cross-domain messenger used by this contract.
     * @param _name ERC20 name
     * @param _symbol ERC20 symbol
     */
    constructor(
        address _l2CrossDomainMessenger,
        string memory _name,
        string memory _symbol
    )
        OVM_CrossDomainEnabled(_l2CrossDomainMessenger)
        UniswapV2ERC20(_name, _symbol)
    {}

    /**
     * @dev Initialize this contract with the L1 token gateway address.
     * The flow: 1) this contract gets deployed on L2, 2) the L1
     * gateway is deployed with addr from (1), 3) L1 gateway address passed here.
     * @param _l1TokenGateway Address of the corresponding L1 gateway deployed to the main chain
     */
    function init(iOVM_L1TokenGateway _l1TokenGateway) public
    {
        require(address(l1TokenGateway) == address(0), "Contract has already been initialized");

        l1TokenGateway = _l1TokenGateway;

        emit Initialized(l1TokenGateway);
    }

    /**********************
     * Function Modifiers *
     **********************/

    modifier onlyInitialized() {
        require(address(l1TokenGateway) != address(0), "Contract has not yet been initialized");
        _;
    }

    /********************************
     * Overridable Accounting logic *
     ********************************/

    // Default gas value which can be overridden if more complex logic runs on L1.
    uint32 internal constant DEFAULT_FINALIZE_WITHDRAWAL_L1_GAS = 100000;

    /**
     * @dev Overridable getter for the *L1* gas limit of settling the withdrawal, in the case it may be
     * dynamic, and the above public constant does not suffice.
     */
    function getFinalizeWithdrawalL1Gas() public view virtual returns(uint32)
    {
        return DEFAULT_FINALIZE_WITHDRAWAL_L1_GAS;
    }

    /***************
     * Withdrawing *
     ***************/

    /**
     * @dev initiate a withdraw of some tokens to the caller's account on L1
     * @param _amount Amount of the token to withdraw
     */
    function withdraw(uint _amount) external override virtual
    onlyInitialized()
    {
        _initiateWithdrawal(msg.sender, _amount);
    }

    /**
     * @dev initiate a withdraw of some token to a recipient's account on L1
     * @param _to L1 adress to credit the withdrawal to
     * @param _amount Amount of the token to withdraw
     */
    function withdrawTo(address _to, uint _amount) external override virtual
    onlyInitialized()
    {
        _initiateWithdrawal(_to, _amount);
    }

    /**
     * @dev Performs the logic for deposits by storing the token and informing the L2 token Gateway of the deposit.
     * @param _to Account to give the withdrawal to on L1
     * @param _amount Amount of the token to withdraw
     */
    function _initiateWithdrawal(address _to, uint _amount) internal
    {
        // When a withdrawal is initiated, we burn the withdrawer's funds to prevent subsequent L2 usage
        _burn(msg.sender, _amount);

        // Construct calldata for l1TokenGateway.finalizeWithdrawal(_to, _amount)
        bytes memory data = abi.encodeWithSelector(
            iOVM_L1TokenGateway.finalizeWithdrawal.selector,
            _to,
            _amount
        );

        // Send message up to L1 gateway
        sendCrossDomainMessage(
            address(l1TokenGateway),
            data,
            getFinalizeWithdrawalL1Gas()
        );

        emit WithdrawalInitiated(msg.sender, _to, _amount);
    }

    /************************************
     * Cross-chain Function: Depositing *
     ************************************/

    /**
     * @dev Complete a deposit from L1 to L2, and credits funds to the recipient's balance of this
     * L2 token.
     * This call will fail if it did not originate from a corresponding deposit in OVM_l1TokenGateway.
     *
     * @param _to Address to receive the withdrawal at
     * @param _amount Amount of the token to withdraw
     */
    function finalizeDeposit(address _to, uint _amount) external override virtual
    onlyInitialized()
    onlyFromCrossDomainAccount(address(l1TokenGateway))
    {
        // When a deposit is finalized, we credit the account on L2 with the same amount of tokens
        _mint(_to, _amount);

        emit DepositFinalized(_to, _amount);
    }
}
