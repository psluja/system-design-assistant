// Catalogue facets (doc-9 §3) derived from a component type id, for the persistent palette filters.
// kind = the type's prefix; provider = a small membership map; tags = a few heuristics.

export const KIND_LABEL: Record<string, string> = {
  client: 'Client',
  compute: 'Compute',
  cache: 'Cache',
  db: 'Database',
  storage: 'Storage',
  proxy: 'Proxy',
  lb: 'Load balancer',
  apigw: 'API gateway',
  cdn: 'CDN',
  queue: 'Queue',
  stream: 'Stream',
  search: 'Search',
  security: 'Security',
  ai: 'AI service',
  gateway: 'Gateway',
};

const AWS = new Set([
  'cdn.cloudfront',
  'compute.lambda',
  'ai.transcribe',
  'ai.bedrock',
  'ai.polly',
  'db.dynamodb',
  'apigw.rest',
  'lb.alb',
  'db.aurora',
  'security.waf',
  'gateway.api',
  'compute.faas',
  'compute.vm',
  'db.sql',
  'db.cheap',
  'client.source',
  'queue.sqs',
  'queue.sqs.fifo',
  'compute.fargate',
  'compute.asg',
]);

export interface Facets {
  readonly kind: string;
  readonly provider: string;
  readonly tags: readonly string[];
}

export function facetsOf(type: string): Facets {
  const kind = type.split('.')[0] ?? 'other';
  const provider = AWS.has(type) ? 'aws' : 'oss';
  const tags: string[] = [];
  if (kind === 'cache' || kind === 'compute' || kind === 'ai') tags.push('stateless');
  if (kind === 'db' || kind === 'storage') tags.push('stateful');
  if (kind === 'ai') tags.push('managed');
  return { kind, provider, tags };
}
