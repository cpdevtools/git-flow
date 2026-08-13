import { describe, it, expect } from 'vitest';
import { ProviderRegistry, ProviderConflictError } from './provider-registry.js';

let n = 0;
/**
 * Unique namespace per test: registries sharing a name share state by design
 * (that is what makes the four CJS bundle copies one registry), so isolated
 * unit tests must not reuse one.
 */
function fresh<T>(): ProviderRegistry<T> {
  return new ProviderRegistry<T>(`test-registry-${process.pid}-${n++}`);
}

describe('ProviderRegistry precedence', () => {
  // The ladder is from the archived scaffold plans: most local wins, and
  // anything installed outranks what ships in the box.
  it('prefers an installed plugin over a built-in', () => {
    const reg = fresh<string>();
    reg.register('docker', 'builtin-handler', '@cpdevtools/git-flow', 'builtin');
    reg.register('docker', 'plugin-handler', '@org/git-flow-plugin-docker', 'workspace');

    expect(reg.resolve('docker')).toBe('plugin-handler');
  });

  it('prefers a project-level plugin over a workspace-level one', () => {
    const reg = fresh<string>();
    reg.register('ng-lib', 'workspace-handler', '@org/a', 'workspace');
    reg.register('ng-lib', 'project-handler', '@org/b', 'project');

    expect(reg.resolve('ng-lib')).toBe('project-handler');
  });

  it('returns undefined for an unregistered key rather than throwing', () => {
    const reg = fresh<string>();
    expect(reg.resolve('nope')).toBeUndefined();
  });

  it('re-registering the same provider replaces rather than conflicts', () => {
    const reg = fresh<string>();
    reg.register('x', 'first', '@org/p', 'workspace');
    reg.register('x', 'second', '@org/p', 'workspace');

    expect(reg.resolve('x')).toBe('second');
  });
});

describe('ProviderRegistry conflicts', () => {
  // Location cannot break a same-level tie, and picking one silently would
  // publish the wrong artifact without anyone noticing.
  it('throws when two plugins at the same level supply one key', () => {
    const reg = fresh<string>();
    reg.register('ng-lib', 'a', '@org/git-flow-plugin-angular', 'workspace');
    reg.register('ng-lib', 'b', '@other/git-flow-plugin-ng', 'workspace');

    expect(() => reg.resolve('ng-lib')).toThrow(ProviderConflictError);
  });

  it('names both packages and shows the fix', () => {
    const reg = fresh<string>();
    reg.register('ng-lib', 'a', '@org/git-flow-plugin-angular', 'workspace');
    reg.register('ng-lib', 'b', '@other/git-flow-plugin-ng', 'workspace');

    let message = '';
    try {
      reg.resolve('ng-lib');
    } catch (err) {
      message = (err as Error).message;
    }

    expect(message).toContain('@org/git-flow-plugin-angular');
    expect(message).toContain('@other/git-flow-plugin-ng');
    expect(message).toContain('provider:');
  });

  it('a pinned provider resolves the conflict', () => {
    const reg = fresh<string>();
    reg.register('ng-lib', 'a', '@org/git-flow-plugin-angular', 'workspace');
    reg.register('ng-lib', 'b', '@other/git-flow-plugin-ng', 'workspace');

    expect(reg.resolve('ng-lib', '@other/git-flow-plugin-ng')).toBe('b');
    expect(reg.resolve('ng-lib', '@org/git-flow-plugin-angular')).toBe('a');
  });

  it('a conflict at the top level does not hide a lower-level entry from a pin', () => {
    const reg = fresh<string>();
    reg.register('docker', 'builtin', '@cpdevtools/git-flow', 'builtin');
    reg.register('docker', 'a', '@org/a', 'workspace');
    reg.register('docker', 'b', '@org/b', 'workspace');

    expect(() => reg.resolve('docker')).toThrow(ProviderConflictError);
    expect(reg.resolve('docker', '@cpdevtools/git-flow')).toBe('builtin');
  });

  it('explains itself when pinned to a provider that does not supply the key', () => {
    const reg = fresh<string>();
    reg.register('docker', 'builtin', '@cpdevtools/git-flow', 'builtin');

    expect(() => reg.resolve('docker', '@org/not-installed')).toThrow(/not supplied by/);
  });
});

describe('ProviderRegistry introspection', () => {
  it('lists keys and providers sorted', () => {
    const reg = fresh<string>();
    reg.register('zeta', 'v', '@org/z', 'workspace');
    reg.register('alpha', 'v', '@org/b', 'workspace');
    reg.register('alpha', 'v', '@org/a', 'workspace');

    expect(reg.keys()).toEqual(['alpha', 'zeta']);
    expect(reg.providersOf('alpha')).toEqual(['@org/a', '@org/b']);
    expect(reg.has('alpha')).toBe(true);
    expect(reg.has('missing')).toBe(false);
  });
});

describe('ProviderRegistry cross-instance sharing', () => {
  // The store is keyed on globalThis: tsup inlines this module into four CJS
  // entry bundles, and a per-module Map would mean four registries — register
  // in one bundle, dispatch from another, silently miss. Two instances with the
  // same name must therefore see each other's registrations.
  it('instances with the same name share registrations', () => {
    const name = `shared-${process.pid}-${n++}`;
    const a = new ProviderRegistry<string>(name);
    const b = new ProviderRegistry<string>(name);

    a.register('k', 'value', '@org/p', 'workspace');

    expect(b.resolve('k')).toBe('value');
    expect(b.providersOf('k')).toEqual(['@org/p']);
  });

  it('instances with different names do not', () => {
    const a = new ProviderRegistry<string>(`a-${process.pid}-${n++}`);
    const b = new ProviderRegistry<string>(`b-${process.pid}-${n++}`);

    a.register('k', 'value', '@org/p', 'workspace');

    expect(b.resolve('k')).toBeUndefined();
  });
});
