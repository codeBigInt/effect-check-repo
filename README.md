# Effects Check Repro Contract

Minimal independent Midnight Compact repo for reporting node-side `MalformedTransaction::EffectsCheckFailure` / custom error `186`.

## Issue Summary

Transactions that combine `receiveShielded` + `sendShielded` (or `receiveShielded` + `sendImmediateShielded`) in the same circuit are rejected by the node with custom error `186` (`MalformedTransaction::EffectsCheckFailure`). Proof generation and transaction balancing complete without error — the rejection happens at node submission.

### Ledger version regression

| ledger-v8 version | Affected circuits |
|---|---|
| 8.0.1 | `borrowRepro`, `withdrawRepro`, `liquidationRepro` |
| 8.1.0 | **All circuits** — including `depositLiquidity` and `claimLpTokens`, which do not send shielded coins |

On `8.1.0` the failure is broader: even circuits that only call `receiveShielded` without any outgoing `sendShielded` are rejected. This means circuits that previously worked under `8.0.1` now fail under `8.1.0`.

To switch between versions change `@midnight-ntwrk/ledger-v8` in `package.json` and reinstall.

## Contract Structure

This contract isolates the shielded-coin effects patterns from a larger lending protocol. It uses a single `protocolTVL: Map<Bytes<32>, QualifiedShieldedCoinInfo>` to hold contract-owned shielded coins (liquidity and collateral).

The patterns exercised:

- `receiveShielded` — receive a user coin into the contract
- `mergeCoinImmediate` + `insertCoin` — merge received coin into existing contract TVL
- `sendShielded` — send from contract TVL to a user address (split change back into TVL)
- `receiveShielded` + `sendImmediateShielded(... shieldedBurnAddress())` — receive and burn an LP token
- `mintShieldedToken` — mint a shielded LP token to the caller
- `HistoricMerkleTree` `insertHash` / `insertHashIndex` — supply commitment tracking

## Circuits

- `setupPool(coinColor)` — stores the underlying token color and derives the LP token color.
- `depositLiquidity(principalCoin)` — receives underlying coin into `protocolTVL`.
- `claimLpTokens(coinColor, claimAmount)` — mints a shielded LP token and inserts a supply commitment into `supplyCommitments`.
- `borrowRepro(loanCoinType, collateralCoin, amountToBorrow)` — receives collateral into `protocolTVL`, records borrow and collateral state, then sends loan tokens from `protocolTVL` to the caller.
- `liquidationRepro(positionKey, loanCoinType)` — reads collateral amount for a position key, sends seized collateral from `protocolTVL` to the caller, and clears the position from `borrowedBalances` and `collateralBalances`.
- `withdrawRepro(lpTokenCoin, principalCoinType)` — receives and burns the LP token, rewrites the supply commitment with `insertHashIndex`, then sends underlying tokens from `protocolTVL` to the caller.

## Repro Sequences

Use native token color (`0x00...00`) for the shortest path. Expected result on all paths: proof generation and balancing succeed, node rejects with custom `186`.

**Supply path** (fails on both 8.0.1 and 8.1.0):

1. `setupPool(nativeColor)`
2. `depositLiquidity(nativeShieldedCoin(20))`
3. `claimLpTokens(nativeColor, 20_000_000)`

**Borrow path** (fails on both 8.0.1 and 8.1.0):

1. `setupPool(nativeColor)`
2. `depositLiquidity(nativeShieldedCoin(20))`
3. `claimLpTokens(nativeColor, 20_000_000)`
4. `borrowRepro(nativeColor, nativeShieldedCoin(4), 3_000_000)`

**Liquidation path** (fails on both 8.0.1 and 8.1.0):

1. `setupPool(nativeColor)`
2. `depositLiquidity(nativeShieldedCoin(20))`
3. `claimLpTokens(nativeColor, 20_000_000)`
4. `borrowRepro(nativeColor, nativeShieldedCoin(4), 3_000_000)`
5. Read `positionKey` from `borrowedBalances` ledger map
6. `liquidationRepro(positionKey, nativeColor)`

**Withdrawal path** (fails on both 8.0.1 and 8.1.0):

1. `setupPool(nativeColor)`
2. `depositLiquidity(nativeShieldedCoin(20))`
3. `claimLpTokens(nativeColor, 20_000_000)`
4. `withdrawRepro(lpShieldedCoin(10), nativeColor)`

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

Full ZK compile (required before running against a live network):

```sh
yarn compact
```

## Standalone CLI

The CLI deploys the contract and runs the full repro sequence:

`setupPool → depositLiquidity → claimLpTokens → borrowRepro → liquidationRepro → withdrawRepro`

Set environment variables for the target network, then:

```sh
yarn test:standalone
```

**Local devnet (undeployed):**

```sh
export NETWORK_ID=undeployed
export INDEXER_URL=http://127.0.0.1:8088/api/v4/graphql
export INDEXER_WS_URL=ws://127.0.0.1:8088/api/v4/graphql/ws
export NODE_WS_URL=ws://127.0.0.1:9944
export PROOF_SERVER_URL=http://127.0.0.1:6300
yarn test:standalone
```

**Preview network:**

```sh
export NETWORK_ID=preview
export PROOF_SERVER_URL=http://127.0.0.1:6300
yarn test:standalone
```

Optional environment variables:

```sh
export WALLET_SEED=0000000000000000000000000000000000000000000000000000000000000001
export DEBUG_REPRO=1
export MIDNIGHT_UNDEPLOYED_FEE_OVERHEAD=500000000000000000
```

## Files

- `src/repro.compact` — minimal Compact contract.
- `src/index.ts` — TypeScript wrapper for compiled contract bindings.
- `src/cli.ts` — standalone repro runner.
- `src/managed/repro/` — compiler output (regenerated by `yarn compact-test`).
