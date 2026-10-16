/**
 * Bundle entry of the Claude Desktop extension. Starts unconditionally: Claude
 * Desktop's built-in Node loads this file through its own wrapper, so it is
 * never `require.main`.
 */
import { serve } from './index';

serve({
  input: process.stdin,
  write: (line) => process.stdout.write(line),
  log: (line) => process.stderr.write(line),
  done: () => process.exit(0),
});
