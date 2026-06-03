import { Buffer } from "node:buffer";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rawTokenType, toHex, type ContractState } from "@midnight-ntwrk/compact-runtime";
import {
  createShieldedCoinInfo,
  communicationCommitmentRandomness,
  ContractCallPrototype,
  ContractState as LedgerContractState,
  decodeRawTokenType,
  encodeRawTokenType,
  encodeShieldedCoinInfo,
  Intent,
  nativeToken,
  Transaction,
  DustSecretKey,
  LedgerParameters,
  ZswapOffer,
  ZswapOutput,
  ZswapSecretKeys,
  type CoinPublicKey,
  type EncPublicKey,
  type FinalizedTransaction,
  type ShieldedCoinInfo as LedgerShieldedCoinInfo,
} from "@midnight-ntwrk/ledger-v8";
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { levelPrivateStateProvider } from "@midnight-ntwrk/midnight-js-level-private-state-provider";
import { NodeZkConfigProvider } from "@midnight-ntwrk/midnight-js-node-zk-config-provider";
import { httpClientProofProvider } from "@midnight-ntwrk/midnight-js-http-client-proof-provider";
import { getNetworkId, setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { SucceedEntirely, type MidnightProvider, type UnboundTransaction, type WalletProvider } from "@midnight-ntwrk/midnight-js-types";
import { ttlOneHour } from "@midnight-ntwrk/midnight-js-utils";
import { createUnprovenCallTx, submitTx } from "@midnight-ntwrk/midnight-js-contracts";
import { Contract as CompactContract } from "@midnight-ntwrk/compact-js";
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
import * as dotenv from "dotenv";

dotenv.config();

type ReproPrivateStateId = "repro_ps";

type WalletCache = {
  savedAt: string;
  shielded: string;
  unshielded: string;
  dust: string;
};

const walletCachePath = (network: string): string =>
  path.join(WALLET_CACHE_DIR, `cli-wallet-state-${network}.json`);

const loadWalletCache = async (network: string): Promise<WalletCache | null> => {
  try {
    const data = await fs.readFile(walletCachePath(network), "utf-8");
    return JSON.parse(data) as WalletCache;
  } catch {
    return null;
  }
};

const saveWalletCache = async (wallet: WalletFacade, network: string): Promise<void> => {
  const [shielded, unshielded, dust] = await Promise.all([
    wallet.shielded.serializeState(),
    wallet.unshielded.serializeState(),
    wallet.dust.serializeState(),
  ]);
  await fs.mkdir(WALLET_CACHE_DIR, { recursive: true });
  await fs.writeFile(
    walletCachePath(network),
    JSON.stringify({ savedAt: new Date().toISOString(), shielded, unshielded, dust } satisfies WalletCache, null, 2),
  );
};

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
const WALLET_CACHE_DIR = path.resolve(repoRoot, ".wallet-cache");
const NATIVE_COIN_COLOR = encodeRawTokenType(nativeToken().raw);
const SCALE_FACTOR = 1_000_000n;
const DEFAULT_WALLET_SEED = "823ab960ab282a7163c1183ef2bb99fbecb250707a06665fda35d2e7e1a11fcc";

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

const pad = (value: string, length: number): Uint8Array => {
  const encoded = new TextEncoder().encode(value);
  const result = new Uint8Array(length);
  result.set(encoded.subarray(0, length));
  return result;
};

const getTokenMintContractAddress = (): string => {
  const tokenMintContractAddress = process.env.TOKEN_MINT_CONTRACT_ADDRESS?.trim();
  if (!tokenMintContractAddress) {
    throw new Error("TOKEN_MINT_CONTRACT_ADDRESS is required on preview to derive the shielded token color.");
  }
  return tokenMintContractAddress.slice(0, 64);
};

const coinColorFromTokenMintAddress = (contractAddress: string): Uint8Array => {
  const color = encodeRawTokenType(
    rawTokenType(
      pad("ftlending:token-mint", 32),
      contractAddress.slice(0, 64),
    ),
  );
  console.log(`Shielded Coin Color Reconstructed ${toHex(color)}`);
  return color;
};

const getDefaultPoolCoinColor = (env: EnvironmentConfiguration): Uint8Array =>
  env.networkId === "preview"
    ? coinColorFromTokenMintAddress(getTokenMintContractAddress())
    : NATIVE_COIN_COLOR;

const envFromProcess = (): EnvironmentConfiguration => {
  const network = (process.env.NETWORK_ID ?? "undeployed") as "undeployed" | "preview";
  if (network === "preview") {
    return {
      walletNetworkId: "preview",
      networkId: "preview",
      indexer: "https://indexer.preview.midnight.network/api/v4/graphql",
      indexerWS: "wss://indexer.preview.midnight.network/api/v4/graphql/ws",
      nodeWS: "wss://rpc.preview.midnight.network",
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
    readonly unshieldedKeystore: ReturnType<typeof createKeystore>,
  ) {}

  static async build(env: EnvironmentConfiguration, seed = DEFAULT_WALLET_SEED, cache?: WalletCache): Promise<ReproWalletProvider> {
    const shieldedSeed = deriveKeyForRole(seed, Roles.Zswap);
    const unshieldedSeed = deriveKeyForRole(seed, Roles.NightExternal);
    const dustSeed = deriveKeyForRole(seed, Roles.Dust);
    const keystore = createKeystore(unshieldedSeed, env.walletNetworkId);
    const config = walletConfig(env);
    const shielded = cache
      ? ShieldedWallet(config as any).restore(cache.shielded)
      : ShieldedWallet(config as any).startWithSeed(shieldedSeed);
    const unshielded = cache
      ? UnshieldedWallet(config as any).restore(cache.unshielded)
      : UnshieldedWallet(config as any).startWithPublicKey(PublicKey.fromKeyStore(keystore));
    const dust = cache
      ? DustWallet(config as any).restore(cache.dust)
      : DustWallet(config as any).startWithSeed(dustSeed, LedgerParameters.initialParameters().dust);
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

  async balanceTx(tx: UnboundTransaction, ttl: Date = ttlOneHour()): Promise<any> {
    const recipe = await this.wallet.balanceUnboundTransaction(
      tx,
      { shieldedSecretKeys: this.zswapSecretKeys as any, dustSecretKey: this.dustSecretKey as any },
      { ttl },
    );
    const signedRecipe = await this.wallet.signRecipe(recipe, (payload: Uint8Array) => this.unshieldedKeystore.signData(payload));
    return this.wallet.finalizeRecipe(signedRecipe);
  }

  submitTx(tx: any): Promise<string> {
    return this.wallet.submitTransaction(tx);
  }

  start(): Promise<void> {
    return this.wallet.start(this.zswapSecretKeys as any, this.dustSecretKey as any);
  }

  stop(): Promise<void> {
    return this.wallet.stop();
  }
}

const isProgressStrictlyComplete = (progress: unknown): boolean =>
  typeof (progress as { isStrictlyComplete?: unknown })?.isStrictlyComplete === "function" &&
  ((progress as { isStrictlyComplete: () => boolean }).isStrictlyComplete());

const WALLET_SYNC_TIMEOUT_MS = Number(process.env.WALLET_SYNC_TIMEOUT_MS ?? "120000");

const syncWallet = async (wallet: WalletFacade): Promise<void> => {
  await Rx.firstValueFrom(
    wallet.state().pipe(
      Rx.filter(
        (state: any) =>
          state.shielded.state.progress.isConnected &&
          state.unshielded.progress.isConnected &&
          state.dust.state.progress.isConnected &&
          isProgressStrictlyComplete(state.shielded.state.progress) &&
          isProgressStrictlyComplete(state.unshielded.progress) &&
          isProgressStrictlyComplete(state.dust.state.progress),
      ),
      Rx.take(1),
      Rx.timeout({
        first: WALLET_SYNC_TIMEOUT_MS,
        with: () => {
          throw new Error(`Wallet sync timed out after ${WALLET_SYNC_TIMEOUT_MS}ms`);
        },
      }),
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

const isNetworkError = (error: unknown): boolean => {
  const msg = String(error);
  if (msg.includes("Invalid Transaction") || msg.includes("Custom error")) return false;
  return (
    msg.includes("disconnected") ||
    msg.includes("ServerError") ||
    msg.includes("Wallet.Other")
  );
};

const selectPoolCoinColor = (
  env: EnvironmentConfiguration,
  walletState: any,
  needed: bigint,
): { coinColor: Uint8Array; balance: bigint; label: string } => {
  const shieldedBalances = walletState.shielded.balances as Record<string, bigint>;
  const coinColor = getDefaultPoolCoinColor(env);
  const coinColorHex = toHex(coinColor);
  return {
    coinColor,
    balance: shieldedBalances[coinColorHex] ?? 0n,
    label: env.networkId === "preview" ? `token mint ${getTokenMintContractAddress()}` : `native ${coinColorHex}`,
  };
};

const ensureShieldedBalance = async (
  wallet: WalletFacade,
  coinColor: Uint8Array,
  needed: bigint,
): Promise<void> => {
  await syncWallet(wallet);

  const coinColorHex = toHex(coinColor);
  const stateBefore = await Rx.firstValueFrom(wallet.state());
  const shielded = (stateBefore.shielded.balances as Record<string, bigint>)[coinColorHex] ?? 0n;
  if (shielded >= needed) return;
  throw new Error(`Need ${needed / SCALE_FACTOR} shielded units of ${coinColorHex} but only have ${shielded / SCALE_FACTOR}`);
};

const retryStep = async <T>(
  wallet: WalletFacade,
  name: string,
  fn: () => Promise<T>,
  maxAttempts = 3,
): Promise<T> => {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await logStep(name, fn);
    } catch (error) {
      if (attempt >= maxAttempts || !isNetworkError(error)) throw error;
      const delaySec = attempt * 3;
      console.warn(`Network error on "${name}", resyncing and retrying in ${delaySec}s (attempt ${attempt}/${maxAttempts})...`);
      await new Promise<void>((r) => setTimeout(r, delaySec * 1000));
      await syncWallet(wallet);
    }
  }
  throw new Error("unreachable");
};

const zswapOutputsToFallibleOffer = (
  outputs: Array<{
    coinInfo: LedgerShieldedCoinInfo;
    recipient: { is_left: boolean; left: string; right: string };
  }>,
  walletEncryptionPublicKey: string,
) => {
  const offers = outputs.map((output) => {
    const zswapOutput = output.recipient.is_left
      ? ZswapOutput.new(output.coinInfo, 0, output.recipient.left, walletEncryptionPublicKey)
      : ZswapOutput.newContractOwned(output.coinInfo, 0, output.recipient.right);
    return ZswapOffer.fromOutput(zswapOutput);
  });

  if (offers.length === 0) return undefined;
  return offers.reduce((acc, offer) => acc.merge(offer));
};

const submitFallibleShieldedMintCall = async (
  api: Awaited<ReturnType<typeof DynamicContractAPI.deploy<Contract, ReproPrivateStateId>>>,
  circuitId: CompactContract.ProvableCircuitId<Contract>,
  args: CompactContract.CircuitParameters<Contract, typeof circuitId>,
) => {
  const contractAddress = api.deployedContractAddress;
  const currentState = await api.providers.publicDataProvider.queryContractState(contractAddress);
  if (currentState == null) throw new Error(`Unable to read contract state for ${contractAddress}.`);

  api.providers.privateStateProvider.setContractAddress(contractAddress);
  const privateState = await api.providers.privateStateProvider.get("repro_ps");
  if (privateState == null) {
    await api.providers.privateStateProvider.set("repro_ps", {} as never);
  }

  const callData = await createUnprovenCallTx(api.providers, {
    compiledContract: compiledEffectsCheckReproContract,
    contractAddress,
    circuitId,
    privateStateId: "repro_ps",
    args,
  } as never);

  const fallibleTranscript = callData.public.partitionedTranscript[1];
  if (fallibleTranscript == null) throw new Error(`${String(circuitId)} did not produce a fallible transcript.`);

  const fallibleOffer = zswapOutputsToFallibleOffer(
    callData.private.nextZswapLocalState.outputs as never,
    api.providers.walletProvider.getEncryptionPublicKey(),
  );

  const operation = LedgerContractState.deserialize(currentState.serialize()).operation(circuitId);
  if (operation == null) throw new Error(`Missing operation for circuit ${String(circuitId)}.`);

  const intent = Intent.new(ttlOneHour()).addCall(
    new ContractCallPrototype(
      contractAddress,
      circuitId,
      operation,
      callData.public.partitionedTranscript[0],
      fallibleTranscript,
      callData.private.privateTranscriptOutputs,
      callData.private.input,
      callData.private.output,
      communicationCommitmentRandomness(),
      circuitId,
    ),
  );
  const unprovenTx = Transaction.fromPartsRandomized(getNetworkId(), undefined, fallibleOffer, intent);
  const finalized = await submitTx(api.providers, { unprovenTx, circuitId });
  if (finalized.status !== SucceedEntirely) {
    throw new Error(`${String(circuitId)} transaction failed with status ${finalized.status}.`);
  }

  await api.providers.privateStateProvider.set(
    "repro_ps",
    callData.private.nextPrivateState as never,
  );

  return {
    private: callData.private,
    public: {
      ...callData.public,
      ...finalized,
    },
  };
};

const run = async (): Promise<void> => {
  const env = envFromProcess();
  setNetworkId(env.networkId);
  const cache = await loadWalletCache(env.networkId);
  if (cache) console.log(`Restoring wallet from cache (saved ${cache.savedAt})`);
  const walletProvider = await ReproWalletProvider.build(env, process.env.WALLET_SEED ?? DEFAULT_WALLET_SEED, cache ?? undefined);
  await walletProvider.start();
  try {
    await syncWallet(walletProvider.wallet);
    await saveWalletCache(walletProvider.wallet, env.networkId);

    const walletState = await Rx.firstValueFrom(walletProvider.wallet.state());
    const shieldedNative = (walletState.shielded.balances as Record<string, bigint>)[toHex(NATIVE_COIN_COLOR)] ?? 0n;
    const unshieldedNative = (walletState.unshielded.balances as Record<string, bigint>)[toHex(NATIVE_COIN_COLOR)] ?? 0n;
    const dustBalance = walletState.dust.balance(new Date());
    console.log(`Wallet balances — shielded: ${shieldedNative / SCALE_FACTOR} tMAINE  unshielded: ${unshieldedNative / SCALE_FACTOR} tMAINE  dust: ${dustBalance}`);

    const neededShieldedBalance = 50n * SCALE_FACTOR;
    const selectedPoolCoin = selectPoolCoinColor(env, walletState, neededShieldedBalance);
    console.log(`poolCoinColor=${toHex(selectedPoolCoin.coinColor)} (${selectedPoolCoin.label}, shielded balance: ${selectedPoolCoin.balance / SCALE_FACTOR})`);

    await retryStep(walletProvider.wallet, "checkShieldedFunds", () =>
      ensureShieldedBalance(walletProvider.wallet, selectedPoolCoin.coinColor, neededShieldedBalance),
    );
    await saveWalletCache(walletProvider.wallet, env.networkId);

    const providers = configureProviders(env, walletProvider);
    const api = await retryStep(walletProvider.wallet, "deploy", () =>
      DynamicContractAPI.deploy<Contract, ReproPrivateStateId>({
        providers,
        compiledContract: compiledEffectsCheckReproContract as any,
        logger: logger as never,
      }),
    ) as Awaited<ReturnType<typeof DynamicContractAPI.deploy<Contract, ReproPrivateStateId>>>;
    console.log(`contractAddress=${api.deployedContractAddress}`);

    await logStep("setupPool", () => api.deployedContract.callTx.setupPool(selectedPoolCoin.coinColor));
    await syncWallet(walletProvider.wallet);
    await logStep("depositLiquidity", () => api.deployedContract.callTx.depositLiquidity(shieldedCoin("20", selectedPoolCoin.coinColor)));
    await syncWallet(walletProvider.wallet);
    await logStep("claimLpTokens", () =>
      submitFallibleShieldedMintCall(api, "mintTokens", [selectedPoolCoin.coinColor, 20_000_000n] as never),
    );
    await syncWallet(walletProvider.wallet);

    const afterClaim = await readLedger(api.deployedContractAddress, providers);
    console.log(`underlyingColor=${toHex(selectedPoolCoin.coinColor)}`);
    console.log(`tokenColor=${toHex(afterClaim.tokenColor)}`);

    await logStep("postCollateral", () =>
      api.deployedContract.callTx.postCollateral(selectedPoolCoin.coinColor, shieldedCoin("4", selectedPoolCoin.coinColor), 3_000_000n),
    );
    await syncWallet(walletProvider.wallet);
    await logStep("drawLoan", () =>
      api.deployedContract.callTx.drawLoan(selectedPoolCoin.coinColor),
    );
    await syncWallet(walletProvider.wallet);
    const afterBorrow = await readLedger(api.deployedContractAddress, providers);
    const borrowEntry = [...afterBorrow.borrowedBalances][0];
    if (!borrowEntry) throw new Error("No borrow position found after borrowRepro");
    const [positionKey] = borrowEntry;
    console.log(`positionKey=${toHex(positionKey)}`);

    await logStep("repayLoan", () =>
      api.deployedContract.callTx.repayLoan(positionKey, selectedPoolCoin.coinColor, shieldedCoin("3", selectedPoolCoin.coinColor)),
    );
    await syncWallet(walletProvider.wallet);
    await logStep("seizeCollateral", () =>
      api.deployedContract.callTx.seizeCollateral(positionKey, selectedPoolCoin.coinColor),
    );
    await syncWallet(walletProvider.wallet);
    await logStep("initiateWithdrawal", () =>
      api.deployedContract.callTx.initiateWithdrawal(shieldedCoin("10", afterClaim.tokenColor), selectedPoolCoin.coinColor),
    );
    await syncWallet(walletProvider.wallet);
    await logStep("completeWithdrawal", () =>
      api.deployedContract.callTx.completeWithdrawal(selectedPoolCoin.coinColor),
    );
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
