import { createHash } from 'node:crypto';

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string' ||
    (typeof value === 'number' && Number.isFinite(value))) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${Array.from(value, canonicalJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype === Object.prototype || prototype === null) {
      const fields = value as Record<string, unknown>;
      return `{${Object.keys(fields).sort().map((key) =>
        `${JSON.stringify(key)}:${canonicalJson(fields[key])}`,
      ).join(',')}}`;
    }
  }
  throw new TypeError('Idempotency data must contain only JSON values.');
}

export function requestFingerprint(payload: unknown): string {
  return createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex');
}
