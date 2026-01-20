import { MemoryType, MemoryCreateInput } from '../../shared/types';
import { createMemory, findSimilarMemory } from '../repositories/memories';
import { BrowserWindow } from 'electron';

/**
 * Heuristic patterns for extracting memories from Claude's output.
 * Each pattern maps to a memory type and includes regex patterns to match.
 */
interface ExtractionPattern {
  type: MemoryType;
  patterns: RegExp[];
  // Minimum content length after extraction
  minLength: number;
}

const EXTRACTION_PATTERNS: ExtractionPattern[] = [
  {
    type: 'decision',
    patterns: [
      /I'll use\s+(.+?)(?:\.|$)/i,
      /Let's go with\s+(.+?)(?:\.|$)/i,
      /The approach (?:is|will be)\s+(.+?)(?:\.|$)/i,
      /I(?:'ve)? decide[d]? to\s+(.+?)(?:\.|$)/i,
      /We(?:'ll)? (?:should |will )?use\s+(.+?)(?:\.|$)/i,
      /I'm going to use\s+(.+?)(?:\.|$)/i,
      /The best (?:approach|solution|option) (?:is|would be)\s+(.+?)(?:\.|$)/i,
    ],
    minLength: 10,
  },
  {
    type: 'error_fix',
    patterns: [
      /Fixed (?:by|the issue by)\s+(.+?)(?:\.|$)/i,
      /The (?:issue|problem|bug) was\s+(.+?)(?:\.|$)/i,
      /Error resolved[:\s]+(.+?)(?:\.|$)/i,
      /The fix (?:is|was)\s+(.+?)(?:\.|$)/i,
      /Resolved by\s+(.+?)(?:\.|$)/i,
      /The root cause (?:is|was)\s+(.+?)(?:\.|$)/i,
      /This (?:error|issue|bug) (?:is|was) (?:caused by|due to)\s+(.+?)(?:\.|$)/i,
    ],
    minLength: 15,
  },
  {
    type: 'pattern',
    patterns: [
      /Always use\s+(.+?)(?:\.|$)/i,
      /Never use\s+(.+?)(?:\.|$)/i,
      /Convention[:\s]+(.+?)(?:\.|$)/i,
      /Best practice[:\s]+(.+?)(?:\.|$)/i,
      /The pattern (?:is|here is)\s+(.+?)(?:\.|$)/i,
      /(?:You|We) should always\s+(.+?)(?:\.|$)/i,
      /(?:You|We) should never\s+(.+?)(?:\.|$)/i,
      /Standard (?:approach|practice)[:\s]+(.+?)(?:\.|$)/i,
    ],
    minLength: 10,
  },
  {
    type: 'context',
    patterns: [
      /Remember[:\s]+(.+?)(?:\.|$)/i,
      /Important[:\s]+(.+?)(?:\.|$)/i,
      /Note to self[:\s]+(.+?)(?:\.|$)/i,
      /Keep in mind[:\s]+(.+?)(?:\.|$)/i,
      /Don't forget[:\s]+(.+?)(?:\.|$)/i,
      /I'll remember\s+(.+?)(?:\.|$)/i,
      /(?:I will|I'll) keep (?:that|this) in mind[:\s]*(.+?)(?:\.|$)/i,
      /For future reference[:\s]+(.+?)(?:\.|$)/i,
    ],
    minLength: 5,
  },
];

// Debounce tracking to avoid duplicate extractions
const recentExtractions = new Map<string, number>();
const DEBOUNCE_MS = 5000; // 5 seconds

/**
 * Extract memories from text using heuristic patterns.
 * Returns an array of potential memories to create.
 */
export function extractMemories(text: string): Array<{ type: MemoryType; content: string }> {
  const extracted: Array<{ type: MemoryType; content: string }> = [];

  for (const { type, patterns, minLength } of EXTRACTION_PATTERNS) {
    for (const pattern of patterns) {
      const matches = text.matchAll(new RegExp(pattern, 'gi'));
      for (const match of matches) {
        // Use the captured group if available, otherwise use full match
        let content = match[1] || match[0];
        content = content.trim();

        // Skip if too short
        if (content.length < minLength) continue;

        // Skip if content is just common filler
        if (isFillerContent(content)) continue;

        // Check debounce
        const key = `${type}:${content.toLowerCase()}`;
        const lastExtracted = recentExtractions.get(key);
        if (lastExtracted && Date.now() - lastExtracted < DEBOUNCE_MS) {
          continue;
        }

        extracted.push({ type, content });
        recentExtractions.set(key, Date.now());
      }
    }
  }

  // Clean up old debounce entries
  const now = Date.now();
  for (const [key, time] of recentExtractions.entries()) {
    if (now - time > DEBOUNCE_MS * 2) {
      recentExtractions.delete(key);
    }
  }

  return extracted;
}

/**
 * Check if content is just common filler that shouldn't be saved.
 */
function isFillerContent(content: string): boolean {
  const fillerPhrases = [
    'this',
    'that',
    'it',
    'the following',
    'as follows',
    'here',
    'there',
    'what you said',
    'your request',
  ];

  const lower = content.toLowerCase().trim();
  return fillerPhrases.includes(lower) || lower.length < 5;
}

/**
 * Process terminal output and create memories if patterns match.
 * This is called by the PTY manager when new output is received.
 */
export async function processOutputForMemories(
  output: string,
  sessionId: string,
  groupId: string
): Promise<void> {
  const extracted = extractMemories(output);

  for (const { type, content } of extracted) {
    // Check for duplicates using similarity search
    const existing = findSimilarMemory(content, groupId, type);
    if (existing) {
      console.log(`[Memory] Skipping duplicate: ${content.substring(0, 50)}...`);
      continue;
    }

    // Create the memory
    const input: MemoryCreateInput = {
      id: crypto.randomUUID(),
      sessionId,
      groupId,
      type,
      content,
      source: 'auto',
      tags: [],
      pinned: false,
    };

    try {
      const memory = createMemory(input);
      console.log(`[Memory] Auto-extracted (${type}): ${content.substring(0, 50)}...`);

      // Notify renderer about new memory
      const windows = BrowserWindow.getAllWindows();
      for (const win of windows) {
        win.webContents.send('memory:extracted', memory);
      }
    } catch (err) {
      console.error('[Memory] Failed to create auto-extracted memory:', err);
    }
  }
}

/**
 * Buffer for accumulating output before processing.
 * Helps ensure we capture complete sentences/thoughts.
 */
const outputBuffers = new Map<string, { text: string; timeout: NodeJS.Timeout | null }>();
const BUFFER_DELAY_MS = 500; // Wait for output to settle before processing

/**
 * Buffer output and process when settled.
 * This ensures we don't process incomplete sentences.
 */
export function bufferAndProcess(
  output: string,
  sessionId: string,
  groupId: string
): void {
  const key = sessionId;
  const existing = outputBuffers.get(key);

  if (existing?.timeout) {
    clearTimeout(existing.timeout);
  }

  const buffer = existing ? existing.text + output : output;

  // Limit buffer size to prevent memory issues
  const trimmedBuffer = buffer.length > 10000 ? buffer.slice(-10000) : buffer;

  const timeout = setTimeout(() => {
    processOutputForMemories(trimmedBuffer, sessionId, groupId);
    outputBuffers.delete(key);
  }, BUFFER_DELAY_MS);

  outputBuffers.set(key, { text: trimmedBuffer, timeout });
}

/**
 * Clean up buffers for a session when it ends.
 */
export function cleanupSession(sessionId: string): void {
  const existing = outputBuffers.get(sessionId);
  if (existing?.timeout) {
    clearTimeout(existing.timeout);
  }
  outputBuffers.delete(sessionId);
}
