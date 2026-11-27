import type { PluginObj } from '@babel/core';
import type { types as Babel } from '@babel/core';

const localAsset = /^\.{1,2}\/.*\.(?:avif|gif|jpe?g|png|svg|webp|otf|ttf|woff2?|mp[34]|webm)$/i;

// Metro-style static assets share Vite's URL pipeline with normal ESM imports.
export function metroAssets({ types: t }: { types: typeof Babel }): PluginObj {
  return {
    name: 'prevue-static-assets',
    visitor: {
      CallExpression(path) {
        const { callee, arguments: args } = path.node;
        if (!t.isIdentifier(callee, { name: 'require' }) || path.scope.hasBinding('require') ||
            args.length !== 1 || !t.isStringLiteral(args[0]) || !localAsset.test(args[0].value)) return;
        const program = path.findParent(parent => parent.isProgram());
        if (!program?.isProgram()) return;
        const asset = program.scope.generateUidIdentifier('assetUrl');
        program.unshiftContainer('body', t.importDeclaration([t.importDefaultSpecifier(asset)], args[0]));
        path.replaceWith(t.cloneNode(asset));
      },
    },
  };
}
