import { describe, it, expect } from 'vitest';
import { normalizeSharedStorage } from './execute.js';

describe('normalizeSharedStorage', () => {
  it('treats absent and false as not declared', () => {
    expect(normalizeSharedStorage(undefined, 'svc')).toBeUndefined();
    expect(normalizeSharedStorage(false, 'svc')).toBeUndefined();
  });

  it('passes true through', () => {
    expect(normalizeSharedStorage(true, 'svc')).toBe(true);
  });

  it('accepts an array of relative paths', () => {
    expect(normalizeSharedStorage(['data-protection', 'uploads/tmp'], 'svc')).toEqual([
      'data-protection',
      'uploads/tmp',
    ]);
  });

  it('rejects a non-array, non-true, non-object value', () => {
    expect(() => normalizeSharedStorage('data-protection', 'svc')).toThrow(
      /expected true, an array of relative paths, or/,
    );
  });

  it('accepts the { shared, versioned } object form', () => {
    expect(
      normalizeSharedStorage({ shared: ['repos-config'], versioned: ['cache'] }, 'svc'),
    ).toEqual({ shared: ['repos-config'], versioned: ['cache'] });
  });

  it('validates entries inside the object form', () => {
    expect(() => normalizeSharedStorage({ versioned: ['../escape'] }, 'svc')).toThrow(/'\.\.'/);
  });

  it('rejects absolute paths', () => {
    expect(() => normalizeSharedStorage(['/docker-nfs/data'], 'svc')).toThrow(/relative path/);
  });

  it('rejects traversal segments', () => {
    expect(() => normalizeSharedStorage(['../other-svc'], 'svc')).toThrow(/'\.\.'/);
  });

  it('rejects empty and non-string entries', () => {
    expect(() => normalizeSharedStorage([''], 'svc')).toThrow(/non-empty string/);
    expect(() => normalizeSharedStorage([42], 'svc')).toThrow(/non-empty string/);
  });
});
