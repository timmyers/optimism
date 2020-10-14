import { expect } from '../../../setup'

/* External Imports */
import { ethers } from '@nomiclabs/buidler'
import { Signer, ContractFactory, Contract, BigNumber } from 'ethers'
import { smockit, MockContract } from '@eth-optimism/smock'
import _ from 'lodash'

/* Internal Imports */
import {
  makeAddressManager,
  setProxyTarget,
  FORCE_INCLUSION_PERIOD_SECONDS,
  setEthTime,
  NON_ZERO_ADDRESS,
  remove0x,
  getEthTime,
  getNextBlockNumber,
  increaseEthTime,
  // NON_NULL_BYTES32,
  // ZERO_ADDRESS,
} from '../../../helpers'
import { defaultAbiCoder, keccak256 } from 'ethers/lib/utils'

interface sequencerBatchContext {
  numSequencedTransactions: Number
  numSubsequentQueueTransactions: Number
  timestamp: Number
  blockNumber: Number
}

const ELEMENT_TEST_SIZES = [1, 2, 4, 8, 16]

const getQueueElementHash = (queueIndex: number): string => {
  return getChainElementHash(false, queueIndex, 0, 0, '0x')
}

const getSequencerElementHash = (
  timestamp: number,
  blockNumber: number,
  txData: string
): string => {
  return getChainElementHash(true, 0, timestamp, blockNumber, txData)
}

const getChainElementHash = (
  isSequenced: boolean,
  queueIndex: number,
  timestamp: number,
  blockNumber: number,
  txData: string
): string => {
  return keccak256(
    defaultAbiCoder.encode(
      ['bool', 'uint256', 'uint256', 'uint256', 'bytes'],
      [isSequenced, queueIndex, timestamp, blockNumber, txData]
    )
  )
}

const getTransactionHash = (
  sender: string,
  target: string,
  gasLimit: number,
  data: string
): string => {
  return keccak256(encodeQueueTransaction(sender, target, gasLimit, data))
}

const encodeQueueTransaction = (
  sender: string,
  target: string,
  gasLimit: number,
  data: string
): string => {
  return defaultAbiCoder.encode(
    ['address', 'address', 'uint256', 'bytes'],
    [sender, target, gasLimit, data]
  )
}

const encodeTimestampAndBlockNumber = (
  timestamp: number,
  blockNumber: number
): string => {
  return (
    '0x' +
    remove0x(BigNumber.from(blockNumber).toHexString()).padStart(54, '0') +
    remove0x(BigNumber.from(timestamp).toHexString()).padStart(10, '0')
  )
}

