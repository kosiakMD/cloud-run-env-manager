import { describe, expect, it } from 'vitest';
import { parseEnvsFromV2, mergeEnv, type V2Service } from './cloud-run.js';

describe('parseEnvsFromV2', () => {
  it('returns plain key→value map for plain env vars', () => {
    const svc: V2Service = {
      template: {
        containers: [
          {
            env: [
              { name: 'LOG_LEVEL', value: 'info' },
              { name: 'API_VERSION', value: '1.2.3' },
            ],
          },
        ],
      },
    };
    expect(parseEnvsFromV2(svc)).toEqual({
      LOG_LEVEL: 'info',
      API_VERSION: '1.2.3',
    });
  });

  it('strips secret refs (entries with valueSource)', () => {
    const svc: V2Service = {
      template: {
        containers: [
          {
            env: [
              { name: 'PLAIN', value: 'ok' },
              { name: 'SECRET', valueSource: { secretKeyRef: { secret: 's', version: 'latest' } } },
            ],
          },
        ],
      },
    };
    expect(parseEnvsFromV2(svc)).toEqual({ PLAIN: 'ok' });
  });

  it('returns empty object when there is no env block', () => {
    expect(parseEnvsFromV2({ template: { containers: [{}] } })).toEqual({});
  });

  it('handles missing template gracefully', () => {
    expect(parseEnvsFromV2({})).toEqual({});
  });
});

describe('mergeEnv', () => {
  it('applies updates to existing keys, preserving order', () => {
    const svc: V2Service = {
      template: { containers: [{ env: [
        { name: 'A', value: '1' },
        { name: 'B', value: '2' },
      ] }] },
    };
    expect(mergeEnv(svc, { A: 'x' }, [])).toEqual([
      { name: 'A', value: 'x' },
      { name: 'B', value: '2' },
    ]);
  });

  it('appends brand-new keys at the end', () => {
    const svc: V2Service = {
      template: { containers: [{ env: [{ name: 'A', value: '1' }] }] },
    };
    expect(mergeEnv(svc, { NEW_KEY: 'v' }, [])).toEqual([
      { name: 'A', value: '1' },
      { name: 'NEW_KEY', value: 'v' },
    ]);
  });

  it('removes keys listed in deletes', () => {
    const svc: V2Service = {
      template: { containers: [{ env: [
        { name: 'A', value: '1' },
        { name: 'B', value: '2' },
      ] }] },
    };
    expect(mergeEnv(svc, {}, ['A'])).toEqual([{ name: 'B', value: '2' }]);
  });

  it('preserves secret refs (valueSource entries)', () => {
    const svc: V2Service = {
      template: { containers: [{ env: [
        { name: 'PLAIN', value: '1' },
        { name: 'SECRET', valueSource: { secretKeyRef: { secret: 's' } } },
      ] }] },
    };
    const out = mergeEnv(svc, { PLAIN: '2' }, []);
    expect(out).toContainEqual({ name: 'PLAIN', value: '2' });
    expect(out).toContainEqual({ name: 'SECRET', valueSource: { secretKeyRef: { secret: 's' } } });
  });
});
