// Model cache location for @huggingface/transformers (issue #133).
//
// transformers.js does NOT honor `HF_HOME` / `TRANSFORMERS_CACHE` — those are
// the Python `huggingface_hub` env vars. In JS the only knob is `env.cacheDir`,
// which otherwise defaults to a `.cache` folder next to the module. In a
// packaged macOS build that resolves to INSIDE the signed `.app` bundle
// (`Contents/Resources/app.asar.unpacked/dist/main/.cache/…`). Writing there
// breaks the notarized code-signature seal ("a sealed resource is missing or
// invalid"), which corrupts the install and breaks Gatekeeper + auto-update
// validation.
//
// Kept free of the `@huggingface/transformers` import so it is unit-testable
// under `bun test` without pulling in native onnxruntime.

/** The subset of the transformers.js `env` object we mutate. */
export interface TransformersEnvLike {
  cacheDir?: string;
  allowRemoteModels?: boolean;
}

/**
 * Point transformers.js at a writable, out-of-bundle model cache. Downloads
 * land under `<cacheDir>/<model_id>/…`. No-op when `env` is unavailable.
 */
export function applyModelCacheDir(
  env: TransformersEnvLike | null | undefined,
  cacheDir: string
): void {
  if (!env) return;
  env.cacheDir = cacheDir;
  // First run still needs to fetch the model from the Hub.
  env.allowRemoteModels = true;
}
