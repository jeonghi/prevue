import { createHash } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { Platform } from './protocol.ts';

export interface Instance { key: string; url: string; token: string; pid: number; root: string; platform: Platform; device?: string }
export function location(root: string, platform: Platform) {
  const key = createHash('sha256').update(root).update('\0').update(platform).digest('hex').slice(0,32);
  const parent = path.join(process.env.PREVUE_HOME ?? path.join(homedir(),'.prevue'), 'rn', createHash('sha256').update(root).digest('hex').slice(0,32));
  const dir = path.join(parent,platform);
  return {key, parent, dir, record:path.join(dir,'instance.json'), log:path.join(dir,'server.log'), active:path.join(parent,'active')};
}
export async function atomicWrite(file: string, content: string) {
  const tmp = file + '.' + process.pid + '.' + crypto.randomUUID();
  await writeFile(tmp,content,{mode:0o600,flag:'wx'});
  await rename(tmp,file);
}
export async function loadInstance(file: string): Promise<Instance | null> {
  try { return JSON.parse(await readFile(file,'utf8')); } catch { return null; }
}
export async function isAlive(record: Instance | null, key: string): Promise<boolean> {
  if (!record || record.key !== key || !/^http:\/\/127\.0\.0\.1:\d+$/.test(record.url)) return false;
  try {
    const res = await fetch(record.url+'/health',{headers:{authorization:'Bearer '+record.token},signal:AbortSignal.timeout(2000)});
    return res.ok && (await res.json()).key === key;
  } catch { return false; }
}
export function portCandidate(key: string, attempt: number) { return 32000 + (parseInt(key.slice(0,8),16) + attempt) % 20000; }
