import { PreviewFailure } from './errors.ts';
import type { Platform } from './protocol.ts';

const usage: Record<string,string> = {
  doctor:'doctor [path]', show:'show <file> [--platform web|ios|android] [--device id] [--lang ko]',
  previews:'previews [file]', board:'board', focus:'focus <index> [--on|--off]', render:'render',
  wait:'wait [saved-file] [--after generation] [--timeout seconds]', status:'status',
  touch:'touch <x> <y>', scroll:'scroll [screens] [--direction up|down|left|right]', type:'type <text>',
  point:'point <x> <y> [--preview id]', selection:'selection', reset:'reset', open:'open [--lang ko] [--no-open]',
  log:'log [lines]', stop:'stop',
};
export function help(cmd?: string) {
  if (cmd && !usage[cmd]) throw new PreviewFailure('USAGE','Unknown command '+cmd,2);
  return ['prevue rn '+(cmd ? usage[cmd] : '<command> [--project path] [--platform web|ios|android]'),
    ...(cmd ? [] : Object.values(usage).map(s=>'  '+s)),
    'Use --project to choose the project from any directory. show starts the local runtime. open prints its private viewer URL.',
    'Responses are JSON. ready images have a matching generation and imageGeneration. wait --after waits for a newer committed generation.',
    'Exit 0 success, 1 render/input/wait failure, 2 usage, 3 unavailable runtime or project.'].join('\n');
}
export function parse(argv: string[]) {
  const [cmd = 'help', ...tokens] = argv;
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') return {help:help(tokens[0])} as const;
  if (tokens.includes('--help') || tokens.includes('-h')) return {help:help(cmd)} as const;
  if (!usage[cmd]) throw new PreviewFailure('USAGE','Unknown command '+cmd,2);
  const args: Record<string,unknown> = {}, pos: string[] = [];
  let project: string | undefined, platform: Platform | undefined, device: string | undefined, lang: string | undefined;
  let noOpen = false;
  const bad = () => new PreviewFailure('USAGE','Usage: prevue rn '+usage[cmd],2);
  for (let i=0;i<tokens.length;i++) {
    const t=tokens[i];
    if (t === '--') {pos.push(...tokens.slice(i+1));break;}
    if (t === '--project') project=tokens[++i] || (()=>{throw bad();})();
    else if (t === '--platform') {
      const v=tokens[++i]; if (v!=='web' && v!=='ios' && v!=='android') throw bad(); platform=v;
    } else if (t === '--device' && cmd==='show') {device=tokens[++i]; if (!device) throw bad();}
    else if (t === '--lang' && (cmd==='open' || cmd==='show')) {lang=tokens[++i]; if (!lang) throw bad();}
    else if ((t==='--on' || t==='--off') && cmd==='focus') args.interactive=t==='--on';
    else if ((t==='--after' || t==='--timeout') && cmd==='wait') {
      const v=Number(tokens[++i]); if (!Number.isFinite(v) || (t==='--after' && (!Number.isInteger(v) || v<0))) throw bad(); args[t.slice(2)]=v;
    } else if (t==='--direction' && cmd==='scroll') {args.direction=tokens[++i];if (!['up','down','left','right'].includes(String(args.direction))) throw bad();}
    else if (t==='--preview' && cmd==='point') {args.previewId=tokens[++i];if (!args.previewId) throw bad();}
    else if (t==='--no-open' && cmd==='open') noOpen=true;
    else if (t.startsWith('--')) throw bad();
    else pos.push(t);
  }
  const count=(min:number,max=min)=>{ if (pos.length<min || pos.length>max) throw bad(); };
  const num=(v:string)=>{const x=Number(v);if (!v || !Number.isFinite(x)) throw bad();return x;};
  switch (cmd) {
    case 'show': count(1);args.file=pos[0];break;
    case 'doctor': case 'wait': case 'previews': count(0,1);if(pos[0]) args.file=pos[0];break;
    case 'focus': count(1);args.index=num(pos[0]);if(!Number.isInteger(args.index) || Number(args.index)<0) throw bad();break;
    case 'point': case 'touch': count(2);args.x=num(pos[0]);args.y=num(pos[1]);break;
    case 'type': count(1);args.text=pos[0];break;
    case 'scroll': {
      count(0,1);const distance=(pos.length?num(pos[0]):1);
      const direction=args.direction ?? 'down'; delete args.direction;
      args.screens=distance; args.direction=direction; break;
    }
    case 'log': count(0,1);args.lines=pos.length?num(pos[0]):40;if (!Number.isInteger(args.lines)||Number(args.lines)<1||Number(args.lines)>10000) throw bad();break;
    default: count(0);
  }
  return {cmd,args,project,platform,device,lang,noOpen} as const;
}
