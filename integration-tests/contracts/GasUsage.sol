// SPDX-License-Identifier: MIT

pragma solidity >=0.7.0;

contract GasUsage {
    function gasLeft() public view returns (uint256) {
        return gasleft();
    }

    function burnGas(uint256 gasToConsume) public view returns (uint256) {
        uint256 i;
        uint256 startingGas = gasleft();
        while(startingGas - gasleft() < gasToConsume) {
            i++;
        }
        return gasleft();
    }
}
