// Opt-in Windows stress for concurrent conpty teardown; not run in CI. Kills a
// batch of ptys in one tick and repeats. Surviving every round is the pass.
// Long runs exhaust memory on node-pty's per-pty worker leak, unrelated to this crash.
//   node scripts/stress-pty-teardown.cjs [rounds=30] [batch=12]
//   ./node_modules/.bin/electron scripts/stress-pty-teardown.cjs [rounds] [batch]
const pty = require('node-pty');

const rounds = Number(process.argv[2]) || 30;
const batch = Number(process.argv[3]) || 12;

if (process.platform !== 'win32') {
  console.log('SKIP: conpty teardown only exists on win32');
  process.exit(0);
}

function spawnOne() {
  const p = pty.spawn('cmd.exe', ['/c', 'ping -n 30 127.0.0.1 >nul'], {
    cols: 80,
    rows: 24,
    useConptyDll: true,
    conptyInheritCursor: false,
  });
  const exited = new Promise((resolve) => p.onExit(resolve));
  return { p, exited };
}

async function main() {
  const version = require('node-pty/package.json').version;
  console.log(`node-pty ${version}: ${rounds} rounds of ${batch} concurrent kills`);
  const started = Date.now();
  for (let round = 1; round <= rounds; round++) {
    const ptys = Array.from({ length: batch }, spawnOne);
    await new Promise((r) => setTimeout(r, 50));
    await Promise.all(ptys.map(async ({ p, exited }) => {
      p.kill();
      await exited;
    }));
    if (round % 25 === 0) console.log(`  round ${round}/${rounds}`);
  }
  console.log(`ok: ${rounds * batch} ptys torn down concurrently in ${Date.now() - started}ms`);
  process.exit(0);
}

main().catch((err) => {
  console.error('FAIL:', err);
  process.exit(1);
});
