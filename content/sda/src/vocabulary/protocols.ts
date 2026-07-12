import { ProtocolId } from '@sda/engine-core';
import type { Compat } from '@sda/engine-solve';
import type { Manifest } from './manifest';
import { manifests } from '../catalog/catalog';
import { voiceManifests } from '../catalog/voice';
import { commonManifests } from '../catalog/common';
import { fargateManifests } from '../catalog/fargate';

// The canonical PROTOCOL vocabulary: REAL, officially-named wire protocols (professionals recognise every
// id; the `note` carries the full official name + spec, surfaced by the UI on hover) plus the AWS EVENT
// integrations (kind 'event' — delivery channels like a Lambda event source mapping, honestly NOT wire
// protocols). The engine's legality layer reasons over the ids as opaque tokens. Centralising them lets us
// validate every manifest reference (catches typos) and declare the cross-protocol compatibilities the
// reflexive default (same protocol always connects) does not cover.

export interface Protocol {
  readonly id: string;
  /** sync = request/response wire; async = message/stream wire; event = a managed EVENT/integration channel
   *  (an official service name, not a wire protocol — e.g. delivered via a Lambda event source mapping). */
  readonly kind: 'sync' | 'async' | 'event';
  /** The full official name + specification — what the UI shows on hover. */
  readonly note: string;
}

export const protocols: readonly Protocol[] = [
  // ── web / API ──
  { id: 'http', kind: 'sync', note: 'HTTP/1.1 — Hypertext Transfer Protocol (RFC 9110/9112)' },
  { id: 'https', kind: 'sync', note: 'HTTP over TLS (RFC 9110 + RFC 8446); cloud service APIs (AWS SigV4 etc.) are HTTPS' },
  { id: 'http2', kind: 'sync', note: 'HTTP/2 (RFC 9113) — multiplexed HTTP over one TCP connection' },
  { id: 'http3', kind: 'sync', note: 'HTTP/3 over QUIC (RFC 9114)' },
  { id: 'websocket', kind: 'async', note: 'WebSocket (RFC 6455) — persistent full-duplex over HTTP upgrade' },
  { id: 'sse', kind: 'async', note: 'Server-Sent Events (WHATWG HTML spec) — one-way server push, text/event-stream' },
  { id: 'grpc', kind: 'sync', note: 'gRPC — RPC over HTTP/2 with Protocol Buffers (grpc.io spec)' },
  { id: 'grpc-web', kind: 'sync', note: 'gRPC-Web — browser-compatible gRPC via an HTTP/1.1-friendly framing' },
  { id: 'graphql', kind: 'sync', note: 'GraphQL over HTTP (GraphQL Foundation spec) — query language transported on HTTP' },
  { id: 'soap', kind: 'sync', note: 'SOAP 1.2 (W3C) — XML messaging, typically over HTTP' },
  { id: 'webrtc', kind: 'async', note: 'WebRTC (W3C/IETF) — real-time media/data, SRTP + SCTP over ICE' },
  // ── databases ──
  { id: 'postgresql', kind: 'sync', note: 'PostgreSQL Frontend/Backend Protocol v3 (postgresql.org/docs protocol chapter)' },
  { id: 'mysql', kind: 'sync', note: 'MySQL Client/Server Protocol (dev.mysql.com internals)' },
  { id: 'tds', kind: 'sync', note: 'TDS — Tabular Data Stream (Microsoft SQL Server, MS-TDS specification)' },
  { id: 'oracle-tns', kind: 'sync', note: 'Oracle TNS — Transparent Network Substrate (Oracle Net)' },
  { id: 'odbc', kind: 'sync', note: 'ODBC — Open Database Connectivity, the standard DB access API (ISO/IEC 9075-3 SQL/CLI); wire is driver-specific' },
  { id: 'mongodb', kind: 'sync', note: 'MongoDB Wire Protocol (mongodb.com docs)' },
  { id: 'cql', kind: 'sync', note: 'CQL Native Protocol — Apache Cassandra / ScyllaDB binary protocol' },
  { id: 'resp', kind: 'sync', note: 'RESP — REdis Serialization Protocol (Redis/Valkey/Dragonfly); as a queue, a worker BRPOPs it' },
  { id: 'memcached', kind: 'sync', note: 'Memcached protocol (text/binary) — NOT RESP-compatible' },
  { id: 'bolt', kind: 'sync', note: 'Bolt Protocol — Neo4j binary graph protocol' },
  // ── messaging / streaming ──
  { id: 'kafka', kind: 'async', note: 'Apache Kafka wire protocol (kafka.apache.org/protocol)' },
  { id: 'amqp', kind: 'async', note: 'AMQP 0-9-1 / 1.0 (OASIS, ISO/IEC 19464) — RabbitMQ, ActiveMQ, Azure Service Bus' },
  { id: 'mqtt', kind: 'async', note: 'MQTT (OASIS, ISO/IEC 20922) — lightweight pub/sub for IoT' },
  { id: 'nats', kind: 'async', note: 'NATS Client Protocol (docs.nats.io)' },
  { id: 'stomp', kind: 'async', note: 'STOMP 1.2 — Simple Text Oriented Messaging Protocol' },
  { id: 'pulsar', kind: 'async', note: 'Apache Pulsar binary protocol' },
  // ── network / infra ──
  { id: 'tcp', kind: 'sync', note: 'TCP (RFC 9293) — raw transport' },
  { id: 'udp', kind: 'async', note: 'UDP (RFC 768) — datagrams: telemetry, games, media' },
  { id: 'dns', kind: 'sync', note: 'DNS (RFC 1035) — name resolution (Route 53, CoreDNS)' },
  { id: 'smtp', kind: 'async', note: 'SMTP (RFC 5321) — e-mail submission/relay (SES, SendGrid)' },
  { id: 'ldap', kind: 'sync', note: 'LDAP (RFC 4511) — directory access (Active Directory, OpenLDAP)' },
  { id: 'sftp', kind: 'sync', note: 'SFTP — SSH File Transfer Protocol (draft-ietf-secsh-filexfer; B2B file exchange)' },
  // ── managed EVENT integrations (official AWS service names; delivery = Lambda event source mapping / push) ──
  { id: 'sqs', kind: 'event', note: 'Amazon SQS — queue consumption via Lambda event source mapping / ReceiveMessage polling' },
  { id: 'sns', kind: 'event', note: 'Amazon SNS — push subscription fan-out' },
  { id: 'kinesis', kind: 'event', note: 'Amazon Kinesis Data Streams — shard records via Lambda event source mapping' },
  { id: 'dynamodb-streams', kind: 'event', note: 'Amazon DynamoDB Streams — change records via Lambda event source mapping' },
  { id: 's3-event', kind: 'event', note: 'Amazon S3 Event Notifications — object events (to Lambda/SQS/SNS)' },
  { id: 'eventbridge', kind: 'event', note: 'Amazon EventBridge — event bus rules/targets' },
];

