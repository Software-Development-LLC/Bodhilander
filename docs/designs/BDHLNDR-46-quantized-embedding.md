# BDHLNDR-46 — Quantized embedding + token-bounded truncation + re-index migration

Second half of the BDHLNDR-40 root-cause fix (the embedding-neutral safe
subset — `enableCpuMemArena:false` + `BATCH_SIZE` 32→16 — shipped in v3.3.1).
This is the higher-headroom but quality-affecting half, on `development`/beta.

## Root cause recap

5 identical `.ips`: `EXC_BREAKPOINT/SIGTRAP` in `onnxruntime::BFCArena::Extend
→ CPUAllocator::Alloc` — ONNX memory exhaustion in the embedding path. The
pipeline ran the **fp32** model (no `dtype` set) — ~4× the memory of the
quantized variant, with correspondingly larger activation tensors.

## Changes

1. **`dtype: 'q8'`** in the `@huggingface/transformers` pipeline options
   (`embedding-provider.ts`). Quantized bge-base — the main memory-headroom
   fix. Changes embedding numerics vs fp32.
2. **Token-bounded truncation** — `MAX_EMBED_CHARS = 2048` replaces the
   `slice(0, 8000)` cap in `embed()` / `embedSingle()`. bge-base attends to
   only its first 512 tokens (the tokenizer truncates there anyway); ~4
   chars/token for code ⇒ 2048 chars reliably yields ≥512 tokens, so the
   model sees the same content it did under the 8000-char cap, with bounded,
   predictable tokenization + peak tensor.

## Re-index migration (the non-trivial part)

q8 vectors are **not comparable** to existing fp32 vectors — mixing them
breaks search. Versioned, auto-healing migration:

- `EMBEDDING_VERSION` constant in `embedding-provider.ts` (1 = fp32 through
  v3.3.1; 2 = q8 + token bound). Bump on any future embedding-affecting change.
- New `code_indexes.embedding_version` column (`CREATE TABLE` + `ALTER`
  migration, default 1 so pre-existing rows are detected as stale).
- `startIndexing()`: if the persisted version ≠ `EMBEDDING_VERSION` →
  - has indexed data → `clearIndexData()` (drops vec/chunks/symbols/files,
    resets counts + status `'pending'` + stamps new version) → normal
    auto-index path rebuilds from scratch at q8;
  - nothing indexed yet → just stamp the new version.
  Runs **before** the BDHLNDR-40 circuit breaker, and `clearIndexData` sets
  status `'pending'`, so a stale `'indexing'` can't be miscounted as a crash.
- `handleIndexingComplete()` stamps `EMBEDDING_VERSION` so a clean build
  records what it was built with.

Net upgrade behaviour: first index-open after updating detects v1→v2, wipes
the old fp32 vectors, and transparently re-indexes at q8 — no mixed vectors,
no user action.

## Acceptance mapping

- AC1 (q8, ~1300-file repo completes on arm64 w/ bounded memory): code in
  place; **needs the beta-bake repro to confirm empirically.**
- AC2 (auto re-index migration, no mixed vectors): implemented.
- AC3 (search relevance vs fp32 spot-check): **manual beta validation.**
- AC4 (beta bake before production): release routing — `development` flow.

## Verification

No test framework in repo (documented BDHLNDR-40 deviation). `build:main`
(tsc) + `build:worker` (esbuild) green; logic trace of the migration paths
(new index / upgraded index / nothing-indexed / breaker interaction).
Empirical memory + relevance validation happens on the beta channel (AC1/3).
