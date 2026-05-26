import { Buffer } from "node:buffer";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toHex, type ContractState } from "@midnight-ntwrk/compact-runtime";
import {
  createShieldedCoinInfo,
  decodeRawTokenType,
  encodeRawTokenType,
  encodeShieldedCoinInfo,
  nativeToken,
  DustSecretKey,
  LedgerParameters,
  ZswapSecretKeys,
  type CoinPublicKey,
  type EncPublicKey,
  type FinalizedTransaction,
} from "@midnight-ntwrk/ledger-v8";
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { levelPrivateStateProvider } from "@midnight-ntwrk/midnight-js-level-private-state-provider";
import { NodeZkConfigProvider } from "@midnight-ntwrk/midnight-js-node-zk-config-provider";
import { httpClientProofProvider } from "@midnight-ntwrk/midnight-js-http-client-proof-provider";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { type MidnightProvider, type UnboundTransaction, type WalletProvider } from "@midnight-ntwrk/midnight-js-types";
import { ttlOneHour } from "@midnight-ntwrk/midnight-js-utils";
import { InMemoryTransactionHistoryStorage } from "@midnight-ntwrk/wallet-sdk-abstractions";
import {
  WalletEntrySchema,
  WalletFacade,
  mergeWalletEntries,
  type DefaultConfiguration,
} from "@midnight-ntwrk/wallet-sdk-facade";
import { ShieldedWallet } from "@midnight-ntwrk/wallet-sdk-shielded";
import { DustWallet } from "@midnight-ntwrk/wallet-sdk-dust-wallet";
import { PublicKey, UnshieldedWallet, createKeystore } from "@midnight-ntwrk/wallet-sdk-unshielded-wallet";
import { HDWallet, Roles, type Role } from "@midnight-ntwrk/wallet-sdk-hd";
import { DynamicContractAPI, type DynamicProviders } from "nite-api";
import * as Rx from "rxjs";
import { compiledEffectsCheckReproContract, CompiledEffectsCheckReproContract } from "./index.js";
import type { Contract, Ledger, ShieldedCoinInfo } from "./managed/repro/contract/index.js";

type ReproPrivateStateId = "repro_ps";

type EnvironmentConfiguration = {
  walletNetworkId: "undeployed" | "preview";
  networkId: "undeployed" | "preview";
  indexer: string;
  indexerWS: string;
  nodeWS: string;
  proofServer: string;
};

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, "..");
const NATIVE_COIN_COLOR = encodeRawTokenType(nativeToken().raw);
const SCALE_FACTOR = 1_000_000n;
const DEFAULT_WALLET_SEED = "0000000000000000000000000000000000000000000000000000000000000001";

const logger = {
  info: (...args: unknown[]) => console.log(...args),
  warn: (...args: unknown[]) => console.warn(...args),
  error: (...args: unknown[]) => console.error(...args),
  debug: (...args: unknown[]) => {
    if (process.env.DEBUG_REPRO === "1") console.debug(...args);
  },
};

const requireEnv = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
};

const envFromProcess = (): EnvironmentConfiguration => {
  const network = (process.env.NETWORK_ID ?? "undeployed") as "undeployed" | "preview";
  if (network === "preview") {
    return {
      walletNetworkId: "preview",
      networkId: "preview",
      indexer: process.env.INDEXER_URL ?? "https://indexer.preview.midnight.network/api/v4/graphql",
      indexerWS: process.env.INDEXER_WS_URL ?? "wss://indexer.preview.midnight.network/api/v4/graphql/ws",
      nodeWS: process.env.NODE_WS_URL ?? "wss://rpc.preview.midnight.network",
      proofServer: requireEnv("PROOF_SERVER_URL"),
    };
  }
  if (network !== "undeployed") throw new Error(`Unsupported NETWORK_ID=${network}. Use undeployed or preview.`);
  return {
    walletNetworkId: "undeployed",
    networkId: "undeployed",
    indexer: requireEnv("INDEXER_URL"),
    indexerWS: requireEnv("INDEXER_WS_URL"),
    nodeWS: requireEnv("NODE_WS_URL"),
    proofServer: requireEnv("PROOF_SERVER_URL"),
  };
};

const deriveKeyForRole = (masterSeedHex: string, role: Role): Uint8Array => {
  const result = HDWallet.fromSeed(Buffer.from(masterSeedHex, "hex"));
  if (result.type !== "seedOk") throw new Error(`Wallet seed error: ${String(result.error)}`);
  const derivation = result.hdWallet.selectAccount(0).selectRole(role).deriveKeyAt(0);
  if (derivation.type === "keyOutOfBounds") throw new Error("Key derivation out of bounds");
  return derivation.key;
};

