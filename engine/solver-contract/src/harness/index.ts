// The ORACLE HARNESS barrel (@sda/solver-contract/harness) — phase 1, docs/design/solver-contract.html
// §4. The generated differential suite an AI later implements our own solver against: a seeded random-design
// GENERATOR, an incumbent-certified ORACLE, and the `oracleHarnessOf` RUNNER (the describe-block a candidate's
// test file invokes). Kept a SEPARATE entry from the core barrel (src/index.ts) exactly as ./conformance is —
// the runner imports vitest (a describe/it factory), so it belongs with the testing surface, not the runtime
// contract. Values then `type`-prefixed types, the engine/solve barrel convention.

export { oracleHarnessOf, declinesHonestlyOf, type OracleHarnessOptions, type DeclinesHonestlyOptions } from './harness';
export {
  generateCorpus,
  generateDeclinedCorpus,
  generateNumeric,
  generateObjectiveTie,
  generateDeclined,
  generateEnumerate,
  rngOf,
  generatedRegistry,
  THROUGHPUT,
  COST,
  type CorpusOptions,
  type GeneratedInstance,
  type NumericInstance,
  type EnumerateInstance,
  type Topology,
  type Capability,
  type Regime,
  type NumericAxis,
  type Rng,
} from './generator';
export {
  answer,
  answerNumeric,
  answerEnumerate,
  type OracleAnswer,
  type NumericOracleAnswer,
  type EnumerateOracleAnswer,
} from './oracle';
