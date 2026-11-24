/**
 * #279: achievement-store must key wallets case-insensitively (G... vs g...)
 * Run: npx tsx tests/achievement-wallet-case.test.ts
 */
import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const WALLET = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H"

async function main() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "phase-ach-"))
  process.env.PHASE_SERVER_DATA_DIR = dir
  const file = path.join(dir, "achievements.json")

  const { checkAndUnlock, getAchievements, getWalletData, unlockAchievement } =
    await import("@/lib/achievement-store")

  // Writes via lowercase and uppercase land in one entry
  await unlockAchievement(WALLET.toLowerCase(), "first_mint")
  assert.equal(await unlockAchievement(WALLET, "first_mint"), false)
  await checkAndUnlock(` ${WALLET.toLowerCase()} `, { signal_posted: true })
  const stored = JSON.parse(await readFile(file, "utf8"))
  assert.deepEqual(Object.keys(stored), [WALLET])
  assert.deepEqual(
    (await getAchievements(WALLET.toLowerCase())).map((a) => a.id).sort(),
    ["first_mint", "signal_pioneer"],
  )
  console.log("✓ G... and g... resolve to one entry")

  // Legacy split entries are merged on read
  await writeFile(
    file,
    JSON.stringify({
      [WALLET]: { unlocked: [{ id: "first_mint", unlocked_at: 200 }], mint_count: 2 },
      [WALLET.toLowerCase()]: {
        unlocked: [
          { id: "first_mint", unlocked_at: 100 },
          { id: "collector_5", unlocked_at: 150 },
        ],
        mint_count: 5,
      },
    }),
  )
  const merged = await getWalletData(WALLET)
  assert.equal(merged.mint_count, 5)
  assert.deepEqual(
    merged.unlocked.map((a) => [a.id, a.unlocked_at]).sort(),
    [["collector_5", 150], ["first_mint", 100]],
  )
  console.log("✓ legacy mixed-case entries merge")
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