const walletConfig = (env: EnvironmentConfiguration): DefaultConfiguration =>
  ({
    indexerClientConnection: {
      indexerHttpUrl: env.indexer,
      indexerWsUrl: env.indexerWS,
    },
    provingServerUrl: new URL(env.proofServer),
    networkId: env.walletNetworkId,
    relayURL: new URL(env.nodeWS),
    txHistoryStorage: new InMemoryTransactionHistoryStorage(WalletEntrySchema, mergeWalletEntries),
    costParameters: {
      additionalFeeOverhead:
        env.walletNetworkId === "undeployed"
          ? BigInt(process.env.MIDNIGHT_UNDEPLOYED_FEE_OVERHEAD ?? "500000000000000000")
          : 1_000n,
      feeBlocksMargin: 5,
    },
  }) as unknown as DefaultConfiguration;

class ReproWalletProvider implements MidnightProvider, WalletProvider {
  private constructor(
    readonly wallet: WalletFacade,
    readonly zswapSecretKeys: ZswapSecretKeys,
    readonly dustSecretKey: DustSecretKey,
    private readonly unshieldedKeystore: ReturnType<typeof createKeystore>,
  ) {}

  static async build(env: EnvironmentConfiguration, seed = DEFAULT_WALLET_SEED): Promise<ReproWalletProvider> {
    const shieldedSeed = deriveKeyForRole(seed, Roles.Zswap);
    const unshieldedSeed = deriveKeyForRole(seed, Roles.NightExternal);
    const dustSeed = deriveKeyForRole(seed, Roles.Dust);
    const keystore = createKeystore(unshieldedSeed, env.walletNetworkId);
    const config = walletConfig(env);
    const shielded = ShieldedWallet(config as any).startWithSeed(shieldedSeed);
    const unshielded = UnshieldedWallet(config as any).startWithPublicKey(PublicKey.fromKeyStore(keystore));
    const dust = DustWallet(config as any).startWithSeed(dustSeed, LedgerParameters.initialParameters().dust);
    const wallet = await WalletFacade.init({
      configuration: config,
      shielded: () => shielded,
      unshielded: () => unshielded,
      dust: () => dust,
    });
    return new ReproWalletProvider(
      wallet,
      ZswapSecretKeys.fromSeed(shieldedSeed),
      DustSecretKey.fromSeed(dustSeed),
      keystore,
    );
  }

  getCoinPublicKey(): CoinPublicKey {
    return this.zswapSecretKeys.coinPublicKey;
  }

  getEncryptionPublicKey(): EncPublicKey {
    return this.zswapSecretKeys.encryptionPublicKey;
  }

  async balanceTx(tx: UnboundTransaction, ttl: Date = ttlOneHour()): Promise<FinalizedTransaction> {
    const recipe = await this.wallet.balanceUnboundTransaction(
      tx,
      { shieldedSecretKeys: this.zswapSecretKeys, dustSecretKey: this.dustSecretKey },
      { ttl },
    );
    const signedRecipe = await this.wallet.signRecipe(recipe, (payload: Uint8Array) => this.unshieldedKeystore.signData(payload));
    return this.wallet.finalizeRecipe(signedRecipe);
  }

  submitTx(tx: FinalizedTransaction): Promise<string> {
    return this.wallet.submitTransaction(tx);
  }

  start(): Promise<void> {
    return this.wallet.start(this.zswapSecretKeys, this.dustSecretKey);
  }

  stop(): Promise<void> {
    return this.wallet.stop();
  }
}

const isProgressStrictlyComplete = (progress: unknown): boolean =>
  typeof (progress as { isStrictlyComplete?: unknown })?.isStrictlyComplete === "function" &&
  ((progress as { isStrictlyComplete: () => boolean }).isStrictlyComplete());

const syncWallet = async (wallet: WalletFacade): Promise<void> => {
  await Rx.firstValueFrom(
    wallet.state().pipe(
      Rx.filter(
        (state: any) =>
          isProgressStrictlyComplete(state.shielded.state.progress) &&
          isProgressStrictlyComplete(state.unshielded.progress) &&
          isProgressStrictlyComplete(state.dust.state.progress),
      ),
      Rx.take(1),
    ),
  );
};

const parseScaledAmountToBigint = (amount: string): bigint => {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(amount.trim());
  if (match == null) throw new Error(`Invalid amount "${amount}"`);
  const [, whole, fractional = ""] = match;
  if (fractional.length > 6) throw new Error(`Invalid amount "${amount}": maximum 6 decimal places`);
  return BigInt(whole) * SCALE_FACTOR + BigInt(fractional.padEnd(6, "0"));
};

