import { CompiledContract } from "@midnight-ntwrk/compact-js";
import { Contract } from "./managed/repro/contract/index.js";

export const compiledEffectsCheckReproContract = CompiledContract.make(
  "effects-check-repro",
  Contract
).pipe(CompiledContract.withCompiledFileAssets("./managed/repro"));

export * as CompiledEffectsCheckReproContract from "./managed/repro/contract/index.js";
