// engine/sim — the time engine (doc-4 §3b): a pure, seeded, domain-agnostic discrete-event
// queueing-network simulator plus the closed-form analytic checks it is validated against.
export * from './rng';
export * from './distribution';
export * from './network';
export * from './profile';
export * from './analytic';
export * from './transient';
export { simulate, RESPONSE_RESERVOIR_CAP, type SimOptions, type SimResult, type StationStats, type NodeResponse, type PairLag } from './des';
