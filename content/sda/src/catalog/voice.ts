import { keys as k } from '../vocabulary/registry';
import type { Manifest } from '../vocabulary/manifest';
import { availabilityByDeployment, lambdaAccountConcurrency, payloadLimit, payPerUseCost, unitCostConfig, withOrigin, withOverflow } from './behaviors';
import { clientOut, triggerIn } from '../vocabulary/port-roles';
import { dynamodbGuarantees } from '../vocabulary/guarantees';

// DynamoDB SLA: 99.99% single-Region, 99.999% with global tables (https://aws.amazon.com/dynamodb/sla/).
// DynamoDB is inherently Multi-AZ (no single-AZ mode), so modes 0/1 = single-Region; deploymentMode 2 = global.
const DYNAMODB_SLA_SOURCE = 'https://aws.amazon.com/dynamodb/sla/';
const DYNAMODB_AVAILABILITY = availabilityByDeployment(0.9999, 0.9999, 0.99999, DYNAMODB_SLA_SOURCE);

// DynamoDB DOCUMENTED item-size ceiling: 400 KB (409,600 bytes) max item — includes attribute names + values.
// https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/ServiceQuotas.html
// NOT covered honestly (recorded in): per-PARTITION throughput skew (3,000 RCU / 1,000 WCU per partition)
// — the manifest has no partition concept, so faking a per-partition ceiling would lie. Only table-level
// on-demand throughput (the `throughput` config) + this item-size limit are modelled.
const DYNAMODB_ITEM_LIMIT = payloadLimit(409_600, 'https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/ServiceQuotas.html');

/**
 * A REAL case: components reverse-engineered from the "VoiceStack" CDK app
 * (C:\git\Architectureasaservice2 · templates/lib/constructs/voice) — a Slack-launched, real-time
 * voice training simulator: browser (push-to-talk) → CloudFront → a streaming Lambda that runs one
 * conversation turn = Transcribe (STT) → Bedrock Claude (LLM) → Polly generative (TTS), with session
 * state in DynamoDB.
 *
 * SOURCING (the tool must not lie):
 *  - CONFIG values are taken from the CDK: Lambda reservedConcurrentExecutions 10 + memory 1024 MB +
 *    timeout 60 s; DynamoDB PAY_PER_REQUEST (on-demand); API GW throttle 20 rps (the buffered
 *    fallback path; the primary /stream path is a Lambda Function URL through CloudFront).
 *  - Bedrock latency 1500 ms is the team's MEASURED phase-0 figure for Claude Sonnet (their note;
 *    the deployed default is Haiku 4.5, which they chose precisely for lower llmMs).
 *  - Per-service latencies marked `est.` are AWS-typical estimates — runtime behaviour, not in the
 *    CDK. Cost is modelled as pay-per-use (inflow throughput × a base unitCost), so it is ~0 at rest
 *    and rises with offered load ("koszt w spoczynku ~0").
 */
