import chalk from 'chalk';
import { runCommand, getMockTokenId, getPhaseProtocolId, REQUIRED_AMOUNT, TOKEN_SYMBOL, TESTING_SECRET_KEY } from './utils.js';
import { Keypair } from '@stellar/stellar-sdk';
import * as readline from 'readline';

const MOCK_TOKEN_ID = getMockTokenId()!;
const PHASE_PROTOCOL_ID = getPhaseProtocolId()!;
const ADMIN_ADDRESS = TESTING_SECRET_KEY ? Keypair.fromSecret(TESTING_SECRET_KEY).publicKey() : '';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

const prompt = (q: string): Promise<string> => new Promise(r => {
  rl.question(chalk.gray('› ') + q, (a) => r(a || ''));
});

/** Banner PHASE: gris; bloque OPERATIONS completo en verde */
const phaseBanner = chalk.gray;

const BANNER_LINES = [
  '  ╔════════════════════════════════════════════════════════════════╗',
  '  ║  ██████╗  ██╗  ██╗  █████╗  ███████╗ ███████╗                  ║',
  '  ║  ██╔══██╗ ██║  ██║ ██╔══██╗ ██╔════╝ ██╔════╝                  ║',
  '  ║  ██████╔╝ ███████║ ███████║ ███████╗ █████╗                    ║',
  '  ║  ██╔═══╝  ██╔══██║ ██╔══██║ ╚════██║ ██╔══╝                    ║',
  '  ║  ██║      ██║  ██║ ██║  ██║ ███████║ ███████╗                  ║',
  '  ║  ╚═╝      ╚═╝  ╚═╝ ╚═╝  ╚═╝ ╚══════╝ ╚══════╝                  ║',
  '  ║                                       PROTOCOL v0.1_           ║',
  '  ╚════════════════════════════════════════════════════════════════╝',
] as const;

function printCentered(text: string, paint: (s: string) => string = chalk.greenBright) {
  const cols = process.stdout.columns || 80;
  const pad = Math.max(0, Math.floor((cols - text.length) / 2));
  console.log(' '.repeat(pad) + paint(text));
}

const box = (lines: string[], w = 48) => {
  const border = '─'.repeat(w);
  console.log(chalk.gray('┌' + border + '┐'));
  lines.forEach(l => console.log(chalk.gray('│') + ' ' + l.padEnd(w) + chalk.gray('│')));
  console.log(chalk.gray('└' + border + '┘'));
};

const header = () => {
  console.log('\n');
  for (const line of BANNER_LINES) {
    console.log(phaseBanner(line));
  }
  console.log();
  console.log(chalk.gray('  CORE:') + ' ' + chalk.green(PHASE_PROTOCOL_ID));
  console.log(chalk.gray('  ASSET:') + ' ' + chalk.green(MOCK_TOKEN_ID));
  console.log(chalk.gray('  WALLET:') + ' ' + chalk.green(ADMIN_ADDRESS));
  console.log(chalk.gray('  SDK:') + ' ' + chalk.green('stellar-sdk v15 · soroban-sdk 22 (wasm32-unknown-unknown)'));
  console.log();
};

const menu = () => {
  const menuGreen = chalk.green;
  const lines = [
    '  ┌─ OPERATIONS ──────────────────────────────────────────────┐',
    '  │ 1. Mint Assets      │ Emit test tokens               │',
    '  │ 2. Check Balance    │ View token balance             │',
    '  │ 3. Read Protocol    │ View contract config           │',
    '  │ 4. Verify Solidity   │ Check if phased                 │',
    '  │ 5. Execute Fusion   │ ✦ INITIATE PHASE ✦             │',
    '  │ 6. Fetch User State │ View user phase data            │',
    '  │ 7. Global Counter   │ Total phase transitions        │',
    '  │ 0. Exit             │ Close terminal                  │',
    '  └───────────────────────────────────────────────────────────┘',
  ];
  for (const line of lines) console.log(menuGreen(line));
  console.log();
};

const msg = (text: string, color = 'green') => {
  const c = color === 'red' ? chalk.red : color === 'yellow' ? chalk.yellow : chalk.green;
  box([c(text)], 46);
};

const err = (text: string) => msg(text, 'red');

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

async function mintAssets() {
  header();
  const amountStr = await prompt('Amount to mint (e.g. 1.0):');
  const amount = parseFloat(amountStr);
  if (isNaN(amount) || amount <= 0) { err('Invalid amount'); await prompt(''); return; }
  
  const contractAmount = Math.floor(amount * 10000000);
  console.log(chalk.gray('  › ') + chalk.yellow('Minting...'));
  
  const { stdout } = await runCommand(
    `stellar contract invoke --id ${MOCK_TOKEN_ID} --source deployer --network testnet --network-passphrase "Test SDF Network ; September 2015" -- mint_public --to ${ADMIN_ADDRESS} --amount ${contractAmount}`
  );
  
  header();
  msg('✓ Minted ' + amount + ' ' + TOKEN_SYMBOL);
  console.log(chalk.gray('  ' + (stdout || '').substring(0, 50)));
  await prompt('');
}

