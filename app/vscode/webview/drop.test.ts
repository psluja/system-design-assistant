import { describe, expect, it } from 'vitest';
import { parseDropType } from './drop';

const dt = (entries: Record<string, string>) => (mime: string) => entries[mime] ?? '';

describe('parseDropType', () => {
  it('recovers the type from the EXACT native payload VS Code delivers (custom mime emptied — vscode#245816)', () => {
    // Captured verbatim from a real tree drag via CDP Input.setInterceptDrags.
    const get = dt({
      'application/x-sda-component': '',
      'application/vnd.code.tree.sda.components': '{"id":"sda.components","itemHandles":["1/type:cache.redis"]}',
    });
    expect(parseDropType(get)).toBe('cache.redis');
  });

  it('prefers the custom mime when its value survives (dev harness / future VS Code fix)', () => {
    const get = dt({
      'application/x-sda-component': 'db.postgres',
      'application/vnd.code.tree.sda.components': '{"id":"sda.components","itemHandles":["1/type:cache.redis"]}',
    });
    expect(parseDropType(get)).toBe('db.postgres');
  });

  it('honours the web-shell palette mime', () => {
    expect(parseDropType(dt({ 'application/sda': 'queue.sqs' }))).toBe('queue.sqs');
  });

  it('handles a deeper handle path and ids containing dots/dashes', () => {
    const get = dt({
      'application/vnd.code.tree.sda.components': '{"itemHandles":["0/2/type:compute.lambda-voice"]}',
    });
    expect(parseDropType(get)).toBe('compute.lambda-voice');
  });

  it('returns undefined for group handles, malformed JSON and empty transfers (honest no-op)', () => {
    expect(parseDropType(dt({ 'application/vnd.code.tree.sda.components': '{"itemHandles":["1/group:cache"]}' }))).toBeUndefined();
    expect(parseDropType(dt({ 'application/vnd.code.tree.sda.components': 'not-json' }))).toBeUndefined();
    expect(parseDropType(dt({}))).toBeUndefined();
  });
});
