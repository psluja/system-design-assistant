import { describe, expect, it } from 'vitest';
import { NodeId } from '@sda/engine-core';
import { evaluate, illegalEdges } from '@sda/engine-solve';
import { instantiate, registry, keys, voiceManifests, type Instance, type Wire } from '../index';

// A REAL architecture, reverse-engineered from the VoiceStack CDK: one conversation turn flows
// browser → CloudFront → streaming Lambda → Transcribe → Bedrock(LLM) → Polly → DynamoDB. The engine
// must surface the two truths this stack actually has: throughput is capped by the Lambda's reserved
// concurrency (10), and turn latency is dominated by the LLM — not the infrastructure.
describe('REAL case: VoiceStack conversation-turn pipeline', () => {
  const instances: Instance[] = [
    { id: 'browser', type: 'client.browser' },
    // CloudFront fronts the streaming Lambda Function URL (the real-time /stream path) — a voice TURN is dynamic and
    // NOT cacheable, so the origin sees 100% of turns. The catalog's est. 90%-hit default (ratio 0.1) is wrong for
    // THIS case, so we pin the instance back to ratio(1): every browser turn reaches the Lambda. The sourced numbers
    // below (throughput = concurrency/turn-time, 6-hop availability) were computed for full pass-through and stand.
    { id: 'cdn', type: 'cdn.cloudfront', transforms: { out: { kind: 'ratio', value: 1 } } },
    { id: 'lambda', type: 'compute.lambda-voice' },
    { id: 'transcribe', type: 'ai.transcribe' },
    {
      id: 'bedrock',
      type: 'ai.bedrock',
    },
    { id: 'polly', type: 'ai.polly' },
    {
      id: 'sessions',
      type: 'db.dynamodb',
      bands: [
        { key: keys.throughput, band: { shape: 'minTargetMax', min: 8 } }, // must serve all 8 agents
        { key: keys.latency, band: { shape: 'minTargetMax', max: 2000 } }, // turn budget 2 s
      ],
    },
  ];
  const wires: Wire[] = [
    { from: ['browser', 'out'], to: ['cdn', 'in'] },
    { from: ['cdn', 'out'], to: ['lambda', 'in'] },
    { from: ['lambda', 'out'], to: ['transcribe', 'in'] },
    { from: ['transcribe', 'out'], to: ['bedrock', 'in'] },
    { from: ['bedrock', 'out'], to: ['polly', 'in'] },
    { from: ['polly', 'out'], to: ['sessions', 'in'] },
  ];

  const built = instantiate(voiceManifests, instances, wires);
  if (!built.ok) throw new Error('graph build failed');
  const graph = built.value;
  const sink = NodeId('sessions');

  it('is protocol-legal end to end (https edge, aws-api interior)', () => {
    expect(illegalEdges(graph, [])).toEqual([]);
  });

  it('computes the turn: throughput capped by Lambda concurrency, latency dominated by the LLM', () => {
    const r = evaluate(graph, registry);
    if (!r.ok) throw new Error(r.error.join('; '));
    expect(r.value.converged).toBe(true);

    // capacity = reservedConcurrency 10 / 2.3 s turn ≈ 4.35 turns/s (< the 8 demanded)
    expect(r.value.value(sink, keys.throughput)).toBeCloseTo(10 / 2.3, 3);
    // latency = 10 + 20 + 300 + 1500 + 500 + 10 = 2340 ms (the LLM is 1500 of it)
    expect(r.value.value(sink, keys.latency)).toBe(2340);
    // availability compounds across 6 hops: cdn 0.999 (: corrected CloudFront SLA) · lambda-voice 0.9995
    // · transcribe 0.999 · bedrock 0.999 · polly 0.999 · dynamodb 0.9999 ≈ 0.99541 (was 0.9963 with the old,
    // uncorrected cdn 0.9999 factor).
    expect(r.value.value(sink, keys.availability)).toBeCloseTo(0.9954, 3);
  });

  it('blames the Lambda for the throughput miss and the LLM for the latency miss', () => {
    const r = evaluate(graph, registry);
    if (!r.ok) throw new Error(r.error.join('; '));

    const tput = r.value.verdicts.find((v) => v.scope === sink && v.key === keys.throughput);
    expect(tput?.status).toBe('violation'); // 4.35 < 8
    expect(tput?.cause.some((l) => l.scope === NodeId('lambda'))).toBe(true);
    expect(tput?.remediations[0]?.action).toContain('Increase');
    expect(tput?.remediations[0]?.action).toContain('lambda');

    const lat = r.value.verdicts.find((v) => v.scope === sink && v.key === keys.latency);
    expect(lat?.status).toBe('violation'); // 2340 > 2000
    expect(lat?.cause.some((l) => l.scope === NodeId('bedrock'))).toBe(true);
    expect(lat?.remediations[0]?.action).toContain('Reduce');
    expect(lat?.remediations[0]?.action).toContain('bedrock');
  });
});
