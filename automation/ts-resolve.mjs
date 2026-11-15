// Node resolve hook so the automation harnesses can run app TypeScript (src/lib/*.ts) directly with
// Node's built-in type stripping: app code imports siblings extensionless ('./structuredLight'),
// which Vite resolves but Node does not. Used via: node --import ./automation/ts-resolve.mjs …
import { registerHooks } from 'node:module';
registerHooks({
  resolve(spec, ctx, next) {
    try { return next(spec, ctx); }
    catch (e) { if ((spec.startsWith('.') || spec.startsWith('/')) && !/\.[cm]?[jt]s$/.test(spec)) return next(spec + '.ts', ctx); throw e; }
  },
});
