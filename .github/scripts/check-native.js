/**
 * The postinstall produced a native module that actually works.
 *
 * Run by the `native-install` job in test.yml, which is the only thing on a
 * pull request that installs WITHOUT --ignore-scripts. It exists because a
 * postinstall that could not complete on a machine with no Visual Studio
 * stayed invisible until a run engine cut a fresh worktree and got exit 255
 * from `bun install` -- every PR check until then had skipped the script
 * entirely, and only a release build ever ran it.
 *
 * Loading is deliberately not the assertion. A binary built for the wrong ABI
 * can be present, resolve, and still fail at the first real call, so this
 * spawns a pty and reads its own output back off it. If that round trip
 * works, the module is usable by the app rather than merely on disk.
 */
const pty = require('node-pty');

const MARKER = 'native-module-ok';
const isWindows = process.platform === 'win32';
const [file, args] = isWindows
  ? [process.env.COMSPEC || 'cmd.exe', ['/c', 'echo', MARKER]]
  : ['/bin/sh', ['-c', `echo ${MARKER}`]];

const child = pty.spawn(file, args, { cols: 80, rows: 24 });

let output = '';
child.onData((data) => {
  output += data;
});

// A pty that never exits would otherwise hang the job until the step timeout,
// which reports as an infrastructure problem rather than as this failing.
const giveUp = setTimeout(() => {
  console.error(`FAIL: the pty produced no exit within 30s. Saw: ${JSON.stringify(output)}`);
  process.exit(1);
}, 30_000);

child.onExit(({ exitCode }) => {
  clearTimeout(giveUp);
  if (exitCode !== 0) {
    console.error(`FAIL: the pty exited ${exitCode}. Saw: ${JSON.stringify(output)}`);
    process.exit(1);
  }
  if (!output.includes(MARKER)) {
    // Present and loadable, but not carrying data. Exactly the shape a wrong
    // ABI or a half-copied conpty takes, and the reason loading alone is not
    // the assertion.
    console.error(`FAIL: the pty ran but "${MARKER}" never came back. Saw: ${JSON.stringify(output)}`);
    process.exit(1);
  }
  console.log(`ok: node-pty spawned a pty on ${process.platform} and read "${MARKER}" back`);
  // Explicit, because a pty holds the event loop open after its child is
  // gone. Without this the script prints its success and then hangs to the
  // step timeout, which reads as an infrastructure fault rather than a pass.
  process.exit(0);
});
