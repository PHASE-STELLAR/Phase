/**
 * Utilidades compartidas para scripts de PHASE Protocol
 */

import { Horizon, rpc, Contract, TransactionBuilder, Networks, Asset, Operation, Keypair, Transaction } from '@stellar/stellar-sdk';
import * as dotenv from 'dotenv';

dotenv.config();

// Configuration
export const RPC_URL = process.env.STELLAR_RPC_URL || 'https://soroban-testnet.stellar.org';
export const NETWORK_PASSPHRASE = process.env.STELLAR_NETWORK_PASSPHRASE || 'Test SDF Network ; September 2015';
export const TOKEN_DECIMALS = parseInt(process.env.TOKEN_DECIMALS || '7');
export const REQUIRED_AMOUNT = process.env.REQUIRED_AMOUNT || '10000000';
export const TOKEN_NAME = process.env.TOKEN_NAME || 'Phase Liquidity';
export const TOKEN_SYMBOL = process.env.TOKEN_SYMBOL || "PHASELQ"
export const TOKEN_ICON_PATH = process.env.TOKEN_ICON_PATH || '/phaser-liq-token.png';
export const TESTING_SECRET_KEY = process.env.TESTING_SECRET_KEY;

// RPC client
export const sorobanRpc = new rpc.Server(RPC_URL, { allowHttp: true });
export const horizon = new Horizon.Server('https://horizon-testnet.stellar.org');

// Contract IDs
export const getMockTokenId = () => process.env.MOCK_TOKEN_ID;
export const getPhaseProtocolId = () => process.env.PHASE_PROTOCOL_ID;

// Freighter integration helper
export const checkFreighterConnection = async (): Promise<boolean> => {
  // This will be handled by the browser-side code
  return typeof window !== 'undefined' && (window as any).freighterApi?.isConnected?.();
};

// Convert human-readable amount to contract amount
export const toContractAmount = (amount: number): string => {
  return (amount * Math.pow(10, TOKEN_DECIMALS)).toString();
};

// Convert contract amount to human-readable
export const fromContractAmount = (amount: string): number => {
  return parseInt(amount) / Math.pow(10, TOKEN_DECIMALS);
};

// Format amount for display
export const formatAmount = (amount: string): string => {
  return `${fromContractAmount(amount).toFixed(TOKEN_DECIMALS)} ${TOKEN_SYMBOL}`;
};

// Simulation helper - prepares transaction for simulation
export const simulateTransaction = async (tx: Transaction) => {
  return await sorobanRpc.simulateTransaction(tx);
};

// Wait for transaction completion
export const waitForTransaction = async (hash: string): Promise<any> => {
  let result;
  let attempts = 0;
  const maxAttempts = 30;

  while (attempts < maxAttempts) {
    result = await sorobanRpc.getTransaction(hash);

    if (result.status !== rpc.Api.GetTransactionStatus.NOT_FOUND) {
      return result;
    }

    attempts++;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  throw new Error('Transaction timeout');
};

// Parse contract result
export const parseResult = (result: any): any => {
  if (!result?.returnValue) {
    return null;
  }

  const value = result.returnValue;

  // Handle different types
  switch (value.switch().name) {
    case 'scvU64':
      return value.u64().toString();
    case 'scvI128':
      return value.i128().lo().toString();
    case 'scvBool':
      return value.b();
    case 'scvVec':
      return value.vec().map(parseResult);
    case 'scvMap':
      return Object.fromEntries(
        value.map().map((entry: any) => [
          parseResult(entry.key()),
          parseResult(entry.val())
        ])
      );
    case 'scvAddress':
      return value.address().toString();
    default:
      return value.toString();
  }
};

// CLI helper to run commands
export const runCommand = async (command: string): Promise<{ stdout: string; stderr: string }> => {
  const { exec } = await import('child_process');
  const { promisify } = await import('util');
  const execAsync = promisify(exec);

  try {
    const { stdout, stderr } = await execAsync(command);
    return { stdout, stderr };
  } catch (error: any) {
    return { stdout: '', stderr: error.message };
  }
};

// Parse contract ID from deploy output
export const parseContractId = (output: string): string | null => {
  // Look for pattern like: CABC...1234 (base32 encoded Soroban address)
  const match = output.match(/C[A-Z2-7]{55}/);
  return match ? match[0] : null;
};

// Log helpers
export const log = {
  info: (msg: string) => console.log(`ℹ️  ${msg}`),
  success: (msg: string) => console.log(`✅ ${msg}`),
  error: (msg: string) => console.log(`❌ ${msg}`),
  warning: (msg: string) => console.log(`⚠️  ${msg}`),
  section: (title: string) => console.log(`\n📦 ${title}\n${'─'.repeat(50)}`),
};

// Colors for terminal
export const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};

// Prompt helper
export const prompt = async (question: string): Promise<string> => {
  const readline = await import('readline');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question(`${colors.cyan}?${colors.reset} ${question} `, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
};
