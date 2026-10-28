import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Animated, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { T } from './components';
import { color, radius, space, touch, type, weight } from './tokens';

/**
 * UNDO REPLACES CONFIRMATION.
 *
 * There are no confirmation dialogs on the dose path. A confirm dialog on the
 * common path trains people to tap through confirms, which destroys its value
 * on the rare path where it actually matters. So the write happens immediately
 * and this snackbar is the confirmation.
 *
 * The 3.5 seconds are only the FAST path. Because undo is a reversing ledger
 * entry rather than a delete, the same correction stays available forever from
 * the Ledger screen.
 */

/**
 * Short on purpose. Long enough to notice a mistake and reach for it, short
 * enough that it is not sitting over the grid while she moves to the next
 * child.
 *
 * The cost of being brief is low: undo writes a reversing ledger entry rather
 * than deleting, so the SAME correction stays available indefinitely from the
 * All-entries screen. This toast is only the fast path.
 */
const UNDO_MS = 3500;

/**
 * An error toast stays up longer and is not dismissed by a success haptic.
 * A failed write is the one message she must not miss - if she misses it she
 * will assume the dose was recorded, and recorded stock starts drifting from
 * the fridge, which is the whole failure this app exists to prevent.
 */
const ERROR_MS = 7000;

interface Toast {
  message: string;
  onUndo?: () => void | Promise<void>;
  tone?: 'default' | 'error';
}

interface UndoApi {
  show: (message: string, onUndo?: () => void | Promise<void>) => void;
  /** A failure. Longer, red, warning haptic, and never carries an undo. */
  showError: (message: string) => void;
}

const UndoContext = createContext<UndoApi | null>(null);

export function useToast(): UndoApi {
  const ctx = useContext(UndoContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toast, setToast] = useState<Toast | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const opacity = useRef(new Animated.Value(0)).current;

  const hide = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    Animated.timing(opacity, { toValue: 0, duration: 150, useNativeDriver: true }).start(({ finished }) => {
      // A show() during the fade stops this animation (finished = false); it
      // must not clear the toast that replaced this one.
      if (finished) setToast(null);
    });
  }, [opacity]);

  const show = useCallback(
    (message: string, onUndo?: () => void | Promise<void>) => {
      if (timer.current) clearTimeout(timer.current);
      setToast({ message, onUndo });
      // Haptic confirmation matters because she is often not looking at the
      // screen when her thumb lands.
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
      Animated.timing(opacity, { toValue: 1, duration: 150, useNativeDriver: true }).start();
      timer.current = setTimeout(hide, UNDO_MS);
    },
    [hide, opacity],
  );

  const showError = useCallback(
    (message: string) => {
      if (timer.current) clearTimeout(timer.current);
      setToast({ message, tone: 'error' });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => undefined);
      Animated.timing(opacity, { toValue: 1, duration: 150, useNativeDriver: true }).start();
      timer.current = setTimeout(hide, ERROR_MS);
    },
    [hide, opacity],
  );

  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const insets = useSafeAreaInsets();

  return (
    <UndoContext.Provider value={{ show, showError }}>
      {children}
      {toast ? (
        <Animated.View
          style={[st.wrap, { opacity, bottom: space.xl + insets.bottom }]}
          pointerEvents="box-none"
        >
          <View style={[st.bar, toast.tone === 'error' && st.barError]}>
            <T style={st.text} numberOfLines={3}>
              {toast.message}
            </T>
            {toast.onUndo ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Undo"
                onPress={async () => {
                  const fn = toast.onUndo;
                  hide();
                  await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
                  await fn?.();
                }}
                style={st.undo}
              >
                <T style={st.undoText}>Undo</T>
              </Pressable>
            ) : null}
          </View>
        </Animated.View>
      ) : null}
    </UndoContext.Provider>
  );
}

const st = StyleSheet.create({
  // The tab bar is at the TOP now, so the toast sits at the bottom of the
  // screen where the thumb already is.
  // `bottom` is set inline so it can add the navigation-bar inset.
  wrap: { position: 'absolute', left: 0, right: 0, paddingHorizontal: space.md },
  bar: {
    minHeight: touch.cta,
    backgroundColor: color.text,
    borderRadius: radius.lg,
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: space.lg,
    paddingRight: space.sm,
    gap: space.sm,
  },
  barError: { backgroundColor: color.danger },
  text: { flex: 1, color: color.onAccent, fontSize: type.label, fontWeight: weight.semibold },
  // A large hit area: this is tapped in a hurry, one-handed.
  undo: { minWidth: 88, minHeight: touch.min, alignItems: 'center', justifyContent: 'center' },
  undoText: { color: color.undo, fontSize: type.body, fontWeight: weight.bold, letterSpacing: 1 },
});
