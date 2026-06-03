#!/usr/bin/env bash
# Exact local CLI setup used to reproduce the Custom 186 on postCollateral.
#
# Stack: a local Midnight stack on these ports (any way you boot it is fine):
#   node            ws://127.0.0.1:9944        (midnight-node 0.22.3)
#   indexer         http://127.0.0.1:8088      (indexer-standalone 4.0.1, v4 API)
#   proof-server    http://127.0.0.1:6300      (8.0.3 reproduces; 8.1.0 also does)
# Wallet: genesis seed 0x01, which holds shielded NIGHT + dust on a local node.
#
# Important: package.json `build` does NOT recompile the contract. After pulling
# a contract change you must run the compile step yourself, or src/managed stays
# stale and you end up running the old circuits.
set -euo pipefail

# 1. deps (the committed 8.0.3 set reproduces it)
npm install

# 2. recompile the contract (full ZK, needed for the prover keys)
compact compile +0.31.0 src/repro.compact ./src/managed/repro

# 3. build the TS
npm run build

# 4. run against the local stack
export NETWORK_ID=undeployed
export INDEXER_URL=http://127.0.0.1:8088/api/v4/graphql
export INDEXER_WS_URL=ws://127.0.0.1:8088/api/v4/graphql/ws
export NODE_WS_URL=ws://127.0.0.1:9944
export PROOF_SERVER_URL=http://127.0.0.1:6300
export WALLET_SEED=0000000000000000000000000000000000000000000000000000000000000001

node --experimental-specifier-resolution=node dist/cli.js

# Expected: deploy, setupPool, depositLiquidity, claimLpTokens (mintTokens) all
# pass, then postCollateral fails at node submission with
#   1010: Invalid Transaction: Custom error: 186
# Proof generation and balancing succeed first; the node rejects.
#
# To see that the mint is the trigger: comment out the claimLpTokens step in
# src/cli.ts and re-run. postCollateral and drawLoan then pass.
