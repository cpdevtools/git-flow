import { describe, it, expect } from 'vitest';
import { parseTarget } from './withdraw.js';

describe('parseTarget', () => {
  it('splits on the last @ so scoped names work', () => {
    expect(parseTarget('@org/orders@1.4.2')).toEqual({ pkg: '@org/orders', version: '1.4.2' });
    expect(parseTarget('plain@2.0.0-beta.1')).toEqual({ pkg: 'plain', version: '2.0.0-beta.1' });
  });

  it('accepts all and strips a leading v', () => {
    expect(parseTarget('@org/orders@all')).toEqual({ pkg: '@org/orders', version: 'all' });
    expect(parseTarget('@org/orders@v1.4.2').version).toBe('1.4.2');
  });

  it('rejects anything else', () => {
    expect(() => parseTarget('@org/orders')).toThrow(/<package>@<version>/);
    expect(() => parseTarget('orders@')).toThrow(/<package>@<version>/);
    expect(() => parseTarget('@1.2.3')).toThrow(/<package>@<version>/);
  });
});
