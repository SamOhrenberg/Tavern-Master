// Start the API, the worker and the web client together with labelled output.
//   npm run dev
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const SERVICES = [
  { name: 'api', script: 'dev:server', colour: 33 },
  { name: 'worker', script: 'dev:worker', colour: 35 },
  { name: 'web', script: 'dev:web', colour: 36 },
];

const children = [];
let stopping = false;

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode !== null || !child.pid) continue;
    // npm starts its own children; on Windows only taskkill reaches the whole tree.
    if (process.platform === 'win32')
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(code), 800);
}

for (const svc of SERVICES) {
  const child = spawn('npm', ['run', '--silent', svc.script], {
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_COLOR: '1' },
  });
  children.push(child);
  const label = `\u001b[${svc.colour}m${svc.name.padEnd(6)}\u001b[0m │ `;
  for (const stream of [child.stdout, child.stderr]) {
    createInterface({ input: stream }).on('line', (line) => process.stdout.write(`${label}${line}\n`));
  }
  child.on('exit', (code) => {
    if (stopping) return;
    process.stdout.write(`${label}exited with code ${code}; stopping the others\n`);
    stop(code ?? 1);
  });
}

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
