# Effects Check Repro Contract

Minimal independent Midnight Compact repo for reporting node-side `MalformedTransaction::EffectsCheckFailure` / custom `186`.

The contract isolates the shielded-coin effects pattern from the larger lending protocol while keeping the parts that matter for the failing borrow and withdrawal flows:

- contract-owned shielded balance stored in `protocolTVL: Map<Bytes<32>, QualifiedShieldedCoinInfo>`
- user shielded coin received with `receiveShielded`
- received coin merged into existing contract-owned TVL with `mergeCoinImmediate`
- contract-owned TVL rewritten with `insertCoin`
- outgoing liquidity sent from contract TVL with `sendShielded`
- LP withdrawal receives and burns a shielded LP token with `receiveShielded` + `sendImmediateShielded(... shieldedBurnAddress())`
- supply position commitment tracked with `HistoricMerkleTree<32, Bytes<32>>`, including `insertHash` on claim and `insertHashIndex` on withdrawal

## Files

- `src/repro.compact`: the full minimal Compact contract.
- `src/index.ts`: TypeScript wrapper for generated contract bindings.

## Circuits

- `setupPool(coinColor)`: stores the underlying token color and derives the LP token color.
- `depositLiquidity(principalCoin)`: receives underlying liquidity into `protocolTVL`.
- `claimLpTokens(coinColor, claimAmount)`: mints a shielded LP token and inserts a supply commitment into `supplyCommitments`.
- `borrowRepro(loanCoinType, collateralCoin, amountToBorrow)`: receives collateral into existing `protocolTVL`, records minimal borrow state, then sends loan tokens from `protocolTVL` to the caller.
- `withdrawRepro(lpTokenCoin, principalCoinType)`: receives and burns the LP token, rewrites the supply commitment with `insertHashIndex`, then sends underlying tokens from `protocolTVL` to the caller.

## Repro Sequences

Use native token color (`0x00...00`) for the shortest path.

Borrow path:

1. Deploy `src/repro.compact`.
2. Call `setupPool(nativeColor)`.
3. Call `depositLiquidity(nativeShieldedCoin(20))`.
4. Call `claimLpTokens(nativeColor, 20)`.
5. Call `borrowRepro(nativeColor, nativeShieldedCoin(4), 3)`.

Withdrawal path:

1. Deploy `src/repro.compact`.
2. Call `setupPool(nativeColor)`.
3. Call `depositLiquidity(nativeShieldedCoin(20))`.
4. Call `claimLpTokens(nativeColor, 20)`.
5. Call `withdrawRepro(lpShieldedCoin(10), nativeColor)`.

Expected if the issue reproduces: proof generation and transaction balancing complete, transaction submission reaches the node, then the node rejects with custom `186` / `MalformedTransaction::EffectsCheckFailure`.

## Local Build

This repo is intentionally standalone and is not a workspace package.

Prerequisites:

- Node.js 22+
- Yarn 1.x
- Compact CLI available on `PATH` as `compact`

```sh
yarn install
yarn compact-test
yarn build
```

If DNS resolution fails for `registry.yarnpkg.com`, this repo includes a local `.yarnrc` that points Yarn 1 to `https://registry.npmjs.org`. You can also retry with:

```sh
yarn install --network-timeout 600000
```

Full ZK compile:

```sh
yarn compact
```

## Standalone CLI

The CLI deploys the repro contract and runs:

`setupPool -> depositLiquidity -> claimLpTokens -> borrowRepro -> withdrawRepro`

Set environment variables for the target network, then run:

```sh
yarn test:standalone
```

For an undeployed local stack:

```sh
export NETWORK_ID=undeployed
export INDEXER_URL=http://127.0.0.1:8088/api/v4/graphql
export INDEXER_WS_URL=ws://127.0.0.1:8088/api/v4/graphql/ws
export NODE_WS_URL=ws://127.0.0.1:9944
export PROOF_SERVER_URL=http://127.0.0.1:6300
yarn test:standalone
```

For preview:

```sh
export NETWORK_ID=preview
export PROOF_SERVER_URL=http://127.0.0.1:6300
yarn test:standalone
```

Optional:

```sh
export WALLET_SEED=0000000000000000000000000000000000000000000000000000000000000001
export DEBUG_REPRO=1
```
