const fs = require('node:fs');
const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
const modules = fs.realpathSync(path.join(__dirname, 'node_modules'));
const sdk = path.dirname(require.resolve('@prevue/react-native'));
config.watchFolders = [...new Set([...config.watchFolders, modules, sdk])];
config.resolver.nodeModulesPaths = [modules, ...config.resolver.nodeModulesPaths];
module.exports = config;
