/**
 * Stub module for 'sharp' - used by @huggingface/transformers for image processing.
 * Since we only use text embeddings (not vision models), we don't need sharp.
 * This stub prevents the worker from crashing when sharp is required.
 */

// Return a function that throws a helpful error if actually called
function sharpStub() {
  throw new Error(
    'sharp is not available - image processing is disabled. ' +
    'ClaudeLander only supports text embeddings.'
  );
}

// Add common sharp methods as stubs
sharpStub.cache = () => {};
sharpStub.concurrency = () => {};
sharpStub.counters = () => ({});
sharpStub.simd = () => false;
sharpStub.versions = { sharp: 'stub' };

module.exports = sharpStub;
module.exports.default = sharpStub;
