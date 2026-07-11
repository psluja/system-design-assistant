import type { ManifestPort } from './manifest';

// Consumer ACCEPT-SETS as data: the protocols a port admits beyond its own, each naming a REAL capability,
// not boilerplate. The engine reads them as opaque tokens (it knows nothing about AWS); this is content.

/** What an event-driven compute (function / container / worker) can be TRIGGERED by, beyond a plain HTTP
 *  call: poll- and push-based message/event sources. A datastore does NOT accept these — that is the real
 *  boundary (a queue can drive a Lambda; it cannot drive Postgres). */
export const EVENT_TRIGGERS: readonly string[] = ['https', 'sqs', 'sns', 'kinesis', 'dynamodb-streams', 'kafka', 'amqp', 'mqtt', 'nats', 'resp', 's3-event', 'eventbridge'];

/** What can ENQUEUE onto a queue / topic / stream, beyond its own wire protocol: the service's HTTPS/HTTP
 *  API call (AWS APIs are HTTPS + SigV4) or an SNS fan-out subscription. */
export const PUBLISH_SOURCES: readonly string[] = ['https', 'http', 'sns'];

/** What a general-purpose compute can CALL over its GENERIC outbound port: an HTTP/gRPC service, a SQL/NoSQL
 *  DB (over its real wire protocol or a standard access API like ODBC), a cache, a message broker, mail,
 *  directory… The mirror of EVENT_TRIGGERS for the OUT side — general code links any client library. */
export const CLIENT_PROTOCOLS: readonly string[] = [
  'https', 'http', 'http2', 'grpc', 'grpc-web', 'graphql', 'soap', 'websocket', 'sse',
  'postgresql', 'mysql', 'tds', 'oracle-tns', 'odbc', 'mongodb', 'cql', 'resp', 'memcached', 'bolt',
  'kafka', 'amqp', 'mqtt', 'nats', 'stomp', 'pulsar',
  'tcp', 'udp', 'dns', 'smtp', 'ldap', 'sftp',
];

/** The relational databases a SQL-client dependency port reaches — the real wire protocols of the SQL family
 *  plus the standard access API (ODBC). It is the DB connection, so it reaches databases, not gateways/queues. */
export const DB_PROTOCOLS: readonly string[] = ['postgresql', 'mysql', 'tds', 'oracle-tns', 'odbc'];

// A port carries ONE flat protocol list (accepts for consumers, speaks for producers). Legality treats it as
// a set; by convention the FIRST entry is the port's natural wire protocol (display/facets only), so these
// helpers put the primary first and the rest of the capability set after it, deduplicated.
const led = (primary: string, set: readonly string[]): readonly string[] => [primary, ...set.filter((p) => p !== primary)];

/** The `in` port of an event-driven compute: a sync call port that ALSO accepts every event/queue trigger. */
export const triggerIn = (protocol = 'http'): ManifestPort => ({ name: 'in', dir: 'in', accepts: led(protocol, EVENT_TRIGGERS) });

/** The `in` port of a queue / topic / stream: its wire protocol first, then the usual publish sources. */
export const channelIn = (protocol: string): ManifestPort => ({ name: 'in', dir: 'in', accepts: led(protocol, PUBLISH_SOURCES) });

// Outbound DEPENDENCY ports, each scoped to its ROLE so the suggester/legality stay honest — a `cache` port
// connects to caches, a `db` port to databases, and only a GENERIC compute output speaks anything.

/** The GENERIC outbound port of a compute (a function's `out`): general code, so it can speak any backend. */
export const clientOut = (name: string, protocol: string): ManifestPort => ({ name, dir: 'out', speaks: led(protocol, CLIENT_PROTOCOLS) });

/** A DATABASE dependency port: its primary wire protocol first, then the rest of the SQL family — but NOT
 *  arbitrary backends. It is the DB connection, so it reaches databases, not gateways or queues. */
export const dbOut = (name: string, protocol: string): ManifestPort => ({ name, dir: 'out', speaks: led(protocol, DB_PROTOCOLS) });

/** A CACHE dependency port: the app's cache client — RESP (Redis family) or the Memcached protocol (they are
 *  NOT wire-compatible; the app links whichever client library, so the port can speak both). */
export const cacheOut = (name: string, protocol = 'resp'): ManifestPort => ({ name, dir: 'out', speaks: led(protocol, ['resp', 'memcached']) });
