# Effects Check Repro Contract

Minimal Midnight Compact repro for node-side `MalformedTransaction::EffectsCheckFailure` / custom error `186`.

This repo now captures several attempted fixes and narrowed hypotheses around shielded pooled-liquidity flows:

- splitting receive/send circuits into two transactions;
- using a fallible wrapper for shielded token minting;
- storing liquidity and collateral in separate TVL maps;
- testing multiple `ledger-v8` versions;
- isolating a likely mint-triggered stale contract-owned coin issue.

## Current Status

The original failing shape was a single transaction that both received a shielded coin and sent a contract-owned shielded coin from `protocolTVL`.

The first attempted fix split those circuits into two transactions:

| Original single circuit | Tx 1 | Tx 2 |
|---|---|---|
| `borrowRepro` | `postCollateral` | `drawLoan` |
| `liquidationRepro` | `repayLoan` | `seizeCollateral` |
| `withdrawRepro` | `initiateWithdrawal` | `completeWithdrawal` |

That split removes `receiveShielded` and contract-owned `sendShielded` from the same circuit. It does not fully resolve the repro in every tested flow. The newer evidence points at `mintTokens` as a trigger: after minting, a later `postCollateral` can fail with custom `186` even though proof generation and transaction balancing complete.

## Important Commit References

The pre-split single-transaction circuits are visible at:

```sh
git show e96bcdd:src/repro.compact
```

That version contains:

- `borrowRepro`
- `liquidationRepro`
- `withdrawRepro`

The two-transaction split was introduced in:

```sh
git show 393ebba
```

## Contract Structure

The contract isolates shielded coin behavior from a lending protocol. It stores pooled liquidity in:

```compact
export ledger protocolTVL: Map<Bytes<32>, QualifiedShieldedCoinInfo>;
```

The main effects patterns are:

- `receiveShielded` into contract TVL;
- `mergeCoinImmediate` with a contract-owned coin from `protocolTVL`;
- `insertCoin` into `protocolTVL`;
- `sendShielded` from a contract-owned coin;
- `sendImmediateShielded` to burn a just-received LP token;
- `mintShieldedToken` to mint an LP token to the caller;
- `HistoricMerkleTree` supply commitment updates.

## Circuits In Current Head

- `setupPool(coinColor)` stores the underlying token color and derives the LP token color.
- `depositLiquidity(principalCoin)` receives underlying coin into `protocolTVL`.
- `mintTokens(coinColor, claimAmount)` mints a shielded LP token and records supply state.
- `postCollateral(loanCoinType, collateralCoin, amountToBorrow)` receives collateral and writes `pendingBorrows`.
- `drawLoan(loanCoinType)` sends loan tokens from `protocolTVL` and clears `pendingBorrows`.
- `repayLoan(positionKey, loanCoinType, repaymentCoin)` receives repayment and writes `pendingLiquidations`.
- `seizeCollateral(positionKey, loanCoinType)` sends seized collateral and clears the borrow position.
- `initiateWithdrawal(lpTokenCoin, principalCoinType)` receives and burns LP tokens, updates supply state, and writes `pendingWithdrawals`.
- `completeWithdrawal(principalCoinType)` sends underlying principal and clears `pendingWithdrawals`.

## Fix Attempt 1: Split Receive And Send

The original theory was that the node rejected any transaction combining:

```text
receiveShielded + sendShielded(contract-owned coin)
```

The split circuits address that by using bridge maps:

- `pendingBorrows`
- `pendingWithdrawals`
- `pendingLiquidations`

For withdrawal, `receiveShielded + sendImmediateShielded` remains in `initiateWithdrawal`, because burning a just-received coin appears to be valid. Only the contract-owned `sendShielded` was moved into `completeWithdrawal`.

This fix changes atomicity. The original single borrow was all-or-nothing. The split flow leaves intermediate state between Tx 1 and Tx 2.

## Fix Attempt 2: Separate Liquidity And Collateral TVL

Another attempted fix was to split contract-owned coins by purpose instead of keeping everything in one `protocolTVL` map.

The tested shape used separate maps similar to:

```compact
liquidityTVL: Map<Bytes<32>, QualifiedShieldedCoinInfo>
collateralTVL: Map<Bytes<32>, QualifiedShieldedCoinInfo>
```

The goal was to rule out storage-shape or bookkeeping issues: liquidity deposits would live in `liquidityTVL`, while posted collateral would live in `collateralTVL`.

That did not resolve the custom `186` failure. This makes the issue look less like a map-layout problem and more like a shielded coin qualification/effects issue on stored contract-owned coins.

## Fix Attempt 3: Fallible Mint Wrapper

`mintTokens` does not work cleanly through the normal generated `callTx` path in this contract shape. The CLI uses a custom fallible wrapper for the mint call.

The reason is important: during mint, the normal wallet balancing path appears to expect the wallet to balance with the token that is about to be minted to it. That token does not exist yet. The fallible wrapper works around that by submitting the mint as a fallible shielded mint call.

This is why mint is still suspicious even when the minted token is eventually added to the wallet. The operation succeeds only through a special path, and later contract-owned coin operations can still fail. That suggests minting may be moving the zswap tree or effects state in a way that leaves a previously stored contract-owned coin unusable.

## Current Strongest Hypothesis: Mint Stales The Stored Pool Coin

A technical reviewer reproduced the failure against the split circuits and observed:

