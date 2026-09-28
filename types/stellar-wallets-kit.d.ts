declare module '@creit.tech/stellar-wallets-kit' {
  export enum WalletNetwork {
    PUBLIC = 'PUBLIC',
    TESTNET = 'TESTNET',
    FUTURENET = 'FUTURENET',
  }

  export enum XBULL_ID {
    PUBLIC = 'PUBLIC',
    TESTNET = 'TESTNET',
  }

  export enum FREIGHTER_ID {
    PUBLIC = 'PUBLIC',
    TESTNET = 'TESTNET',
  }

  export enum ALBEDO_ID {
    PUBLIC = 'PUBLIC',
    TESTNET = 'TESTNET',
  }

  export enum KitEventType {
    WALLET_CHANGED = 'WALLET_CHANGED',
    NETWORK_CHANGED = 'NETWORK_CHANGED',
    STATE_UPDATED = 'STATE_UPDATED',
  }

  export const Networks: {
    PUBLIC: string;
    TESTNET: string;
    FUTURENET: string;
  };

  export function parseError(error: any): { message: string; code?: string };

  export interface WalletKitConfig {
    network?: WalletNetwork | string;
    selectedWalletId?: string;
    modules?: any[];
  }

  export interface WalletKitState {
    address: string;
    publicKey: string;
    walletId: string;
  }

  export class StellarWalletsKit {
    constructor(config: WalletKitConfig);
    static init(config: WalletKitConfig): StellarWalletsKit;
    static openModal(options?: any): Promise<WalletKitState>;
    static setNetwork(network: WalletNetwork): Promise<void>;
    static getPublicKey(): Promise<string>;
    static getAddress(): Promise<{ address: string }>;
    static getNetwork(): Promise<{ network: string; networkPassphrase: string }>;
    static sign(xdr: string, options?: any): Promise<{ result: string }>;
    static signTransaction(xdr: string, options?: any): Promise<{ signedTxXdr: string }>;
    static signAuthEntry(entry: string, options?: any): Promise<{ signedAuthEntry: string }>;
    static signBlob(blob: string, options?: any): Promise<{ signedBlob: string }>;
    static getSupportedWallets(): any[];
    static disconnect(): Promise<void>;
    static on(event: string, callback: (payload: any) => void): void;
    static selectedModule?: any;
    static authModal?: {
      (): Promise<{ address: string }>;
      open(options: any): Promise<any>;
      next(data: any): void;
    };
    
    // Instance methods (also available)
    openModal(options?: any): Promise<WalletKitState>;
    setNetwork(network: WalletNetwork): Promise<void>;
    getPublicKey(): Promise<string>;
    getAddress(): Promise<{ address: string }>;
    getNetwork(): Promise<{ network: string; networkPassphrase: string }>;
    sign(xdr: string, options?: any): Promise<{ result: string }>;
    signTransaction(xdr: string, options?: any): Promise<{ result: string }>;
    signAuthEntry(entry: string, options?: any): Promise<{ signedAuthEntry: string }>;
    signBlob(blob: string, options?: any): Promise<{ signedBlob: string }>;
    getSupportedWallets(): any[];
    disconnect(): Promise<void>;
    on(event: string, callback: (payload: any) => void): void;
    selectedModule?: any;
    authModal?: {
      (): Promise<{ address: string }>;
      open(options: any): Promise<any>;
      next(data: any): void;
    };
  }

  export default StellarWalletsKit;
}

declare module '@creit.tech/stellar-wallets-kit/modules/utils' {
  export function allowAllModules(): any[];
  export function defaultModules(): any[];
}

declare module '@creit.tech/stellar-wallets-kit/modules/freighter' {
  export const FREIGHTER_ID: string;
  export class FreighterModule {
    constructor(config?: any);
  }
}
