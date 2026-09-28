import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export function parseLsof(output) {
  let pid = null;
  const sockets = [];
  for (const line of output.trim().split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    if (line.startsWith('n')) sockets.push({ pid, address: line.slice(1) });
  }
  return sockets;
}

export function parseSs(output) {
  return output.trim().split('\n').filter(Boolean).flatMap((line) => {
    const fields = line.trim().split(/\s+/);
    if (fields[0] !== 'LISTEN' || fields.length < 5) {
      throw new Error(`Unrecognized ss listener: ${line}`);
    }
    const pids = [...line.matchAll(/\bpid=(\d+)/g)].map((m) => Number(m[1]));
    // Keep sockets whose owner is hidden: they still count against loopback
    // isolation and shutdown, but must never supply a PID to process.kill().
    return (pids.length ? pids : [null]).map((pid) => ({ pid, address: fields[3] }));
  });
}

export function listeners(port, platform = process.platform, run = execFileSync) {
  const options = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };
  if (platform === 'linux') {
    return parseSs(run('ss', ['-H', '-ltnp', `sport = :${port}`], options));
  }
  try {
    return parseLsof(run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpn'], options));
  } catch (error) {
    // lsof exits 1 when nothing matches. Missing tools and other failures
    // must not masquerade as proof that the server stopped.
    if (error.status === 1 && !String(error.stdout ?? '').trim() && !String(error.stderr ?? '').trim()) return [];
    throw error;
  }
}

export function listenerPid(sockets) {
  const pids = [...new Set(sockets.map((socket) => socket.pid))];
  if (pids.length !== 1 || !Number.isSafeInteger(pids[0]) || pids[0] <= 1) {
    throw new Error(`Expected one identifiable server PID: ${JSON.stringify(sockets)}`);
  }
  return pids[0];
}

export function rssMb(pid) {
  try {
    if (process.platform === 'linux') {
      const status = readFileSync(`/proc/${pid}/status`, 'utf8');
      const rss = status.match(/^VmRSS:\s+(\d+)\s+kB$/m);
      return rss ? Number(rss[1]) / 1024 : null;
    }
    const rss = execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    return rss ? Number(rss) / 1024 : null;
  } catch {
    return null;
  }
}

export function alive(pid) {
  try {
    if (process.platform === 'linux') {
      // An orphan can briefly be a zombie until init reaps it. It has stopped
      // running and released its sockets; kill(pid, 0) alone still says alive.
      return !/^State:\s+Z\b/m.test(readFileSync(`/proc/${pid}/status`, 'utf8'));
    }
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH' || error.code === 'ENOENT') return false;
    throw error;
  }
}