- `postCollateral` fails with custom `186` after `mintTokens`;
- proof generation and balancing pass;
- node submission rejects the transaction;
- the failure reproduces on `ledger-v8` `8.0.3` and `8.1.0`;
- if `mintTokens` is removed from the flow, `postCollateral` and later split steps pass;
- if `mintTokens` is replaced by a second `depositLiquidity`, `postCollateral` also passes.

The suspected mechanism:

1. `depositLiquidity` receives and inserts the pool coin into `protocolTVL`.
2. `mintTokens` adds a new coin to the zswap tree but does not touch the existing pool coin.
3. The stored `QualifiedShieldedCoinInfo` in `protocolTVL` keeps an old `mt_index`.
4. Later, `postCollateral` calls `mergeCoinImmediate(protocolTVL.lookup(color), collateral)`.
5. That merge uses a stale contract-owned coin, so the node effects check no longer matches the submitted transaction.
6. The node rejects with custom `186`.

This is not yet confirmed node-side. It is the explanation that best matches the observed variants.

An attempted refresh circuit that reinserted the existing pool coin did not solve it. `insertCoin` only accepts a coin received in the same transaction, so there is no obvious way for the contract to re-qualify an already-held coin. A second deposit works because it receives a fresh coin and re-inserts the pool state, but that is not a real protocol fix.

If this interpretation is correct, it affects pooled liquidity designs generally: lending pools, AMMs, and vaults all need to hold and later reuse contract-owned coins while the tree advances.

## Version Observations

Observed in the larger protocol code:

| `ledger-v8` version | Observation |
|---|---|
| `8.0.1` | `setupPool`, `depositLiquidity`, `mintTokens`, `borrow`, and `repay` worked in the actual code. |
| `8.0.3` | Custom `186` reproduced for the affected post-mint flows. |
| `8.1.0` | Custom `186` reproduced for the affected post-mint flows. |

Earlier investigation also found that client/node version skew can make even simple receive-only transactions fail. Keep `ledger-v8`, node, and proof server aligned with the target network before interpreting a `186` as a contract issue.

## Minimal Repro Sequences

### Mint-Triggered Failure

This is the most useful current repro:

1. `setupPool(nativeColor)`
2. `depositLiquidity(nativeShieldedCoin(20))`
3. `mintTokens(nativeColor, 20_000_000)` through the fallible wrapper
4. `postCollateral(nativeColor, nativeShieldedCoin(4), 3_000_000)`

Expected observed failure: `postCollateral` reaches node submission and fails with custom `186`.

### Control: Replace Mint With Second Deposit

This variant reportedly passes:

1. `setupPool(nativeColor)`
2. `depositLiquidity(nativeShieldedCoin(20))`
3. `depositLiquidity(nativeShieldedCoin(...))`
4. `postCollateral(nativeColor, nativeShieldedCoin(4), 3_000_000)`

This supports the stale pool coin hypothesis because the second deposit refreshes/reinserts the pool coin.

### Split Borrow Flow

1. `setupPool(nativeColor)`
2. `depositLiquidity(nativeShieldedCoin(20))`
3. `mintTokens(nativeColor, 20_000_000)`
4. `postCollateral(nativeColor, nativeShieldedCoin(4), 3_000_000)`
5. `drawLoan(nativeColor)`

The split removes same-transaction receive/send, but it does not avoid the post-mint `postCollateral` failure.

## Questions For Midnight

1. Is `mergeCoinImmediate` on a `Map.lookup` `QualifiedShieldedCoinInfo` expected to re-resolve `mt_index` at apply time?
2. Is `sendShielded` on a stored contract-owned coin expected to re-resolve `mt_index` at apply time?
3. If a contract-owned coin becomes stale whenever unrelated zswap events advance the tree, what is the intended pattern for pooled liquidity?
4. Is the need for a fallible wrapper around `mintShieldedToken` expected for this contract shape, or is it a bug in wallet balancing / generated call handling?
5. Can a contract re-qualify an already-held shielded coin without receiving a fresh coin in the same transaction?

## Local Build

Prerequisites:

- Node.js 22+
- Yarn 1.x
- Compact CLI on `PATH` as `compact`

```sh
yarn install
yarn compact-test
yarn build
```

Full ZK compile:

```sh
yarn compact
```

## Standalone CLI

The CLI deploys the contract and runs the split sequence:

```text
setupPool -> depositLiquidity -> mintTokens -> postCollateral -> drawLoan -> repayLoan -> seizeCollateral -> initiateWithdrawal -> completeWithdrawal
```

Run:

```sh
yarn test:standalone
```

Preview:

```sh
export NETWORK_ID=preview
export PROOF_SERVER_URL=http://127.0.0.1:6300
yarn test:standalone
```

Local devnet:

```sh
export NETWORK_ID=undeployed
export INDEXER_URL=http://127.0.0.1:8088/api/v4/graphql
export INDEXER_WS_URL=ws://127.0.0.1:8088/api/v4/graphql/ws
export NODE_WS_URL=ws://127.0.0.1:9944
export PROOF_SERVER_URL=http://127.0.0.1:6300
yarn test:standalone
```

Optional:

```sh
export WALLET_SEED=0000000000000000000000000000000000000000000000000000000000000001
export DEBUG_REPRO=1
export MIDNIGHT_UNDEPLOYED_FEE_OVERHEAD=500000000000000000
```

## Files

- `src/repro.compact` contains the Compact contract.
- `src/cli.ts` contains the standalone repro runner and fallible mint wrapper.
- `src/index.ts` wraps the compiled contract bindings.
- `src/managed/repro/` contains generated compiler output.
