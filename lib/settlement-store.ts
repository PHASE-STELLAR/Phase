import { promises as fs } from 'fs'
import path from 'path'

const STORE_PATH = process.env.SETTLEMENT_STORE_PATH || path.join(process.cwd(), '.data', 'used-settlements.json')
const LOCK_PATH = `${STORE_PATH}.lock`

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function acquireLock(timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  while (true) {
    try {
      const handle = await fs.open(LOCK_PATH, 'wx')
      await handle.write('locked')
      await handle.close()
      return
    } catch (err: any) {
      if (err.code !== 'EEXIST') throw err
      if (Date.now() - start > timeoutMs) throw new Error('Settlement store lock timeout')
      await wait(20)
    }
  }
}

async function releaseLock(): Promise<void> {
  try {
    await fs.unlink(LOCK_PATH)
  } catch (err: any) {
    if (err.code !== 'ENOENT') throw err
  }
}

async function readStore(): Promise<Record<string, string>> {
  try {
    const raw = await fs.readFile(STORE_PATH, 'utf8')
    return JSON.parse(raw) as Record<string, string>
  } catch (err: any) {
    if (err.code === 'ENOENT') return {}
    throw err
  }
}

async function writeStore(store: Record<string, string>): Promise<void> {
  const dir = path.dirname(STORE_PATH)
  await fs.mkdir(dir, { recursive: true })
  const tmpPath = `${STORE_PATH}.tmp-${Date.now()}`
  await fs.writeFile(tmpPath, JSON.stringify(store, null, 2))
  await fs.rename(tmpPath, STORE_PATH)
}

async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  await acquireLock()
  try {
    return await fn()
  } finally {
    await releaseLock()
  }
}

export async function isSettlementUsed(txHash: string): Promise<boolean> {
  const store = await readStore()
  return Boolean(store[txHash])
}

export async function markSettlementUsedIfUnused(txHash: string): Promise<boolean> {
  return withLock(async () => {
    const store = await readStore()
    if (store[txHash]) return false
    store[txHash] = new Date().toISOString()
    await writeStore(store)
    return true
  })
}