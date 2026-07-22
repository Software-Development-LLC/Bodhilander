import { test, expect } from 'bun:test';
import { applyModelCacheDir } from './model-cache';

// A userData-style destination (what the real caller passes). Deliberately NOT
// a world-writable OS temp dir like /tmp — using one here would be flagged by
// SonarQube S5443 and misrepresents where the model actually caches.
const CACHE_DIR = '/Users/x/Library/Application Support/bodhilander/huggingface';

test('sets env.cacheDir so transformers.js caches outside the app bundle', () => {
  const env: { cacheDir?: string; allowRemoteModels?: boolean } = {};
  applyModelCacheDir(env, CACHE_DIR);
  expect(env.cacheDir).toBe(CACHE_DIR);
});

test('keeps remote models allowed so the first-run download still works', () => {
  const env: { cacheDir?: string; allowRemoteModels?: boolean } = { allowRemoteModels: false };
  applyModelCacheDir(env, CACHE_DIR);
  expect(env.allowRemoteModels).toBe(true);
});

test('does not touch HF_HOME / TRANSFORMERS_CACHE (transformers.js ignores them)', () => {
  // Regression guard for the original bug: the fix must configure env.cacheDir,
  // not the Python-only environment variables.
  const before = { HF_HOME: process.env.HF_HOME, TRANSFORMERS_CACHE: process.env.TRANSFORMERS_CACHE };
  applyModelCacheDir({}, CACHE_DIR);
  expect(process.env.HF_HOME).toBe(before.HF_HOME);
  expect(process.env.TRANSFORMERS_CACHE).toBe(before.TRANSFORMERS_CACHE);
});

test('is a no-op when the transformers env is unavailable', () => {
  expect(() => applyModelCacheDir(null, CACHE_DIR)).not.toThrow();
  expect(() => applyModelCacheDir(undefined, CACHE_DIR)).not.toThrow();
});
