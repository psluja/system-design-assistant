// @algorithm Closed-form queueing formulas (M/M/1, M/M/c via Erlang-B/C, M/G/1 P-K, Little)
// @problem Give mean utilization/queue/wait/sojourn for a single station in closed form — the oracle
//   the discrete-event simulator is validated against, and the cheap estimate when simulation is
//   overkill.
// @approach Textbook steady-state results: M/M/1 algebra; M/M/c through the numerically stable
//   Erlang-B recursion B(k) = aB(k-1)/(k + aB(k-1)) lifted to the Erlang-C wait probability (no
//   factorials, no overflow); Pollaczek-Khinchine mean wait for M/G/1 parameterized by the service
//   SCV; Little's law as the L = lambda*W bridge.
// @complexity O(c) for M/M/c (the Erlang-B recursion over c servers); O(1) for the rest.
// @citations Erlang 1917 (B/C); Pollaczek 1930 / Khinchine 1932; Little 1961; stable Erlang-B
//   recursion as in Cooper, "Introduction to Queueing Theory" (2nd ed., 1981).
// @invariants Instability (rho >= 1) answers Infinity honestly, never a throw; c = 1 reduces exactly
//   to M/M/1; SCV = 1 recovers M/M/1, SCV = 0 gives M/D/1.
// @where-tested engine/sim/src/des.test.ts (DES vs closed forms), engine/sim/src/response.test.ts

/**
 * Closed-form queueing results — pure mathematics, the continuous (analytic) half of the time engine
 *. They are the oracle the discrete-event simulator is validated against and a
 * cheap mean-based estimate when a full simulation is overkill (label such estimates `approx`).
 */

/** Mean-based M/M/1 metrics. Unstable (ρ ≥ 1) ⇒ Infinity, honestly — never a throw. */
export interface MM1Metrics {
  readonly rho: number; // utilization λ/μ
  readonly L: number; // mean number in system
  readonly Lq: number; // mean number waiting in queue
  readonly W: number; // mean sojourn (time in system)
  readonly Wq: number; // mean wait in queue
}

export function mm1(arrivalRate: number, serviceRate: number): MM1Metrics {
  const rho = arrivalRate / serviceRate;
  if (!(rho < 1)) return { rho, L: Infinity, Lq: Infinity, W: Infinity, Wq: Infinity };
  return {
    rho,
    L: rho / (1 - rho),
    Lq: (rho * rho) / (1 - rho),
    W: 1 / (serviceRate - arrivalRate),
    Wq: rho / (serviceRate - arrivalRate),
  };
}

/**
 * Mean-based M/M/c metrics (c parallel servers, one shared FIFO queue) — the multi-server generalisation
 * of {@link mm1}, and the closed form the simulator's `servers > 1` stations are checked against. A station
 * with `concurrency` servers each of rate μ has capacity cμ; ρ = λ/(cμ). Uses the numerically stable
 * Erlang-B recursion (no factorials/overflow even for large c) to get the Erlang-C wait probability.
 * Unstable (ρ ≥ 1) ⇒ Infinity, honestly. c = 1 reduces exactly to M/M/1.
 */
export function mmc(arrivalRate: number, serviceRate: number, servers: number): MM1Metrics {
  const c = Math.max(1, Math.floor(servers));
  const a = arrivalRate / serviceRate; // offered load in Erlangs
  const rho = a / c;
  if (!(rho < 1)) return { rho, L: Infinity, Lq: Infinity, W: Infinity, Wq: Infinity };
  // Erlang-B blocking probability B(c,a) via the stable recursion B(0)=1, B(k)=aB(k-1)/(k+aB(k-1)).
  let b = 1;
  for (let k = 1; k <= c; k++) b = (a * b) / (k + a * b);
  // Erlang-C wait probability C = cB / (c − a(1−B)); then the standard M/M/c waiting/sojourn times.
  const pWait = (c * b) / (c - a * (1 - b));
  const Wq = pWait / (c * serviceRate - arrivalRate);
  const W = Wq + 1 / serviceRate;
  return { rho, L: arrivalRate * W, Lq: arrivalRate * Wq, W, Wq };
}

/**
 * Pollaczek–Khinchine mean queue wait for M/G/1, parameterised by the service distribution's squared
 * coefficient of variation `serviceScv` (Var/mean²). SCV=1 recovers M/M/1; SCV=0 gives M/D/1. This is
 * how the simulator is checked against NON-exponential service.
 */
export function mg1MeanWait(arrivalRate: number, serviceMean: number, serviceScv: number): number {
  const rho = arrivalRate * serviceMean;
  if (!(rho < 1)) return Infinity;
  return (rho * serviceMean * (1 + serviceScv)) / (2 * (1 - rho));
}

/** Little's law: mean number in system = arrival rate × mean sojourn. */
export function little(arrivalRate: number, meanSojourn: number): number {
  return arrivalRate * meanSojourn;
}
