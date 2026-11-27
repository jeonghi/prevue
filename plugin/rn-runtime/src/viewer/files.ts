import { opendir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { PreviewDescriptor, Snapshot, ViewerHost } from '../protocol.ts';
import { freshness, platformPreviews } from './state.ts';

const skipped = new Set(['node_modules', 'Pods', 'build', 'dist', 'coverage', 'vendor', 'DerivedData']);
export async function projectFiles(root: string) {
  const files: Record<string, string[]> = Object.create(null);
  async function visit(relative: string) {
    const dir = await opendir(path.join(root, relative));
    for await (const entry of dir) {
      const file = relative ? relative + '/' + entry.name : entry.name;
      if (entry.isDirectory() && !entry.name.startsWith('.') && !skipped.has(entry.name)) await visit(file);
      else if (entry.isFile() && /\.(?:[cm]?[jt]s|[jt]sx)$/.test(entry.name)) (files[entry.name] ??= []).push(file);
    }
  }
  await visit('');
  for (const paths of Object.values(files)) paths.sort();
  return {root, roots:['.'], files};
}

export function galleryCard(previews: PreviewDescriptor[], state: Snapshot, url: ViewerHost['artifactUrl']) {
  const front: {i:number; name:string; variant:string; image:{url:string; w:number; h:number; stale:boolean}}[] = [];
  let failure: string | null = null;
  for (const [i, p] of previews.entries()) {
    const r = state.results[p.id];
    if (!r) continue;
    failure ??= r.error?.message ?? null;
    if (r.imagePath && front.length < 3) {
      front.push({i, name:p.source.exportName, variant:p.name, image:{url:url(r.imagePath), w:r.width, h:r.height,
        stale:freshness(r, state.generation).status === 'stale'}});
    }
  }
  return {sheets:previews.length, front, failure};
}

export async function previewFiles(state: Snapshot, url: ViewerHost['artifactUrl']) {
  const groups = new Map<string, PreviewDescriptor[]>();
  for (const p of platformPreviews(state)) {
    const group = groups.get(p.source.file);
    if (group) group.push(p); else groups.set(p.source.file, [p]);
  }
  const files = await Promise.all(Array.from(groups, async ([file, previews]) => {
    const cached = previews.every(p => state.results[p.id]?.generation === state.generation);
    const functions = previews.map(p => p.source.exportName);
    const mtime = await stat(path.join(state.projectRoot, file)).then(s => s.mtimeMs, () => 0);
    return {path:file, rel:file, module:'', mtime, revision:state.generation, functions,
      previews:functions.map(fn => ({fn, calls:[]})), shots:cached ? galleryCard(previews, state, url) : null};
  }));
  return {ready:true, files, composables:[]};
}
