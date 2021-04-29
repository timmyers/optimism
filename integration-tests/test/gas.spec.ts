import { ethers } from 'hardhat'
import { injectL2Context } from '@eth-optimism/core-utils'
import { expect } from 'chai'
import {
  sleep,
  l2Provider,
  l1Provider,
  getAddressManager,
} from './shared/utils'
import { OptimismEnv } from './shared/env'
import { getContractFactory } from '@eth-optimism/contracts'
import { Contract, ContractFactory, Wallet, BigNumber } from 'ethers'

describe.only('Gas', () => {
  let GasUsage: Contract

  const L1Provider = l1Provider
  const L2Provider = injectL2Context(l2Provider)

  before(async () => {
    const env = await OptimismEnv.new()
    // Create providers and signers
    const l1Wallet = env.l1Wallet
    const l2Wallet = env.l2Wallet
    const addressManager = env.addressManager

    // deploy the contract
    const GasUsageFactory = await ethers.getContractFactory(
      'GasUsage',
      l2Wallet
    )

    GasUsage = await GasUsageFactory.deploy()
    await GasUsage.deployTransaction.wait()
  })

  it('Should return the gasused', async () => {
      console.log(GasUsage)
    const gasUsed = await GasUsage.callStatic.gasLeft()
    console.log(gasUsed)
  })
})
