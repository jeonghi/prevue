import { createHash } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { PreviewFailure } from './errors.ts';
import type { Platform } from './protocol.ts';

export interface Instance { key: string; url: string; token: string; pid: number; root: string; platform: Platform; device?: string; ownerLock?: 'sqlite' }
export function location(root: string, platform: Platform) {
  const key = createHash('sha256').update(root).update('\0').update(platform).digest('hex').slice(0,32);
  const parent = path.join(process.env.PREVUE_HOME ?? path.join(homedir(),'.prevue'), 'rn', createHash('sha256').update(root).digest('hex').slice(0,32));
  const dir = path.join(parent,platform);
  return {
    key, parent, dir, lock: path.join(dir, 'owner.sqlite'), pending: path.join(dir, 'starting-capture'),
    record: path.join(dir, 'instance.json'), log: path.join(dir, 'server.log'), active: path.join(parent, 'active'),
  };
}
export async function atomicWrite(file: string, content: string) {
  const tmp = file + '.' + process.pid + '.' + crypto.randomUUID();
  await writeFile(tmp,content,{mode:0o600,flag:'wx'});
  await rename(tmp,file);
}
export async function loadInstance(file: string): Promise<Instance | null> {
  try { return JSON.parse(await readFile(file,'utf8')); } catch { return null; }
}
type Health = 'ready' | 'unavailable' | 'unresponsive';
async function health(record: Instance | null, key: string): Promise<Health> {
  if (!record || record.key !== key || !/^http:\/\/127\.0\.0\.1:\d+$/.test(record.url)) return 'unavailable';
  if (!Number.isSafeInteger(record.pid) || record.pid <= 0) return 'unavailable';
  try { process.kill(record.pid, 0); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return 'unavailable'; }
  const signal = AbortSignal.timeout(2000);
  try {
    const identity = await fetch(record.url + '/identity', { redirect: 'error', signal });
    if (!identity.ok || (await identity.json()).key !== key) return 'unavailable';
    const response = await fetch(record.url + '/health', {
      headers: { authorization: 'Bearer ' + record.token }, redirect: 'error', signal,
    });
    // This endpoint belongs to the registered key. During startup or shutdown
    // it can return 503 before it can run authenticated commands.
    return response.ok && (await response.json()).key === key ? 'ready' : 'unresponsive';
  } catch {
    return signal.aborted ? 'unresponsive' : 'unavailable';
  }
}
export async function isAlive(record: Instance | null, key: string): Promise<boolean> {
  return await health(record, key) === 'ready';
}

export async function tryOwnership(file: string): Promise<(() => void) | undefined> {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file);
  try {
    // SQLite holds the OS file lock until close or process death, even if the
    // daemon is suspended. The lock file always keeps the same name and inode.
    db.exec('BEGIN EXCLUSIVE');
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      db.close();
    };
  } catch (error) {
    db.close();
    if ((error as { errcode?: number }).errcode === 5) return undefined; // SQLITE_BUSY
    throw error;
  }
}

export async function ownOrJoin(loc: ReturnType<typeof location>): Promise<{ release: () => void } | { existing: Instance }> {
  const deadline = performance.now() + 180000;
  for (;;) {
    const release = await tryOwnership(loc.lock);
    if (release) {
      try {
        const previous = await loadInstance(loc.record);
        // An upgraded installation can already have a daemon from before the
        // kernel lock existed. Its authenticated record remains authoritative.
        if (previous && !previous.ownerLock) {
          const state = await health(previous, loc.key);
          if (state === 'ready') { release(); return { existing: previous }; }
          if (state === 'unresponsive') throw new PreviewFailure('RUNTIME_UNAVAILABLE', 'The previously registered runtime is not responding.', 3);
        }
        return { release };
      } catch (error) {
        release();
        throw error;
      }
    }
    const record = await loadInstance(loc.record);
    if (record && await isAlive(record, loc.key)) return { existing: record };
    if (performance.now() >= deadline) throw new PreviewFailure('TIMEOUT', 'The project runtime is still starting. Read prevue rn log.', 3);
    await delay(100);
  }
}
export function portCandidate(key: string, attempt: number) { return 32000 + (parseInt(key.slice(0,8),16) + attempt) % 20000; }
