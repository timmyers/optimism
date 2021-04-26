/**
 * Copyright 2020, Optimism PBC
 * MIT License
 * https://github.com/ethereum-optimism
 */

import { sleep } from './shared/utils'
import {
  deployLoadTestContracts,
  spamL1Deposits,
  spamL2Txs,
  verifyL1Deposits,
  verifyL2Deposits,
  verifyL2Txs,
} from './shared/helpers'
import { JsonRpcProvider } from '@ethersproject/providers'
import { Wallet } from '@ethersproject/wallet'
import { Contract } from '@ethersproject/contracts'
import { Logger } from '@eth-optimism/core-utils'
import { OptimismEnv } from './shared/env'

import { getContractInterface } from '@eth-optimism/contracts'

describe('Deposit Load Test', async () => {
  const env = await OptimismEnv.new()
  const L2_DEPOSIT_TRACKER_ADDRESS = env.L2DepositTrackerAddress()
  const L1_DEPOSIT_INITIATOR_ADDRESS = env.L1DepositIntiatorAddress()
  const L2_TX_STORAGE_ADDRESS = env.L2TxStorageAddress()
  const l1Provider = new JsonRpcProvider(env.L1NodeUrlWithPort())
  const l1Wallet = new Wallet(env.DeployerPrivateKey(), l1Provider)
  const l2Provider = env.l2Provider
  const l2Wallet = env.l2Wallet
  
  const addressManagerAddress = env.AddressResolverAddress()
  const addressManagerInterface = getContractInterface('Lib_AddressManager')
  const AddressManager = new Contract(
    addressManagerAddress,
    addressManagerInterface,
    l1Provider
  )
  

  const logger = new Logger({ name: 'load-test' })
  const numDepositsToSend = 10
  const numTxsToSend = 15
  let l2DepositTracker: Contract
  let l1DepositInitiator: Contract
  let ctcAddress: string
  let l2TxStorage: Contract

  before(async () => {
    ;({
      l2DepositTracker,
      l1DepositInitiator,
      l2TxStorage,
    } = await deployLoadTestContracts(
      l1Wallet,
      l2Wallet,
      logger,
      L2_DEPOSIT_TRACKER_ADDRESS,
      L1_DEPOSIT_INITIATOR_ADDRESS,
      L2_TX_STORAGE_ADDRESS
    ))
    ctcAddress = await AddressManager.getAddress(
      'OVM_CanonicalTransactionChain'
    )
    logger.info(`L1 CTC address: ${ctcAddress}`)
  })

  it('should perform deposits and L2 transactions', async () => {
    const tasks = [
      spamL1Deposits(
        l1DepositInitiator,
        ctcAddress,
        l2DepositTracker.address,
        numDepositsToSend,
        l1Wallet,
        logger
      ),
      spamL2Txs(l2TxStorage, numTxsToSend, l2Wallet, logger),
    ]
    await Promise.all(tasks)
    logger.info('done sending txs, sleeping for 2 minutes...')
    await sleep(1000 * 60 * 2)
  }).timeout(0)

  it('should perform deposits and L2 transactions', async () => {
    const actualIndexes = await verifyL1Deposits(
      l1DepositInitiator,
      l1Wallet.address,
      logger
    )
    await verifyL2Deposits(
      l1DepositInitiator,
      l2DepositTracker,
      l1Wallet.address,
      actualIndexes,
      logger
    )
    await verifyL2Txs(l2TxStorage, logger)
  }).timeout(0)
})
