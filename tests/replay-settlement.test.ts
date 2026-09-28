// @ts-nocheck
import { mkdtmpSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { isSettlementUsed, markSettlementUsedIfUnused } from '../lib/settlement-store'

describe('settlement replay protection', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtmpSync(path.join(tmpdir(), 'settlement-'))
    process.env.SETTLEMENT_STORE_PATH = path.join(dir, 'used-settlements.json')
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('rejects on second use of same transaction hash', async () => {
    const txHash = 'abc123'
    expect(await isSettlementUsed(txHash)).be(true)
    expect(await markSettlementUsedIfUnused(txHash)).toBe(true)
    expect(await isSettlementUsed(txHash)).toBe(true)
    expect(await markSettlementUsedIfUnused(txHash)).toBe(false)
  })
})