async function checkBalance() {
  header();
  console.log(chalk.gray('  › ') + chalk.yellow('Querying...'));
  
  const { stdout, stderr } = await runCommand(
    `stellar contract invoke --id ${MOCK_TOKEN_ID} --source deployer --network testnet --network-passphrase "Test SDF Network ; September 2015" -- balance --address ${ADMIN_ADDRESS}`
  );
  
  const raw = (stdout || stderr || '0').replace(/"/g, '').trim();
  let balance = 0;
  try { balance = parseInt(raw) / 10000000; } catch { console.log('DEBUG raw:', raw); }
  
  const required = parseInt(REQUIRED_AMOUNT) / 10000000;
  const eligible = balance >= required;
  
  header();
  box([
    chalk.gray('BALANCE: ') + chalk.green(balance.toFixed(7) + ' ' + TOKEN_SYMBOL),
    chalk.gray('STATUS:  ') + (eligible ? chalk.green('✓ ELIGIBLE') : chalk.red('✗ NEEDS ' + (required - balance).toFixed(7) + ' MORE'))
  ], 50);
  await prompt('');
}

async function readProtocol() {
  header();
  const { stdout } = await runCommand(
    `stellar contract invoke --id ${PHASE_PROTOCOL_ID} --source deployer --network testnet --network-passphrase "Test SDF Network ; September 2015" -- get_config`
  );
  
  header();
  box([chalk.green(stdout?.trim() || 'No data')], 50);
  await prompt('');
}

async function verifySolidity() {
  header();
  const { stdout } = await runCommand(
    `stellar contract invoke --id ${PHASE_PROTOCOL_ID} --source deployer --network testnet --network-passphrase "Test SDF Network ; September 2015" -- has_phased --user ${ADMIN_ADDRESS}`
  );
  
  const phased = (stdout || '').trim().toLowerCase().includes('true');
  header();
  box([
    chalk.gray('USER:   ') + chalk.green(ADMIN_ADDRESS.substring(0, 10) + '...'),
    chalk.gray('PHASED: ') + (phased ? chalk.green('✓ TRUE') : chalk.yellow('✗ FALSE'))
  ], 50);
  await prompt('');
}

async function executeFusion() {
  const loadingLine = '[ PHASE TRANSITION IN PROGRESS... ]';

  console.clear();
  printCentered(loadingLine, chalk.greenBright);
  await delay(1800);

  console.clear();
  console.log(chalk.red('  ⚠ WARNING: This will transfer ') + (parseInt(REQUIRED_AMOUNT)/10000000) + chalk.red(' tokens to the contract.'));
  console.log(chalk.red('  ⚠ Tokens will be LOCKED PERMANENTLY.'));
  console.log();
  
  const confirm = await prompt('Type CONFIRM to proceed:');
  if (confirm !== 'CONFIRM') {
    header(); msg('Operation cancelled'); await prompt(''); return;
  }
  
  console.clear();
  printCentered(loadingLine, chalk.greenBright);

  const { stdout, stderr } = await runCommand(
    `stellar contract invoke --id ${PHASE_PROTOCOL_ID} --source deployer --network testnet --network-passphrase "Test SDF Network ; September 2015" -- initiate_phase --user ${ADMIN_ADDRESS} --token_address ${MOCK_TOKEN_ID} --collection_id 0`
  );

  console.clear();
  box([
    chalk.greenBright.bold('  ╔═══════════════════════════════════════╗'),
    chalk.greenBright.bold('  ║     ✦ FUSION X402 COMPLETE ✦          ║'),
    chalk.greenBright.bold('  ╚═══════════════════════════════════════╝'),
    '',
    chalk.gray((stdout || stderr || '').substring(0, 44))
  ], 48);
  await prompt('');
}

async function fetchUserState() {
  header();
  const { stdout } = await runCommand(
    `stellar contract invoke --id ${PHASE_PROTOCOL_ID} --source deployer --network testnet --network-passphrase "Test SDF Network ; September 2015" -- get_user_phase --user ${ADMIN_ADDRESS} --collection_id 0`
  );
  
  header();
  box([
    chalk.gray('USER: ') + chalk.green(ADMIN_ADDRESS.substring(0, 10) + '...'),
    chalk.gray('DATA: ') + (stdout?.trim() ? chalk.green(stdout.trim()) : chalk.yellow('No phase data'))
  ], 50);
  await prompt('');
}

async function globalCounter() {
  header();
  const { stdout } = await runCommand(
    `stellar contract invoke --id ${PHASE_PROTOCOL_ID} --source deployer --network testnet --network-passphrase "Test SDF Network ; September 2015" -- get_total_phases`
  );
  
  header();
  box([chalk.green('Total: ') + chalk.greenBright(stdout?.trim() || '0')], 40);
  await prompt('');
}

async function main() {
  if (!MOCK_TOKEN_ID || !PHASE_PROTOCOL_ID) {
    console.log(chalk.red('  Error: Contract IDs not found in .env'));
    process.exit(1);
  }
  
  while (true) {
    header();
    menu();
    
    const choice = await prompt('Select operation:');
    
    switch (choice) {
      case '1': await mintAssets(); break;
      case '2': await checkBalance(); break;
      case '3': await readProtocol(); break;
      case '4': await verifySolidity(); break;
      case '5': await executeFusion(); break;
      case '6': await fetchUserState(); break;
      case '7': await globalCounter(); break;
      case '0':
        console.log();
        box([chalk.green('Session terminated')], 40);
        console.log();
        rl.close();
        process.exit(0);
      default:
        err('Invalid option');
        await delay(800);
    }
  }
}

main();