export const voiceManifests: Readonly<Record<string, Manifest>> = withOverflow(withOrigin({
  'client.browser': {
    type: 'client.browser',
    ports: [{ name: 'out', dir: 'out', speaks: ['https'] }],
    config: [
      { key: k.throughput, value: 8, unit: 'req/s', est: true }, // 8-agent office, ~1 turn/s each (their sizing note — a real workload assumption, not a public vendor figure)
      { key: k.latency, value: 0, unit: 'ms' }, // neutral: a client adds no hop latency of its own
      { key: k.availability, value: 1, unit: 'ratio' }, // neutral: an abstract client is always "up"
    ],
  },

  // A CDN's DEFINING job is to absorb traffic at the edge: the origin sees only the CACHE MISSES, not 100% of
  // client requests. Relaying 1:1 toward the origin would be a SYSTEMATIC lie (the origin tier would be sized for
  // the full client rate — the opposite of why a CDN exists). So the OUT port (toward origin) carries an
  // `est.`-marked default ratio(0.1) ≈ a 90% cache-hit rate: a credible TYPICAL figure for mostly-static content
  // (industry/AWS put static hit rates at ~85–95%; AWS recommends aiming for 80%+ and 90%+ for cost). This is an
  // ESTIMATE, not a claim of truth — the REAL hit rate is workload- and cache-key-dependent, so the architect
  // overrides it per instance/per wire (the R2 edge pills show it with provenance 'manifest', one-click editable;
  // set ratio(1) for an all-dynamic / non-cacheable distribution such as a streaming Function URL).
  // Source: https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cache-hit-ratio.html
  //
  // PRICING IDENTITY: managed AWS CloudFront, priced at the on-demand LIST rate (an `est.`, not a committed price).
  // The modelled 2 USD/(req/s)·mo is the REQUEST-FEE basis, verified against current list pricing: CloudFront charges
  // $0.0100 per 10,000 HTTPS requests in the US/Canada/Mexico region, with the first 10M requests/month free
  // (https://aws.amazon.com/cloudfront/pricing/, 2026). One sustained req/s ≈ 2.59M requests/month, so above the free
  // tier the request fee tends to ≈ $2.59/(req/s)·mo — the default rounds to 2 as an est. Two boundaries stated so the
  // figure is not misread: (a) DATA-TRANSFER-OUT (egress ≈ $0.085/GB, typically the LARGER line) is billed SEPARATELY
  // and is NOT folded into this per-request coefficient; (b) volume discounts and the CloudFront Security Savings
  // Bundle cut the effective rate at scale — this default is the undiscounted list price.
  // SUSTAINED-vs-PEAK: cost is pay-per-use (inflow × unitCost), so it consumes the DECLARED SUSTAINED request rate,
  // never a peak; under assumption worlds, read the monthly cost from the AVERAGE world — a CDN bills the month's
  // actual volume, not its busiest second (the generated-doc cost derivations already teach the sustained-vs-peak rule).
  'cdn.cloudfront': {
    type: 'cdn.cloudfront',
    ports: [
      { name: 'in', dir: 'in', accepts: ['https'] },
      // est. 90% cache-hit ⇒ the origin sees ~10% of client traffic. Overridable per instance/wire (see the note above).
      { name: 'out', dir: 'out', speaks: ['https'], transform: { kind: 'ratio', value: 0.1 } },
    ],
    config: [
      { key: k.throughput, value: 10000, unit: 'req/s', est: true },
      { key: k.latency, value: 10, unit: 'ms', est: true }, // est. edge overhead
      // corrected to the published CloudFront SLA — 99.9% Monthly Uptime Percentage (verified live
      // 2026-07-12) — https://aws.amazon.com/cloudfront/sla/.
      { key: k.availability, value: 0.999, unit: 'ratio', source: 'https://aws.amazon.com/cloudfront/sla/' },
      unitCostConfig(2, 'USD/(req/s)·month'), // managed AWS CloudFront (est., list): HTTPS request fee ≈ $2.59/(req/s)·mo above the 10M/mo free tier; egress billed separately
    ],
    relations: [payPerUseCost],
  },

  // GENERIC AWS Lambda — the palette default, so its numbers must be REALISTIC for a typical short
  // API/CRUD handler, not for any one case. Sourced (us-east-1, x86, 2026):
  //  - pricing: $0.20 per 1M requests + $0.0000166667 per GB-second (https://aws.amazon.com/lambda/pricing/).
  //    At the modelled 1,024 MB x 100 ms: 1 req/s sustained ~ 2.63M invocations/month -> requests ~$0.53
  //    + compute 262,980 GB-s ~ $4.38 => ~$4.9/(req/s)/month, rounded to 5.
  //  - concurrency: the DEFAULT account-level quota (1,000 concurrent executions/Region, soft) — a single
  //    function with no reserved cap draws from that pool (https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html).
  //  - perRequestDuration 100 ms + latency (invoke overhead) 10 ms are `est.` — workload-dependent by nature.
  'compute.lambda': {
    type: 'compute.lambda',
    ports: [
      triggerIn('https'), // invoked over HTTPS (Function URL / API GW) OR by an event source (SQS/SNS/Kinesis/…)
      clientOut('out', 'https'), // calls AWS services (HTTPS + SigV4), plus any other backend (general code)
    ],
    config: [
      { key: k.concurrency, value: 1000, unit: '1', source: 'https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html' }, // unreserved — the account pool (default quota, soft)
      { key: k.perRequestDuration, value: 100, unit: 'ms', est: true }, // est. typical short API/CRUD handler
      { key: k.latency, value: 10, unit: 'ms', est: true }, // est. invoke/runtime overhead (cold starts are a distribution, not a mean)
      { key: k.availability, value: 0.9995, unit: 'ratio', source: 'https://aws.amazon.com/lambda/sla/' }, // AWS Lambda SLA 99.95%
      unitCostConfig(5, 'USD/(req/s)·month'), // managed AWS Lambda (est., pay-per-use): derived from sourced per-request/GB-s pricing at an estimated 1,024 MB × 100 ms, us-east-1 (see the note above)
      ...lambdaAccountConcurrency().config,
    ],
    relations: [
      { key: k.throughput, reads: [k.concurrency, k.perRequestDuration], expr: 'concurrency / (perRequestDuration / 1000)' },
      payPerUseCost,
      ...lambdaAccountConcurrency().relations,
    ],
    bands: [...lambdaAccountConcurrency().bands],
  },

  // The VoiceStack streaming TURN Lambda (case-scoped id): capacity = concurrency / turn-time (Little's law).
  // The reserved concurrency 10 is the CDK's deliberate cost cap on a publicly-invocable Function URL — and
  // the bottleneck. Its unusual numbers (2.3 s busy, ~$100/(req/s)·mo at 1,024 MB) are the REAL cost of one
  // voice turn (STT+LLM+TTS) — correct for THIS case, wildly wrong as a generic Lambda default, hence the split.
  'compute.lambda-voice': {
    type: 'compute.lambda-voice',
    ports: [
      triggerIn('https'), // invoked over HTTPS (Function URL / API GW) OR by an event source (SQS/SNS/Kinesis/…)
      clientOut('out', 'https'), // calls AWS services (HTTPS + SigV4), plus any other backend (general code)
    ],
    config: [
      { key: k.concurrency, value: 10, unit: '1', est: true }, // reservedConcurrentExecutions (CDK) — a real deployed setting, but from a private IaC config, not a public vendor doc
      { key: k.perRequestDuration, value: 2300, unit: 'ms', est: true }, // busy ≈ STT+LLM+TTS (est. from the parts)
      { key: k.latency, value: 20, unit: 'ms', est: true }, // own orchestration overhead (est.)
      { key: k.availability, value: 0.9995, unit: 'ratio', source: 'https://aws.amazon.com/lambda/sla/' }, // AWS Lambda SLA 99.95%
      unitCostConfig(100, 'USD/(req/s)·month'), // managed AWS Lambda (est.): GB-s + invocations at 1024 MB / ~2.3 s/turn
      // AWS account concurrency ceiling (default 1,000/Region, soft): https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html
      ...lambdaAccountConcurrency().config,
    ],
    relations: [
      { key: k.throughput, reads: [k.concurrency, k.perRequestDuration], expr: 'concurrency / (perRequestDuration / 1000)' },
      payPerUseCost,
      ...lambdaAccountConcurrency().relations, // offered load ⇒ concurrency (Little's law); throttled past the account quota
    ],
    bands: [...lambdaAccountConcurrency().bands],
  },

  'ai.transcribe': {
    type: 'ai.transcribe',
    ports: [
      { name: 'in', dir: 'in', accepts: ['https'] },
      { name: 'out', dir: 'out', speaks: ['https'] },
    ],
    config: [
      { key: k.throughput, value: 100, unit: 'req/s', est: true },
      { key: k.latency, value: 300, unit: 'ms', est: true }, // est. streaming STT to final transcript
      { key: k.availability, value: 0.999, unit: 'ratio', source: 'https://aws.amazon.com/ai/services/language-sla/' }, // Amazon ML Language SLA (covers Transcribe) 99.9%
      unitCostConfig(50, 'USD/(req/s)·month'), // managed AWS Transcribe (est., pay-per-use): streaming STT audio-seconds
    ],
    relations: [payPerUseCost],
  },

  'ai.bedrock': {
    type: 'ai.bedrock',
    ports: [
      { name: 'in', dir: 'in', accepts: ['https'] },
      { name: 'out', dir: 'out', speaks: ['https'] },
    ],
    config: [
      { key: k.throughput, value: 50, unit: 'req/s', est: true },
      // MEASURED: Claude Sonnet ~1.5 s/turn (phase 0, the team's own empirical figure) — credible but not a
      // published AWS number, so it takes the `est` bucket (the closest of the three provenance classes to
      // "measured internally"; ManifestConfig has no separate "measured" category).
      { key: k.latency, value: 1500, unit: 'ms', est: true },
      { key: k.availability, value: 0.999, unit: 'ratio', source: 'https://aws.amazon.com/bedrock/sla/' }, // Amazon Bedrock SLA 99.9%
      unitCostConfig(90, 'USD/(req/s)·month'), // managed AWS Bedrock (est., pay-per-use): input+output tokens per turn
    ],
    relations: [payPerUseCost],
  },

  'ai.polly': {
    type: 'ai.polly',
    ports: [
      { name: 'in', dir: 'in', accepts: ['https'] },
      { name: 'out', dir: 'out', speaks: ['https'] },
    ],
    config: [
      { key: k.throughput, value: 100, unit: 'req/s', est: true },
      { key: k.latency, value: 500, unit: 'ms', est: true }, // est. generative TTS first audio
      { key: k.availability, value: 0.999, unit: 'ratio', source: 'https://aws.amazon.com/ai/services/language-sla/' }, // Amazon ML Language SLA (covers Polly) 99.9%
      unitCostConfig(40, 'USD/(req/s)·month'), // managed AWS Polly (est., pay-per-use): generative TTS characters per turn
    ],
    relations: [payPerUseCost],
  },

  'db.dynamodb': {
    type: 'db.dynamodb',
    // DynamoDB reads are EVENTUALLY CONSISTENT by default (strong is an opt-in per-request parameter), so a request
    // path terminating here computes consistency:eventual unless the design declares strong reads (sourced, §2).
    ports: [{ name: 'in', dir: 'in', accepts: ['https'], guarantees: dynamodbGuarantees }],
    config: [
      { key: k.throughput, value: 1000, unit: 'req/s', est: true }, // on-demand, scales
      { key: k.latency, value: 10, unit: 'ms', est: true }, // single-digit ms
      DYNAMODB_AVAILABILITY.config, // deploymentMode (default single-Region 99.99%); mode 2 = global tables 99.999%
      unitCostConfig(3, 'USD/(req/s)·month'), // managed AWS DynamoDB (est., on-demand): read+write request units
      // DOCUMENTED item-size ceiling: 400 KB max item (https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/ServiceQuotas.html).
      // Informational: fires only if the architect sets `payloadBytes` (the real item size); 0 by default.
      ...DYNAMODB_ITEM_LIMIT.config,
    ],
    relations: [DYNAMODB_AVAILABILITY.relation, payPerUseCost, DYNAMODB_ITEM_LIMIT.relation],
    bands: [DYNAMODB_ITEM_LIMIT.band],
  },
}));
