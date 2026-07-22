import { test, expect } from 'bun:test';
import { applyModelCacheDir } from './model-cache';

test('sets env.cacheDir so transformers.js caches outside the app bundle', () => {
  const env: { cacheDir?: string; allowRemoteModels?: boolean } = {};
  applyModelCacheDir(env, '/Users/x/Library/Application Support/bodhilander/huggingface');
  expect(env.cacheDir).toBe('/Users/x/Library/Application Support/bodhilander/huggingface');
});

test('keeps remote models allowed so the first-run download still works', () => {
  const env: { cacheDir?: string; allowRemoteModels?: boolean } = { allowRemoteModels: false };
  applyModelCacheDir(env, '/tmp/cache');
  expect(env.allowRemoteModels).toBe(true);
});

test('does not touch HF_HOME / TRANSFORMERS_CACHE (transformers.js ignores them)', () => {
  // Regression guard for the original bug: the fix must configure env.cacheDir,
  // not the Python-only environment variables.
  const before = { HF_HOME: process.env.HF_HOME, TRANSFORMERS_CACHE: process.env.TRANSFORMERS_CACHE };
  applyModelCacheDir({}, '/tmp/cache');
  expect(process.env.HF_HOME).toBe(before.HF_HOME);
  expect(process.env.TRANSFORMERS_CACHE).toBe(before.TRANSFORMERS_CACHE);
});

test('is a no-op when the transformers env is unavailable', () => {
  expect(() => applyModelCacheDir(null, '/tmp/cache')).not.toThrow();
  expect(() => applyModelCacheDir(undefined, '/tmp/cache')).not.toThrow();
});