describe('OVM_CanonicalTransactionChain', () => {
  let signer: Signer
  let sequencer: Signer
  before(async () => {
    ;[signer, sequencer] = await ethers.getSigners()
  })

  let AddressManager: Contract
  before(async () => {
    AddressManager = await makeAddressManager()
    await AddressManager.setAddress(
      'OVM_Sequencer',
      await sequencer.getAddress()
    )
  })

  let Mock__OVM_L1ToL2TransactionQueue: MockContract
  before(async () => {
    Mock__OVM_L1ToL2TransactionQueue = smockit(
      await ethers.getContractFactory('OVM_L1ToL2TransactionQueue')
    )

    await setProxyTarget(
      AddressManager,
      'OVM_L1ToL2TransactionQueue',
      Mock__OVM_L1ToL2TransactionQueue
    )
  })

  let Factory__OVM_CanonicalTransactionChain: ContractFactory
  before(async () => {
    Factory__OVM_CanonicalTransactionChain = await ethers.getContractFactory(
      'OVM_CanonicalTransactionChain'
    )
  })

  let OVM_CanonicalTransactionChain: Contract
  beforeEach(async () => {
    OVM_CanonicalTransactionChain = await Factory__OVM_CanonicalTransactionChain.deploy(
      AddressManager.address,
      FORCE_INCLUSION_PERIOD_SECONDS
    )
  })

  describe('enqueue', () => {
    const target = NON_ZERO_ADDRESS
    const gasLimit = 500_000
    const data = '0x' + '12'.repeat(1234)

    it('should revert when trying to input more data than the max data size', async () => {
      const MAX_ROLLUP_TX_SIZE = await OVM_CanonicalTransactionChain.MAX_ROLLUP_TX_SIZE()
      const data = '0x' + '12'.repeat(MAX_ROLLUP_TX_SIZE + 1)

      await expect(
        OVM_CanonicalTransactionChain.enqueue(target, gasLimit, data)
      ).to.be.revertedWith('Transaction exceeds maximum rollup data size.')
    })

    it('should revert if gas limit parameter is not at least MIN_ROLLUP_TX_GAS', async () => {
      const MIN_ROLLUP_TX_GAS = await OVM_CanonicalTransactionChain.MIN_ROLLUP_TX_GAS()
      const gasLimit = MIN_ROLLUP_TX_GAS / 2

      await expect(
        OVM_CanonicalTransactionChain.enqueue(target, gasLimit, data)
      ).to.be.revertedWith('Layer 2 gas limit too low to enqueue.')
    })

    it('should revert if transaction gas limit does not cover rollup burn', async () => {
      const L2_GAS_DISCOUNT_DIVISOR = await OVM_CanonicalTransactionChain.L2_GAS_DISCOUNT_DIVISOR()

      await expect(
        OVM_CanonicalTransactionChain.enqueue(target, gasLimit, data, {
          gasLimit: gasLimit / L2_GAS_DISCOUNT_DIVISOR - 1,
        })
      ).to.be.revertedWith('Insufficient gas for L2 rate limiting burn.')
    })

    describe('with valid input parameters', () => {
      it('should emit a TransactionEnqueued event', async () => {
        const timestamp = (await getEthTime(ethers.provider)) + 100
        await setEthTime(ethers.provider, timestamp)

        await expect(
          OVM_CanonicalTransactionChain.enqueue(target, gasLimit, data)
        )
          .to.emit(OVM_CanonicalTransactionChain, 'TransactionEnqueued')
      })

      describe('when enqueing multiple times', () => {
        for (const size of ELEMENT_TEST_SIZES) {
          it(`should be able to enqueue ${size} elements`, async () => {
            for (let i = 0; i < size; i++) {
              await expect(
                OVM_CanonicalTransactionChain.enqueue(target, gasLimit, data)
              ).to.not.be.reverted
            }
          })
        }
      })
    })
  })

  describe('getQueueElement', () => {
    it('should revert when accessing a non-existent element', async () => {
      await expect(
        OVM_CanonicalTransactionChain.getQueueElement(0)
      ).to.be.revertedWith('Index too large')
    })

    describe('when the requested element exists', () => {
      const target = NON_ZERO_ADDRESS
      const gasLimit = 500_000
      const data = '0x' + '12'.repeat(1234)

      describe('when getting the first element', () => {
        for (const size of ELEMENT_TEST_SIZES) {
          it(`gets the element when ${size} + 1 elements exist`, async () => {
            const timestamp = (await getEthTime(ethers.provider)) + 100
            const blockNumber = await getNextBlockNumber(ethers.provider)
            await setEthTime(ethers.provider, timestamp)

            const queueRoot = getTransactionHash(
              await signer.getAddress(),
              target,
              gasLimit,
              data
            )

            await OVM_CanonicalTransactionChain.enqueue(target, gasLimit, data)

            for (let i = 0; i < size; i++) {
              await OVM_CanonicalTransactionChain.enqueue(
                target,
                gasLimit,
                '0x' + '12'.repeat(i + 1)
              )
            }

            expect(
              _.toPlainObject(
                await OVM_CanonicalTransactionChain.getQueueElement(0)
              )
            ).to.deep.include({
              queueRoot,
              timestamp,
              blockNumber,
            })
          })
        }
      })

      describe('when getting the middle element', () => {
        for (const size of ELEMENT_TEST_SIZES) {
          it(`gets the element when ${size} elements exist`, async () => {
            let timestamp: number
            let blockNumber: number
            let queueRoot: string

            const middleIndex = Math.floor(size / 2)
            for (let i = 0; i < size; i++) {
              if (i === middleIndex) {
                timestamp = (await getEthTime(ethers.provider)) + 100
                blockNumber = await getNextBlockNumber(ethers.provider)
                await setEthTime(ethers.provider, timestamp)

                queueRoot = getTransactionHash(
                  await signer.getAddress(),
                  target,
                  gasLimit,
                  data
                )

                await OVM_CanonicalTransactionChain.enqueue(
                  target,
                  gasLimit,
                  data
                )
              } else {
                await OVM_CanonicalTransactionChain.enqueue(
                  target,
                  gasLimit,
                  '0x' + '12'.repeat(i + 1)
                )
              }
            }

            expect(
              _.toPlainObject(
                await OVM_CanonicalTransactionChain.getQueueElement(middleIndex)
              )
            ).to.deep.include({
              queueRoot,
              timestamp,
              blockNumber,
            })
          })
        }
      })

      describe('when getting the last element', () => {
        for (const size of ELEMENT_TEST_SIZES) {
          it(`gets the element when ${size} elements exist`, async () => {
            let timestamp: number
            let blockNumber: number
            let queueRoot: string

            for (let i = 0; i < size; i++) {
              if (i === size - 1) {
                timestamp = (await getEthTime(ethers.provider)) + 100
                blockNumber = await getNextBlockNumber(ethers.provider)
                await setEthTime(ethers.provider, timestamp)

                queueRoot = getTransactionHash(
                  await signer.getAddress(),
                  target,
                  gasLimit,
                  data
                )

                await OVM_CanonicalTransactionChain.enqueue(
                  target,
                  gasLimit,
                  data
                )
              } else {
                await OVM_CanonicalTransactionChain.enqueue(
                  target,
                  gasLimit,
                  '0x' + '12'.repeat(i + 1)
                )
              }
            }

            expect(
              _.toPlainObject(
                await OVM_CanonicalTransactionChain.getQueueElement(size - 1)
              )
            ).to.deep.include({
              queueRoot,
              timestamp,
              blockNumber,
            })
          })
        }
      })
    })
  })

  describe('appendQueueBatch', () => {
    it('should revert if trying to append zero transactions', async () => {
      await expect(
        OVM_CanonicalTransactionChain.appendQueueBatch(0)
      ).to.be.revertedWith('Must append more than zero transactions.')
    })

    it('should revert if the queue is empty', async () => {
      await expect(
        OVM_CanonicalTransactionChain.appendQueueBatch(1)
      ).to.be.revertedWith('Index too large.')
    })

    describe('when the queue is not empty', () => {
      const target = NON_ZERO_ADDRESS
      const gasLimit = 500_000
      const data = '0x' + '12'.repeat(1234)

      for (const size of ELEMENT_TEST_SIZES) {
        describe(`when the queue has ${size} elements`, () => {
          beforeEach(async () => {
            for (let i = 0; i < size; i++) {
              await OVM_CanonicalTransactionChain.enqueue(
                target,
                gasLimit,
                data
              )
            }
          })

          describe('when the sequencer inclusion period has not passed', () => {
            it('should revert if not called by the sequencer', async () => {
              await expect(
                OVM_CanonicalTransactionChain.connect(signer).appendQueueBatch(
                  1
                )
              ).to.be.revertedWith(
                'Queue transactions cannot be submitted during the sequencer inclusion period.'
              )
            })

            it('should succeed if called by the sequencer', async () => {
              await expect(
                OVM_CanonicalTransactionChain.connect(
                  sequencer
                ).appendQueueBatch(1)
              )
                .to.emit(OVM_CanonicalTransactionChain, 'QueueBatchAppended')
                .withArgs(0, 1)
            })
          })

          describe('when the sequencer inclusion period has passed', () => {
            beforeEach(async () => {
              await increaseEthTime(
                ethers.provider,
                FORCE_INCLUSION_PERIOD_SECONDS * 2
              )
            })

            it('should be able to append a single element', async () => {
              await expect(OVM_CanonicalTransactionChain.appendQueueBatch(1))
                .to.emit(OVM_CanonicalTransactionChain, 'QueueBatchAppended')
                .withArgs(0, 1)
            })

            it(`should be able to append ${size} elements`, async () => {
              await expect(OVM_CanonicalTransactionChain.appendQueueBatch(size))
                .to.emit(OVM_CanonicalTransactionChain, 'QueueBatchAppended')
                .withArgs(0, size)
            })

            it(`should revert if appending ${size} + 1 elements`, async () => {
              await expect(
                OVM_CanonicalTransactionChain.appendQueueBatch(size + 1)
              ).to.be.revertedWith('Index too large.')
            })
          })
        })
      }
    })
  })

  describe('appendSequencerBatch', () => {
    beforeEach(() => {
      OVM_CanonicalTransactionChain = OVM_CanonicalTransactionChain.connect(
        sequencer
      )
    })

    it('should revert if expected start does not match current total batches', async () => {
      await expect(
        OVM_CanonicalTransactionChain.appendSequencerBatch(
          ['0x1234'],
          [
            {
              numSequencedTransactions: 0,
              numSubsequentQueueTransactions: 0,
              timestamp: 0,
              blockNumber: 0,
            },
          ],
          1234,
          1
        )
      ).to.be.revertedWith(
        'Actual batch start index does not match expected start index.'
      )
    })

    it('should revert if not called by the sequencer', async () => {
      await expect(
        OVM_CanonicalTransactionChain.connect(signer).appendSequencerBatch(
          ['0x1234'],
          [
            {
              numSequencedTransactions: 0,
              numSubsequentQueueTransactions: 0,
              timestamp: 0,
              blockNumber: 0,
            },
          ],
          0,
          1
        )
      ).to.be.revertedWith('Function can only be called by the Sequencer.')
    })

    it('should revert if no contexts are provided', async () => {
      await expect(
        OVM_CanonicalTransactionChain.appendSequencerBatch(['0x1234'], [], 0, 1)
      ).to.be.revertedWith('Must provide at least one batch context.')
    })

    it('should revert if total elements to append is zero', async () => {
      await expect(
        OVM_CanonicalTransactionChain.appendSequencerBatch(
          ['0x1234'],
          [
            {
              numSequencedTransactions: 0,
              numSubsequentQueueTransactions: 0,
              timestamp: 0,
              blockNumber: 0,
            },
          ],
          0,
          0
        )
      ).to.be.revertedWith('Must append at least one element.')
    })

    for (const size of ELEMENT_TEST_SIZES) {
      describe(`when appending ${size} sequencer transactions`, () => {
        const target = NON_ZERO_ADDRESS
        const gasLimit = 500_000
        const data = '0x' + '12'.repeat(1234)
        beforeEach(async () => {
          await OVM_CanonicalTransactionChain.enqueue(target, gasLimit, data)
        })

        it('should revert if a queue element needs to be processed', async () => {
          await increaseEthTime(
            ethers.provider,
            FORCE_INCLUSION_PERIOD_SECONDS * 2
          )

          await expect(
            OVM_CanonicalTransactionChain.appendSequencerBatch(
              ['0x1234'],
              [
                {
                  numSequencedTransactions: 0,
                  numSubsequentQueueTransactions: 0,
                  timestamp: 0,
                  blockNumber: 0,
                },
              ],
              0,
              1
            )
          ).to.be.revertedWith(
            'Older queue batches must be processed before a new sequencer batch.'
          )
        })

        it('should revert if the context timestamp is <= the head queue element timestamp', async () => {
          const timestamp = (await getEthTime(ethers.provider)) + 1000

          await expect(
            OVM_CanonicalTransactionChain.appendSequencerBatch(
              ['0x1234'],
              [
                {
                  numSequencedTransactions: 0,
                  numSubsequentQueueTransactions: 0,
                  timestamp: timestamp,
                  blockNumber: 0,
                },
              ],
              0,
              1
            )
          ).to.be.revertedWith('Sequencer transactions timestamp too high.')
        })

        it('should revert if the context block number is <= the head queue element block number', async () => {
          const timestamp = (await getEthTime(ethers.provider)) - 100
          const blockNumber = (await getNextBlockNumber(ethers.provider)) + 100

          await expect(
            OVM_CanonicalTransactionChain.appendSequencerBatch(
              ['0x1234'],
              [
                {
                  numSequencedTransactions: 0,
                  numSubsequentQueueTransactions: 0,
                  timestamp: timestamp,
                  blockNumber: blockNumber,
                },
              ],
              0,
              1
            )
          ).to.be.revertedWith('Sequencer transactions blockNumber too high.')
        })

        describe('when not inserting queue elements in between', () => {
          describe('when using a single batch context', () => {
            let contexts: any[]
            let transactions: any[]
            beforeEach(async () => {
              const timestamp = (await getEthTime(ethers.provider)) - 100
              const blockNumber =
                (await getNextBlockNumber(ethers.provider)) - 10

              contexts = [
                {
                  numSequencedTransactions: size,
                  numSubsequentQueueTransactions: 0,
                  timestamp: timestamp,
                  blockNumber: blockNumber,
                },
              ]

              transactions = [...Array(size)].map((el, idx) => {
                return '0x' + '12' + '34'.repeat(idx)
              })
            })

            it('should append the given number of transactions', async () => {
              await expect(
                OVM_CanonicalTransactionChain.appendSequencerBatch(
                  transactions,
                  contexts,
                  0,
                  size
                )
              )
                .to.emit(OVM_CanonicalTransactionChain, 'SequencerBatchAppended')
                .withArgs(0, 0)
            })
          })
        })

        describe('when inserting queue elements in between', () => {
          beforeEach(async () => {
            for (let i = 0; i < size; i++) {
              await OVM_CanonicalTransactionChain.enqueue(
                target,
                gasLimit,
                data
              )
            }
          })

          describe('between every other sequencer transaction', () => {
            let contexts: any[]
            let transactions: any[]
            beforeEach(async () => {
              const timestamp = (await getEthTime(ethers.provider)) - 100
              const blockNumber =
                (await getNextBlockNumber(ethers.provider)) - 50

              contexts = [...Array(size)].map(() => {
                return {
                  numSequencedTransactions: 1,
                  numSubsequentQueueTransactions: 1,
                  timestamp: timestamp,
                  blockNumber: Math.max(blockNumber, 0),
                }
              })

              transactions = [...Array(size)].map((el, idx) => {
                return '0x' + '12' + '34'.repeat(idx)
              })
            })

            it('should append the batch', async () => {
              await expect(
                OVM_CanonicalTransactionChain.appendSequencerBatch(
                  transactions,
                  contexts,
                  0,
                  size * 2
                )
              )
                .to.emit(OVM_CanonicalTransactionChain, 'SequencerBatchAppended')
                .withArgs(0, size)
            })
          })

          describe(`between every ${Math.max(
            Math.floor(size / 8),
            1
          )} sequencer transaction`, () => {
            const spacing = Math.max(Math.floor(size / 8), 1)
            let contexts: any[]
            let transactions: any[]
            beforeEach(async () => {
              const timestamp = (await getEthTime(ethers.provider)) - 100
              const blockNumber =
                (await getNextBlockNumber(ethers.provider)) - 50

              contexts = [...Array(spacing)].map(() => {
                return {
                  numSequencedTransactions: size / spacing,
                  numSubsequentQueueTransactions: 1,
                  timestamp: timestamp,
                  blockNumber: Math.max(blockNumber, 0),
                }
              })

              transactions = [...Array(size)].map((el, idx) => {
                return '0x' + '12' + '34'.repeat(idx)
              })
            })

            it('should append the batch', async () => {
              await expect(
                OVM_CanonicalTransactionChain.appendSequencerBatch(
                  transactions,
                  contexts,
                  0,
                  size + spacing
                )
              )
                .to.emit(OVM_CanonicalTransactionChain, 'SequencerBatchAppended')
                .withArgs(0, spacing)
            })
          })
        })
      })
    }
  })

  describe('getTotalElements', () => {
    it('should return zero when no elements exist', async () => {
      expect(await OVM_CanonicalTransactionChain.getTotalElements()).to.equal(0)
    })

    for (const size of ELEMENT_TEST_SIZES) {
      describe(`when the sequencer inserts a batch of ${size} elements`, () => {
        beforeEach(async () => {
          const timestamp = (await getEthTime(ethers.provider)) - 100
          const blockNumber = (await getNextBlockNumber(ethers.provider)) - 10

          const contexts = [
            {
              numSequencedTransactions: size,
              numSubsequentQueueTransactions: 0,
              timestamp: timestamp,
              blockNumber: Math.max(blockNumber, 0),
            },
          ]

          const transactions = [...Array(size)].map((el, idx) => {
            return '0x' + '12' + '34'.repeat(idx)
          })

          await OVM_CanonicalTransactionChain.connect(
            sequencer
          ).appendSequencerBatch(transactions, contexts, 0, size)
        })

        it(`should return ${size}`, async () => {
          expect(
            await OVM_CanonicalTransactionChain.getTotalElements()
          ).to.equal(size)
        })
      })
    }
  })
})