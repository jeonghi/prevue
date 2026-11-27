import { basename, dirname } from 'node:path';
import type { Card, ViewerState } from '../../../../viewer-src/src/state.ts';
import type { PreviewDescriptor, RenderResult, Snapshot, ViewerHost } from '../protocol.ts';

export type ViewerSnapshot = Snapshot & { selectionPreviewId?: string; boardFocusId?: string };
type ArtifactUrl = ViewerHost['artifactUrl'];

export function platformPreviews(state: Snapshot) {
  return state.previews.filter(p => p.platforms.includes(state.platform));
}

export function freshness(result: RenderResult | undefined, generation: number): NonNullable<Card['freshness']> {
  const imageGeneration = result?.imagePath ? result.imageGeneration ?? result.generation : null;
  const status = imageGeneration !== null && imageGeneration !== generation ? 'stale' : result?.status ?? 'waiting';
  return { status, generation, imageGeneration };
}

function cardFor(preview: PreviewDescriptor, index: number, state: Snapshot, url: ArtifactUrl, focus: number): Card {
  const result = state.results[preview.id];
  const fresh = freshness(result, state.generation);
  const scale = preview.viewport?.pixelRatio ?? 1;
  const width = result?.width ? result.width / scale : preview.viewport?.width ?? null;
  const height = result?.height ? result.height / scale : preview.viewport?.height ?? null;
  const specs: Card['specs'] = [];
  if (width && height) specs.push({kind: 'viewport', text: `${width} × ${height} ${state.platform === 'web' ? 'CSS px' : state.platform === 'ios' ? 'pt' : 'dp'}`});
  if (preview.theme) specs.push({kind: preview.theme, text: preview.theme});
  if (fresh.imageGeneration !== null) specs.push({kind: 'generation', text: {t:'rn.generation', a:{n:fresh.imageGeneration}}});
  return {
    index, previewId: preview.id, functionName: preview.source.exportName, interactive:state.capabilities.interactiveInput,
    label: preview.name, title: `${preview.source.file}:${preview.source.line} · ${preview.source.exportName}`,
    args: '', specs, widthDp: width, heightDp: height, dpGuess: false,
    ok: result ? fresh.status === 'ready' : null, rendered: !!result, stale: fresh.status === 'stale',
    isFocus: index === focus, freshness: fresh,
    imageUrl: state.capabilities.screenshot && result?.imagePath ? url(result.imagePath) : null,
    treeUrl: state.capabilities.uiTree && fresh.status === 'ready' && result?.treePath ? url(result.treePath) : null,
    failure: result?.error?.message ?? null,
  };
}

export const platformLabel = (platform: Snapshot['platform']) =>
  ({ web:'RN Web', ios:'RN iOS', android:'RN Android' })[platform];

function selectionOf(state: ViewerSnapshot, url: ArtifactUrl): ViewerState['selection'] {
  const node = state.selection;
  const preview = state.previews.find(p => p.id === state.selectionPreviewId);
  if (!node || !preview) return null;
  const result = state.results[preview.id];
  const { file, line } = node.source ?? {file:null, line:null};
  const {x, y, width:w, height:h} = node.bounds;
  return {
    ok:true, node:node.name, nodeId:node.id, file, line, ref:file && line ? `@${file}#L${line}` : null,
    bounds:{x, y, w, h}, chain:[], userChain:[],
    preview:{previewId:preview.id, file:preview.source.file, fqn:preview.source.exportName, params:{}, methodParams:[],
      index:platformPreviews(state).filter(p => p.source.file === preview.source.file).findIndex(p => p.id === preview.id)},
    image:result?.imagePath ? url(result.imagePath) : null, tree:result?.treePath ? url(result.treePath) : null,
    interactive:state.interactive && preview.id === state.focusId,
  };
}

export function viewerState(state: ViewerSnapshot, url: ArtifactUrl): ViewerState {
  const all = platformPreviews(state);
  const previews = all.filter(p => p.source.file === state.activeFile);
  const focusIndex = previews.findIndex(p => p.id === state.focusId);
  const boardFocus = focusIndex >= 0 ? focusIndex : Math.max(0, previews.findIndex(p => p.id === state.boardFocusId));
  const cards = previews.map((p, i) => cardFor(p, i, state, url, boardFocus));
  const preview = previews[focusIndex], card = cards[focusIndex];
  const result = preview && state.results[preview.id];
  const interactive = state.interactive && state.capabilities.interactiveInput && !!card?.ok;
  const focus = preview && card ? {
    previewId:preview.id, interactive, name:preview.name, fn:preview.source.exportName,
    pxPerDp:preview.viewport?.pixelRatio ?? 1, imageUrl:card.imageUrl || '', treeUrl:card.treeUrl || '',
    streamUrl:interactive && result?.sessionId && card.ok && card.imageUrl
      ? '/stream?' + new URLSearchParams({preview:preview.id, session:result.sessionId, generation:String(state.generation)}) : '',
    size:null, systemUi:null, deviceInsets:null, postures:[],
  } : null;
  const repoLeaf = basename(state.projectRoot);
  const fileName = state.activeFile && basename(state.activeFile);
  const label = platformLabel(state.platform);
  const stale = cards.filter(c => c.stale).map(c => ({
    head:{t:'rn.stale', a:{name:c.label, image:c.freshness!.imageGeneration, current:state.generation}},
    why:c.failure ? [c.failure] : [],
  }));
  const timing = cards.flatMap(c => {
    const r = state.results[c.previewId];
    return c.ok && r ? [{label:c.label, ms:r.durationMs, over:false, text:`${Math.round(r.durationMs)} ms`, head:false}] : [];
  });
  if (timing.length) (timing.find(t => t.label === preview?.name) ?? timing[0]).head = true;
  return {
    version:state.version,
    runtime:{framework:'react-native', platform:state.platform, label, capabilities:state.capabilities, generation:state.generation},
    header:{title:repoLeaf, tabTitle:fileName ?? repoLeaf, repoPrefix:dirname(state.projectRoot), repoLeaf,
      module:'', variant:label, repo:state.projectRoot, branch:null, sourceSet:null},
    screen:focus ? 'focus' : previews.length ? 'board' : state.activeFile ? 'vacant' : 'empty',
    board:state.activeFile && fileName && cards.length ? {
      file:state.activeFile, gen:state.generation, focus:boardFocus,
      groups:[{name:fileName, cards, failed:cards.filter(c => c.failure).length}],
    } : null,
    focus, stale, busy:state.busy, buildPending:false,
    boardNote:state.busy ? {t:'status.rendering'} : fileName ? {t:'status.board', a:{n:cards.length, file:fileName}} : null,
    who:null, timing, error:state.error?.message ?? card?.failure ?? null, selection:selectionOf(state, url), choice:null,
    tabs:state.tabs.map(key => ({ key, name:basename(key), dim:'', module:null, sourceSet:null, title:key,
      active:key === state.activeFile, stale:all.some(p => p.source.file === key && freshness(state.results[p.id], state.generation).status === 'stale') })),
    settle:null, vacant:state.activeFile && !cards.length ? {t:'quickopen.none'} : null,
  };
}