const shieldedCoin = (amount: string, color: Uint8Array = NATIVE_COIN_COLOR): ShieldedCoinInfo =>
  encodeShieldedCoinInfo(createShieldedCoinInfo(decodeRawTokenType(color), parseScaledAmountToBigint(amount))) as ShieldedCoinInfo;

const configureProviders = (
  env: EnvironmentConfiguration,
  walletProvider: ReproWalletProvider,
): DynamicProviders<Contract, ReproPrivateStateId> => {
  const zkConfigProvider = new NodeZkConfigProvider<any>(
    path.resolve(repoRoot, "dist", "managed", "repro"),
  );
  const accountId = walletProvider.getCoinPublicKey();
  const privateStoragePasswordProvider = async () => `${Buffer.from(accountId, "hex").toString("base64")}!`;
  return {
    privateStateProvider: levelPrivateStateProvider<ReproPrivateStateId>({
      privateStateStoreName: "effects-check-repro-private-state",
      accountId,
      privateStoragePasswordProvider,
    }),
    publicDataProvider: indexerPublicDataProvider(env.indexer, env.indexerWS),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(env.proofServer, zkConfigProvider),
    walletProvider,
    midnightProvider: walletProvider,
  } as unknown as DynamicProviders<Contract, ReproPrivateStateId>;
};

const readLedger = async (contractAddress: string, providers: DynamicProviders<Contract, ReproPrivateStateId>): Promise<Ledger> => {
  const contractState = await providers.publicDataProvider.queryContractState(contractAddress);
  if (contractState == null) throw new Error(`No contract state found for ${contractAddress}`);
  return CompiledEffectsCheckReproContract.ledger(contractState.data as ContractState["data"]);
};

const logStep = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
  console.log(`\n== ${name} ==`);
  try {
    const result = await run();
    console.log(`${name}: OK`);
    return result;
  } catch (error) {
    console.error(`${name}: FAILED`);
    console.error(error instanceof Error ? error.message : String(error));
    throw error;
  }
};

const run = async (): Promise<void> => {
  const env = envFromProcess();
  setNetworkId(env.networkId);
  const walletProvider = await ReproWalletProvider.build(env, process.env.WALLET_SEED ?? DEFAULT_WALLET_SEED);
  await walletProvider.start();
  try {
    await syncWallet(walletProvider.wallet);
    const providers = configureProviders(env, walletProvider);
    const api = await logStep("deploy", () =>
      DynamicContractAPI.deploy<Contract, ReproPrivateStateId>({
        providers,
        compiledContract: compiledEffectsCheckReproContract,
        logger: logger as never,
      }),
    ) as Awaited<ReturnType<typeof DynamicContractAPI.deploy<Contract, ReproPrivateStateId>>>;
    console.log(`contractAddress=${api.deployedContractAddress}`);

    await logStep("setupPool", () => api.deployedContract.callTx.setupPool(NATIVE_COIN_COLOR));
    await syncWallet(walletProvider.wallet);
    await logStep("depositLiquidity", () => api.deployedContract.callTx.depositLiquidity(shieldedCoin("20")));
    await syncWallet(walletProvider.wallet);
    await logStep("claimLpTokens", () => api.deployedContract.callTx.claimLpTokens(NATIVE_COIN_COLOR, 20_000_000n));
    await syncWallet(walletProvider.wallet);

    const afterClaim = await readLedger(api.deployedContractAddress, providers);
    console.log(`nativeColor=${toHex(NATIVE_COIN_COLOR)}`);
    console.log(`fTokenColor=${toHex(afterClaim.fTokenColor)}`);

    await logStep("borrowRepro", () =>
      api.deployedContract.callTx.borrowRepro(NATIVE_COIN_COLOR, shieldedCoin("4"), 3_000_000n),
    );
    await syncWallet(walletProvider.wallet);
    await logStep("withdrawRepro", () =>
      api.deployedContract.callTx.withdrawRepro(shieldedCoin("10", afterClaim.fTokenColor), NATIVE_COIN_COLOR),
    );
    await syncWallet(walletProvider.wallet);
    console.log("\nRepro flow completed without node rejection.");
  } finally {
    await walletProvider.stop().catch((error) => console.warn("Failed to stop wallet", error));
  }
};

run().catch((error) => {
  console.error("\nRepro CLI failed.");
  console.error(error);
  process.exitCode = 1;
});
