import React from 'react';

/**
 * EAS Observe, made optional at runtime.
 *
 * `expo-observe` is a native module: importing it calls `requireNativeModule`
 * at module scope, so in a binary that does not contain it the import itself
 * throws and the whole app fails to start - which is what happened. Expo Go
 * does not contain it, and section 4 makes Expo Go the entire dev loop on this
 * project: no emulator system image was even complete until today, and there
 * is no local JDK 17.
 *
 * So this detects the MODULE rather than the environment. Checking for Expo Go
 * specifically would also disable Observe inside a development build, which
 * does ship the native module and is exactly where you would want metrics
 * while testing. A try/catch answers the only question that matters: is it
 * actually here?
 *
 * In Expo Go the two exports below become no-ops. Nothing else in the app
 * knows the difference.
 */

type ObserveModule = typeof import('expo-observe');

let mod: ObserveModule | null = null;
try {
  mod = require('expo-observe') as ObserveModule;
  mod.Observe.configure({
    integrations: {
      // Route NAMES are the useful part and they still come through; the
      // resolved URL is dropped, so no row id from this clinic's database
      // leaves the phone in a metric. Section 13 does not stop at the repo.
      'expo-router': { filteredParams: ['vaccineId', 'id'] },
    },
  });
} catch {
  mod = null;
}

/** Marks time-to-interactive. Renders nothing, here or in Expo Go. */
export function InteractiveMarker() {
  return mod ? <mod.ObserveInteractiveMarker /> : null;
}

/** Wraps the root so first render is timed. Identity function without Observe. */
export function withObserve<P extends Record<string, unknown>>(
  Component: React.ComponentType<P>,
): React.ComponentType<P> {
  return mod ? mod.ObserveRoot.wrap(Component) : Component;
}
