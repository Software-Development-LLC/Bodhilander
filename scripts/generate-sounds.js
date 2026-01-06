#!/usr/bin/env node
/**
 * Generate simple notification sound WAV files
 * Each sound has a distinct character:
 * - waiting: gentle two-tone chime (attention needed)
 * - error: low descending tone (warning)
 * - start: rising tone (beginning)
 * - complete: pleasant ding (success)
 */

const fs = require('fs');
const path = require('path');

const SAMPLE_RATE = 44100;
const BITS_PER_SAMPLE = 16;
const NUM_CHANNELS = 1;

function generateSineWave(frequency, duration, volume = 0.5) {
  const numSamples = Math.floor(SAMPLE_RATE * duration);
  const samples = new Int16Array(numSamples);

  for (let i = 0; i < numSamples; i++) {
    const t = i / SAMPLE_RATE;
    // Apply envelope (fade in/out) to avoid clicks
    const envelope = Math.min(1, Math.min(t * 20, (duration - t) * 20));
    const sample = Math.sin(2 * Math.PI * frequency * t) * volume * envelope;
    samples[i] = Math.floor(sample * 32767);
  }

  return samples;
}

function generateTwoTone(freq1, freq2, duration, volume = 0.5) {
  const numSamples = Math.floor(SAMPLE_RATE * duration);
  const samples = new Int16Array(numSamples);
  const halfPoint = numSamples / 2;

  for (let i = 0; i < numSamples; i++) {
    const t = i / SAMPLE_RATE;
    const freq = i < halfPoint ? freq1 : freq2;
    const envelope = Math.min(1, Math.min(t * 20, (duration - t) * 20));
    const sample = Math.sin(2 * Math.PI * freq * t) * volume * envelope;
    samples[i] = Math.floor(sample * 32767);
  }

  return samples;
}

function generateSweep(startFreq, endFreq, duration, volume = 0.5) {
  const numSamples = Math.floor(SAMPLE_RATE * duration);
  const samples = new Int16Array(numSamples);

  for (let i = 0; i < numSamples; i++) {
    const t = i / SAMPLE_RATE;
    const progress = i / numSamples;
    const freq = startFreq + (endFreq - startFreq) * progress;
    const envelope = Math.min(1, Math.min(t * 20, (duration - t) * 20));
    const sample = Math.sin(2 * Math.PI * freq * t) * volume * envelope;
    samples[i] = Math.floor(sample * 32767);
  }

  return samples;
}

function generateChime(baseFreq, duration, volume = 0.5) {
  const numSamples = Math.floor(SAMPLE_RATE * duration);
  const samples = new Int16Array(numSamples);

  // Chime with harmonics and decay
  for (let i = 0; i < numSamples; i++) {
    const t = i / SAMPLE_RATE;
    const decay = Math.exp(-t * 4); // Exponential decay
    const envelope = Math.min(1, t * 50) * decay;

    // Fundamental + harmonics for bell-like sound
    const fundamental = Math.sin(2 * Math.PI * baseFreq * t);
    const harmonic2 = Math.sin(2 * Math.PI * baseFreq * 2 * t) * 0.5;
    const harmonic3 = Math.sin(2 * Math.PI * baseFreq * 3 * t) * 0.25;

    const sample = (fundamental + harmonic2 + harmonic3) / 1.75 * volume * envelope;
    samples[i] = Math.floor(sample * 32767);
  }

  return samples;
}

function createWavBuffer(samples) {
  const dataSize = samples.length * 2; // 16-bit = 2 bytes per sample
  const buffer = Buffer.alloc(44 + dataSize);

  // RIFF header
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);

  // fmt chunk
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // chunk size
  buffer.writeUInt16LE(1, 20); // audio format (PCM)
  buffer.writeUInt16LE(NUM_CHANNELS, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * NUM_CHANNELS * BITS_PER_SAMPLE / 8, 28); // byte rate
  buffer.writeUInt16LE(NUM_CHANNELS * BITS_PER_SAMPLE / 8, 32); // block align
  buffer.writeUInt16LE(BITS_PER_SAMPLE, 34);

  // data chunk
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  // Write samples
  for (let i = 0; i < samples.length; i++) {
    buffer.writeInt16LE(samples[i], 44 + i * 2);
  }

  return buffer;
}

function saveWav(filename, samples) {
  const buffer = createWavBuffer(samples);
  fs.writeFileSync(filename, buffer);
  console.log(`Created: ${filename} (${samples.length} samples, ${(samples.length / SAMPLE_RATE).toFixed(2)}s)`);
}

// Generate sounds
const outputDir = path.join(__dirname, '..', 'resources', 'sounds');

// Ensure output directory exists
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

// Waiting: gentle two-tone chime (C5 -> E5)
const waitingSamples = generateTwoTone(523, 659, 0.4, 0.4);
saveWav(path.join(outputDir, 'waiting.wav'), waitingSamples);

// Error: low descending tone (A3 -> E3)
const errorSamples = generateSweep(220, 165, 0.5, 0.4);
saveWav(path.join(outputDir, 'error.wav'), errorSamples);

// Start: rising tone (C4 -> G4)
const startSamples = generateSweep(262, 392, 0.3, 0.35);
saveWav(path.join(outputDir, 'start.wav'), startSamples);

// Complete: pleasant bell chime (G5)
const completeSamples = generateChime(784, 0.6, 0.4);
saveWav(path.join(outputDir, 'complete.wav'), completeSamples);

console.log('\nAll sounds generated successfully!');
