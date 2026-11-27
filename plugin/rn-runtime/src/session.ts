import { EventEmitter } from 'node:events';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { discover } from './registry.ts';
import { errorInfo, numberArg, PreviewFailure, requireString } from './errors.ts';
import type { Interaction, Platform, PreviewDescriptor, PreviewRenderer, PreviewSession, RenderResult, Snapshot, UINode, UITree } from './protocol.ts';

type Args = Record<string, unknown>;
export class ProjectSession {
  readonly state: Snapshot;
  private events = new EventEmitter();
  private tail: Promise<unknown> = Promise.resolve();
  private live?: PreviewSession;
  private liveGeneration = 0;
  private closed = false;
  private changedAt = new Map<string, number>();
  private bootAt = Date.now();
  private settled = 0;

  constructor(readonly root: string, readonly platform: Platform, readonly renderer: PreviewRenderer) {
    this.state = {
      projectRoot: root, version: 1, generation: 1, platform, capabilities: renderer.capabilities(),
      previews: [], results: {}, tabs: [], activeFile: null, focusId: null, interactive: false,
      busy: false, error: null, selection: null,
    };
    this.events.setMaxListeners(0);
  }

  async init(artifacts: string, device?: string) {
    await this.renderer.prepare({ root: this.root, artifacts, platform: this.platform, device, changed: file => this.changed(file) });
    await this.registry();
    this.settled = this.state.generation;
  }
  subscribe = (listener: () => void) => {
    this.events.on('state', listener);
    return () => { this.events.off('state', listener); };
  };
  private publish() { this.state.version++; this.events.emit('state'); }
  private run<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.tail.then(fn);
    this.tail = task.catch(() => {});
    return task;
  }
  private async registry() {
    const previews = await discover(this.root);
    this.state.previews = previews;
    const files = new Set(previews.map(item => item.source.file));
    const ids = new Set(previews.map(item => item.id));
    this.state.tabs = this.state.tabs.filter(file => files.has(file));
    if (this.state.activeFile && !files.has(this.state.activeFile)) this.state.activeFile = this.state.tabs.at(-1) ?? null;
    if (this.state.focusId && !ids.has(this.state.focusId)) await this.exitFocus();
    for (const id of Object.keys(this.state.results)) if (!ids.has(id)) delete this.state.results[id];
  }
  private changed(file: string) {
    if (this.closed) return;
    const gen = ++this.state.generation;
    void stat(file).then(s => this.changedAt.set(path.resolve(file), Math.max(this.changedAt.get(path.resolve(file)) ?? 0, s.mtimeMs)), () => {});
    this.state.busy = true;
    this.clearSelection();
    this.state.error = null;
    for (const result of Object.values(this.state.results)) {
      if (result.imagePath) result.status = 'stale';
    }
    this.publish();
    void this.run(async () => {
      if (this.closed || gen !== this.state.generation) return;
      try {
        await this.registry();
        if (this.state.activeFile) await this.cards(this.state.activeFile, gen);
        if (this.live && this.state.focusId) await this.updateLive(gen);
      } catch (err) {
        this.failActive(gen, err);
      } finally {
        if (gen === this.state.generation) {
          this.settled = gen;
          this.state.busy = false;
          this.publish();
        }
      }
    });
  }
  private failActive(gen: number, err: unknown) {
    if (this.state.generation !== gen) return;
    this.state.error = errorInfo(err);
    for (const preview of this.forFile(this.state.activeFile)) this.recordFailure(preview, gen, err);
  }
  private recordFailure(preview: PreviewDescriptor, gen: number, err: unknown) {
    const prev = this.state.results[preview.id];
    this.state.results[preview.id] = {
      previewId: preview.id, sessionId: prev?.sessionId ?? '', platform: this.platform, generation: gen,
      width: prev?.width ?? 0, height: prev?.height ?? 0, durationMs: 0, warnings: [],
      ...(prev?.imagePath ? { imagePath: prev.imagePath, imageGeneration: prev.imageGeneration ?? prev.generation } : {}),
      status: prev?.imagePath ? 'stale' : 'error', error: errorInfo(err),
    };
  }
  private forFile(file: string | null) { return this.state.previews.filter(p => p.source.file === file && p.platforms.includes(this.platform)); }
  private async relative(value: unknown) {
    const supplied = requireString(value, 'file');
    const absolute = await realpath(path.resolve(this.root, supplied)).catch(() => { throw new PreviewFailure('PREVIEW_NOT_FOUND', supplied); });
    const relative = path.relative(this.root, absolute);
    if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) throw new PreviewFailure('OUTSIDE_PROJECT', 'File is outside this project');
    return relative.split(path.sep).join('/');
  }
  private save(preview: PreviewDescriptor, generation: number, result: RenderResult) {
    if (generation !== this.state.generation) return;
    if (result.generation !== generation || result.previewId !== preview.id || result.platform !== this.platform ||
        (result.imageGeneration !== undefined && result.imageGeneration !== generation)) {
      throw new PreviewFailure('STALE_RENDER', 'Renderer response did not acknowledge the requested preview and generation');
    }
    if (result.status !== 'ready' || !result.imagePath) {
      throw new PreviewFailure(result.error?.code ?? 'RUNTIME_FAILED', result.error?.message ?? 'Renderer did not return a ready screenshot');
    }
    this.state.results[preview.id] = {...result, imageGeneration: generation};
  }
  private async cards(file: string, generation: number, force = false) {
    const all = this.forFile(file);
    const pending = all.filter(p => {
      if (this.live && p.id === this.state.focusId) return false;
      const result = this.state.results[p.id];
      return force || result?.status !== 'ready' || result.generation !== generation;
    });
    const work = async () => {
      while (pending.length && generation === this.state.generation && !this.closed) {
        const preview = pending.shift()!;
        try { this.save(preview, generation, await this.renderer.render({preview, generation})); }
        catch (error) { if (generation === this.state.generation) this.recordFailure(preview, generation, error); }
      }
    };
    await Promise.all(Array.from({length: Math.min(pending.length, this.platform === 'web' ? 2 : 1)}, work));
  }
  private async exitFocus() {
    const live = this.live;
    this.live = undefined;
    this.liveGeneration = 0;
    this.state.interactive = false;
    this.state.focusId = null;
    this.clearSelection();
    if (live) {
      const prior = Object.values(this.state.results).find(r => r.sessionId === live.id);
      if (prior) delete this.state.results[prior.previewId];
      await live.close();
    }
  }
  private clearSelection() { this.state.selection = null; this.state.selectionPreviewId = undefined; }
  private async updateLive(generation: number, force = false) {
    const preview = this.state.previews.find(p => p.id === this.state.focusId);
    if (!preview || !this.live) return;
    try {
      const result = force || this.liveGeneration === generation ? await this.live.capture() : await this.live.update({preview, generation});
      this.save(preview, generation, result);
      if (generation === this.state.generation) this.liveGeneration = generation;
    } catch (err) {
      if (generation === this.state.generation) this.recordFailure(preview, generation, err);
    }
  }
  private board(file = this.state.activeFile) {
    const previews = this.forFile(file);
    const cards = previews.map(p => ({...this.state.results[p.id], name: p.name, previewId: p.id}));
    const ok = !!previews.length && cards.every(r => r.status === 'ready' && r.generation === this.state.generation);
    return {ok, complete: ok, file, generation: this.state.generation, platform: this.platform, cards,
      ...(ok ? {} : {error: this.state.error ?? cards.find(r => r.error)?.error ?? {code:'STALE_RENDER',message:'No current board capture'}})};
  }

  private async wait(args: Args) {
    const timeout = numberArg(args.timeout ?? 30, 'timeout');
    if (timeout <= 0 || timeout > 120) throw new PreviewFailure('USAGE', 'timeout must be in (0, 120] seconds', 2);
    const after = args.after === undefined ? 0 : numberArg(args.after, 'after');
    const requestedFile = args.file ? path.resolve(this.root, await this.relative(args.file)) : undefined;
    const mtime = requestedFile ? (await stat(requestedFile)).mtimeMs : 0;
    const ready = () => !this.state.busy && this.settled >= this.state.generation && this.settled > after &&
      (!requestedFile || mtime <= this.bootAt || (this.changedAt.get(requestedFile) ?? -1) >= mtime);
    if (!ready()) await new Promise<void>((resolve,reject) => {
      const done = () => { clearTimeout(timer); unsubscribe(); };
      const unsubscribe = this.subscribe(() => { if (ready()) { done(); resolve(); } });
      const timer = setTimeout(() => { done(); reject(new PreviewFailure('TIMEOUT', 'No committed render for the requested save before deadline')); }, timeout * 1000);
    });
    return this.board();
  }
  async execute(command: string, args: Args): Promise<unknown> {
    if (command === 'wait') return this.wait(args);
    if (command === 'status') return {ok:true, ...this.state};
    if (command === 'previews') return {ok:true, previews:this.state.previews};
    if (command === 'selection') {
      if (!this.state.selection) throw new PreviewFailure('NO_SELECTION','Point at a rendered element first');
      return this.selectionReply();
    }
    if (command === 'board') return this.board();
    return this.run(async () => {
      try { return await this.mutate(command, args); }
      finally { this.publish(); }
    });
  }
  private selectionReply() {
    const node = this.state.selection!;
    return {ok:true, node, previewId:this.state.selectionPreviewId, ref:node.source ? '@' + node.source.file + '#L' + node.source.line : null};
  }
  private async point(args: Args) {
    const previewId = typeof args.previewId === 'string' ? args.previewId : this.state.focusId;
    const result = previewId && this.state.results[previewId];
    if (!result || !result.treePath || result.status !== 'ready' || result.generation !== this.state.generation) {
      throw new PreviewFailure('NO_CURRENT_TREE', 'Select a preview with a current UI tree');
    }
    if (args.treePath !== undefined && args.treePath !== result.treePath) {
      throw new PreviewFailure('STALE_RENDER','The selected image changed before the selection arrived');
    }
    const tree: UITree = JSON.parse(await readFile(result.treePath,'utf8'));
    const nodes: UINode[] = [];
    function visit(node: UINode) { nodes.push(node); node.children.forEach(visit); }
    tree.nodes.forEach(visit);
    let found: UINode | undefined;
    if (typeof args.nodeId === 'string') found = nodes.find(n => n.id === args.nodeId);
    else if (typeof args.x === 'number' && typeof args.y === 'number') {
      const {x,y} = args;
      found = nodes.reverse().find(({bounds:b}) => x >= b.x && y >= b.y && x < b.x+b.width && y < b.y+b.height);
    } else if (typeof args.file === 'string' && typeof args.line === 'number') {
      const file = await this.relative(args.file);
      const matches = nodes.filter(n => n.source?.file === file && n.source.line === args.line);
      if (matches.length === 1) found = matches[0];
    }
    if (!found) throw new PreviewFailure('NO_SELECTION','No unambiguous element at that location');
    this.state.selection = found; this.state.selectionPreviewId = previewId || undefined;
    return this.selectionReply();
  }
  private async mutate(command: string, args: Args): Promise<unknown> {
    const s = this.state;
    const generation = s.generation;
    if (command === 'point') return this.point(args);
    if (command === 'show' || command === 'gallery' || command === 'tab') {
      const file = await this.relative(args.file);
      if (!this.forFile(file).length) throw new PreviewFailure('PREVIEW_NOT_FOUND','No ' + this.platform + ' preview in ' + file);
      if (command !== 'gallery') {
        await this.exitFocus();
        if (!s.tabs.includes(file)) s.tabs.push(file);
        s.activeFile = file;
      }
      await this.cards(file, generation);
      return this.board(file);
    }
    if (command === 'close') {
      const file = await this.relative(args.file);
      s.tabs = s.tabs.filter(f => f !== file);
      if (s.activeFile === file) { await this.exitFocus(); s.activeFile = s.tabs.at(-1) ?? null; }
      if (s.activeFile) await this.cards(s.activeFile, generation);
      return {ok:true};
    }
    if (command === 'exit' || command === 'focus' && args.interactive === false) {
      await this.exitFocus();
      if (s.activeFile) await this.cards(s.activeFile, generation);
      return {ok:true};
    }
    if (!s.activeFile) throw new PreviewFailure('PREVIEW_NOT_FOUND','Open a preview file with show first');
    if (command === 'focus') {
      const index = numberArg(args.index ?? 0, 'index');
      const preview = this.forFile(s.activeFile)[index];
      if (!preview) throw new PreviewFailure('PREVIEW_NOT_FOUND','Preview index is outside the board',2);
      await this.exitFocus();
      this.live = await this.renderer.openSession({preview,generation});
      s.focusId = preview.id; s.boardFocusId = preview.id; s.interactive = true; this.liveGeneration = generation;
      await this.updateLive(generation);
      return this.focusReply();
    }
    if (command === 'render') {
      if (this.live) { await this.updateLive(generation); return this.focusReply(); }
      await this.cards(s.activeFile, generation, true);
      return this.board();
    }
    if (!this.live) throw new PreviewFailure('SESSION_REQUIRED','Open an interactive preview with focus <index> --on');
    if (command === 'reset') await this.live.reset();
    else {
      let input: Interaction;
      if (command === 'type') input = {type:'text', text: typeof args.text === 'string' ? args.text : requireString(args.text,'text')};
      else if (command === 'scroll') {
        const frame = this.state.results[this.state.focusId!];
        const amount = numberArg(args.screens ?? 1,'screens'), dir = args.direction ?? 'down';
        const horizontal = dir === 'left' || dir === 'right';
        input = {type:'scroll', dx:numberArg(args.dx ?? (horizontal ? (dir === 'left' ? -1 : 1)*amount*frame.width : 0),'dx'),
          dy:numberArg(args.dy ?? (horizontal ? 0 : (dir === 'up' ? -1 : 1)*amount*frame.height),'dy'),
          ...(args.x === undefined ? {} : {x:numberArg(args.x,'x'), y:numberArg(args.y,'y')})};
      }
      else if (command === 'touch') {
        const type = args.type ?? 'tap';
        if (type !== 'tap' && type !== 'press' && type !== 'drag' && type !== 'release') throw new PreviewFailure('UNSUPPORTED_INPUT','Unsupported touch type',2);
        input = { type, x:numberArg(args.x,'x'), y:numberArg(args.y,'y') };
      } else throw new PreviewFailure('UNSUPPORTED_COMMAND','Unsupported RN command: ' + command,2);
      await this.live.dispatch(input);
    }
    this.clearSelection();
    await this.updateLive(generation);
    return this.focusReply();
  }
  private focusReply() {
    const result = this.state.results[this.state.focusId!];
    return {ok:result?.status === 'ready' && result.generation === this.state.generation, ...result};
  }
  async dispose() {
    this.closed = true;
    await this.tail;
    await this.exitFocus();
    await this.renderer.dispose();
  }
}
