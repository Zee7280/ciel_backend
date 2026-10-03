import { BadRequestException } from '@nestjs/common';
import { setNestedProperty } from './nested-path.util';

describe('setNestedProperty', () => {
  it('builds nested objects and arrays from dotted / indexed paths', () => {
    const o: any = {};
    setNestedProperty(o, 'section1.team_lead.name', 'Ali');
    setNestedProperty(o, 'section1.team_members[1].email', 'b@x.com');
    setNestedProperty(o, 'tags[0]', 'a');
    expect(o).toEqual({
      section1: { team_lead: { name: 'Ali' }, team_members: [undefined, { email: 'b@x.com' }] },
      tags: ['a'],
    });
  });

  it.each([
    '__proto__.isAdmin',
    'constructor.prototype.isAdmin',
    'section1.__proto__.polluted',
    'a.constructor',
    'prototype.x',
    '__proto__[0]',
  ])('rejects the prototype-pollution path %s and leaves Object.prototype clean', (path) => {
    const o: any = {};
    expect(() => setNestedProperty(o, path, '1')).toThrow(BadRequestException);
    expect(({} as any).isAdmin).toBeUndefined();
    expect(({} as any).polluted).toBeUndefined();
    expect(({} as any).x).toBeUndefined();
  });

  it('rejects absurd array indexes and over-deep paths', () => {
    expect(() => setNestedProperty({}, 'a[999999999]', 1)).toThrow(BadRequestException);
    expect(() => setNestedProperty({}, Array.from({ length: 20 }, (_, i) => `k${i}`).join('.'), 1)).toThrow(
      BadRequestException,
    );
  });

  it('does not reuse inherited properties as containers', () => {
    const o: any = {};
    setNestedProperty(o, 'toString.x', 1); // "toString" is inherited, must become an own plain object
    expect(Object.prototype.hasOwnProperty.call(o, 'toString')).toBe(true);
    expect((Object.prototype.toString as any).x).toBeUndefined();
  });
});
