# Effects Check Repro Contract

Minimal Midnight Compact repro for node-side `MalformedTransaction::EffectsCheckFailure` / custom `186` around shielded receive/send patterns.

This package intentionally removes lending-specific accounting. It keeps only the pattern used by the larger lender contract:

- contract-owned shielded balance stored in `protocolTVL: Map<Bytes<32>, QualifiedShieldedCoinInfo>`
- receive user shielded coin into that map with `receiveShielded` + `mergeCoinImmediate` + `insertCoin`
- later send from the same map with `sendShielded`
- LP-token withdrawal burns a user shielded token with `receiveShielded` + `sendImmediateShielded(... shieldedBurnAddress())`, then sends liquidity back from `protocolTVL`

## Circuits

- `setupPool(coinColor)`: sets the underlying token and derived LP token color.
- `depositLiquidity(principalCoin)`: receives the underlying coin and stores it in `protocolTVL`.
- `claimLpTokens(coinColor, claimAmount)`: mints a shielded LP token to the caller.
- `borrowRepro(loanCoinType, collateralCoin, amountToBorrow)`: receives collateral into existing `protocolTVL`, records minimal borrow state, then sends loan tokens from `protocolTVL` to the caller.
- `withdrawRepro(lpTokenCoin, principalCoinType)`: receives and burns the LP token, updates minimal supply state, then sends underlying tokens from `protocolTVL` to the caller.

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

## Build

```sh
yarn workspace @ftlending/effects-check-repro-contract compact-test
yarn workspace @ftlending/effects-check-repro-contract build
```
# effect-check-repo