/** Full official name + spec for a protocol id (the UI hover). Unknown ids return undefined — honest. */
export function protocolNote(id: string): string | undefined {
  return protocols.find((p) => p.id === id)?.note;
}

export const protocolIds: ReadonlySet<string> = new Set(protocols.map((p) => p.id));

// Cross-protocol allowances (producer → consumer). The legality engine adds the reflexive pairs
// (X → X) itself, so only the genuine cross-protocol cases live here.
const RAW_COMPAT: ReadonlyArray<readonly [string, string]> = [
  ['https', 'http'], // TLS terminated at the edge → an HTTP backend accepts it
];

export const protocolCompat: readonly Compat[] = RAW_COMPAT.map(([out, inn]) => ({ out: ProtocolId(out), in: ProtocolId(inn) }));

/** Every protocol id referenced by a port across the given catalogs — everything it accepts or speaks. */
export function referencedProtocols(catalogs: ReadonlyArray<Readonly<Record<string, Manifest>>>): Set<string> {
  const seen = new Set<string>();
  for (const cat of catalogs) for (const m of Object.values(cat)) for (const p of m.ports) {
    for (const a of p.accepts ?? []) seen.add(a);
    for (const a of p.speaks ?? []) seen.add(a);
  }
  return seen;
}

/** Protocol ids used by some manifest but absent from the catalog (typos / missing entries). */
export function unknownProtocols(catalogs: ReadonlyArray<Readonly<Record<string, Manifest>>>): string[] {
  return [...referencedProtocols(catalogs)].filter((p) => !protocolIds.has(p)).sort();
}

/** All shipped catalogs, for whole-content validation. */
export const allCatalogs: ReadonlyArray<Readonly<Record<string, Manifest>>> = [manifests, voiceManifests, commonManifests, fargateManifests];
