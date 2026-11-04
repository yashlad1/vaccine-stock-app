import { registerHooks } from 'node:module';

/**
 * src/ imports without file extensions, which Metro and Jest resolve and Node
 * does not. Teach Node the same three guesses, so a script reuses the app's
 * own tested code - the migration chain, restore, CSV - instead of a copy of
 * it that falls behind.
 *
 * Import this FIRST, then load src/ with `await import(...)`: every static
 * import is resolved before any module runs, so a hook registered by one
 * static import cannot help its siblings.
 */
registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (e) {
      if (!specifier.startsWith('.')) throw e;
      for (const ext of ['.ts', '.tsx', '/index.ts']) {
        try {
          return next(specifier + ext, context);
        } catch {
          // try the next guess
        }
      }
      throw e;
    }
  },
});
