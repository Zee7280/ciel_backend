import { BadRequestException } from '@nestjs/common';

const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_ARRAY_INDEX = 5000;
const MAX_PATH_DEPTH = 12;

/**
 * Assigns `value` at a dotted / indexed path ("section1.team_members[2].name") on `obj`.
 *
 * The body keys come straight from the client, so this must never walk into `Object.prototype`
 * (prototype pollution: a key like "__proto__.isAdmin" would otherwise set the property on every
 * object in the process) and must not allocate giant sparse arrays.
 */
export function setNestedProperty(
  obj: Record<string, any>,
  path: string,
  value: unknown,
): void {
  const keys = String(path).split('.');
  if (keys.length > MAX_PATH_DEPTH) {
    throw new BadRequestException('Invalid field path.');
  }

  const parse = (raw: string): { name: string; index: number | null } => {
    const m = raw.match(/^(.+)\[(\d+)\]$/);
    const name = m ? m[1] : raw;
    const index = m ? parseInt(m[2], 10) : null;
    if (FORBIDDEN_SEGMENTS.has(name) || name === '') {
      throw new BadRequestException('Invalid field path.');
    }
    if (index !== null && index > MAX_ARRAY_INDEX) {
      throw new BadRequestException('Invalid field path.');
    }
    return { name, index };
  };

  const own = (o: object, k: string) =>
    Object.prototype.hasOwnProperty.call(o, k);

  let current: Record<string, any> = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const { name, index } = parse(keys[i]);
    if (index !== null) {
      if (!own(current, name) || !Array.isArray(current[name])) current[name] = [];
      const arr = current[name] as any[];
      if (!arr[index] || typeof arr[index] !== 'object') arr[index] = {};
      current = arr[index];
    } else {
      if (!own(current, name) || !current[name] || typeof current[name] !== 'object') {
        current[name] = {};
      }
      current = current[name];
    }
  }

  const { name, index } = parse(keys[keys.length - 1]);
  if (index !== null) {
    if (!own(current, name) || !Array.isArray(current[name])) current[name] = [];
    current[name][index] = value;
  } else {
    current[name] = value;
  }
}
