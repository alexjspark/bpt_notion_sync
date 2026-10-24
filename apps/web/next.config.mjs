import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export default {
  transpilePackages: ['@trainer/core', '@trainer/db', '@trainer/engine'],
  outputFileTracingRoot: root,
  turbopack: { root },
  poweredByHeader: false,
  // Node/tsx uses ESM .js specifiers in the shared TypeScript workspace.
  // Resolve those to source files when Next's webpack bundles the server routes.
  webpack(config) {
    config.resolve.extensionAlias = { ...config.resolve.extensionAlias, '.js': ['.ts', '.tsx', '.js'] };
    return config;
  },
};
