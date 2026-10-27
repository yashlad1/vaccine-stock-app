import React from 'react';
import {
  ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput,
  type TextInputProps, View, type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { friendlyError } from './errors';
import { centred } from './layout';
import {
  MAX_FONT_SCALE, type Accent, accentColor, accentSoft, color, elevation, radius, space, touch,
  type, weight,
} from './tokens';

/**
 * Every component here encodes a rule from CLAUDE.md section 8. The look is
 * clinic-queue's - white surfaces on a soft ground, hairline edges, 8px
 * controls, sentence case - but none of the accessibility floors move: 56dp
 * targets, 18pt body, 14pt absolute minimum, and no state carried by colour
 * alone.
 */

const scale = { maxFontSizeMultiplier: MAX_FONT_SCALE };

export function T(props: React.ComponentProps<typeof Text>) {
  return <Text {...scale} {...props} />;
}

export function Screen({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  return <View style={[s.screen, style]}>{children}</View>;
}

export function Scroll({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  const insets = useSafeAreaInsets();
  return (
    <ScrollView
      style={[s.screen, style]}
      contentContainerStyle={{
        padding: space.lg,
        // Clears Android's navigation bar; see Footer.
        paddingBottom: space.xxl * 2 + insets.bottom,
      }}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
    >
      {children}
    </ScrollView>
  );
}

/**
 * How much room the system takes at the bottom of the screen. Add this to the
 * `paddingBottom` of any list that sits under a `floating` Footer, or the last
 * row hides behind it.
 */
export function useBottomInset() {
  return useSafeAreaInsets().bottom;
}

/**
 * Bottom-anchored action bar. Use this instead of a hand-rolled `footer` style.
 *
 * Android's three-button navigation bar overlaps anything positioned at
 * `bottom: 0`, and by design (CLAUDE.md section 8) every primary CTA in this
 * app lives in the bottom third. Without the inset the button is not merely
 * clipped, it is *untappable* - which is how "ADD A NEW VACCINE" came to look
 * like a feature that had never been built.
 *
 * `floating` overlays a scrolling list (Stock, Vaccines); the default sits in
 * normal flow beneath one (the modals).
 */
export function Footer({
  children,
  floating,
  gap,
  style,
}: {
  children: React.ReactNode;
  floating?: boolean;
  gap?: number;
  style?: ViewStyle;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View
      style={[
        s.footer,
        floating ? s.footerFloating : null,
        floating ? elevation(3) : null,
        { paddingBottom: space.lg + insets.bottom },
        style,
      ]}
    >
      {/* Bounded and centred: a 64dp CTA stretched across a 10-inch tablet is
          a worse target, not a better one - the thumb still lands in one
          place. `gap` belongs on this inner view, with the buttons. */}
      <View style={[centred, gap ? { gap } : null]}>{children}</View>
    </View>
  );
}

/**
 * A read failed. Shown instead of a spinner that would otherwise never resolve.
 *
 * `useQuery` has always caught read errors and exposed them, but no screen
 * rendered them, so any failed read became an indefinite <Loading/> with no
 * explanation and no way forward. Retry is wired to useQuery's `reload`, which
 * matters because the most likely causes here - a locked database mid-write, a
 * transient failure - succeed on a second attempt.
 */
export function ErrorState({
  error,
  onRetry,
  what = 'load this screen',
}: {
  error: Error;
  onRetry?: () => void;
  what?: string;
}) {
  return (
    <View style={s.center}>
      <T style={s.errorTitle}>Could not {what}</T>
      <T style={s.errorBody}>{friendlyError(error, { what })}</T>
      {onRetry ? <SecondaryButton label="Try again" onPress={onRetry} /> : null}
    </View>
  );
}

/** A panel: white on the ground, one decorative edge, no shadow (clinic-queue). */
export function Card({
  children,
  style,
  tone,
  onPress,
}: {
  children: React.ReactNode;
  style?: ViewStyle;
  tone?: Accent | 'soft';
  onPress?: () => void;
}) {
  const bg = tone && tone !== 'soft' ? accentSoft[tone] : color.surface;
  const body = (
    <View style={[s.card, { backgroundColor: bg }, style]}>
      {children}
    </View>
  );
  if (!onPress) return body;
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => (pressed ? { opacity: 0.85 } : null)}>
      {body}
    </Pressable>
  );
}

export function SectionTitle({ children }: { children: React.ReactNode }) {
  return <T style={s.sectionTitle}>{children}</T>;
}

/**
 * Primary call to action: 64dp tall, full width, and it always carries a WORD,
 * verb first, in sentence case. The `accent` prop is load-bearing, not
 * decoration - it is what makes "Give 1 dose" and "Add to stock" impossible to
 * mistake for one another. `outline` is clinic-queue's secondary button.
 */
export function BigButton({
  label,
  onPress,
  accent = 'dose',
  variant = 'solid',
  disabled,
  sublabel,
  danger,
}: {
  label: string;
  onPress: () => void;
  accent?: Accent;
  variant?: 'solid' | 'outline';
  disabled?: boolean;
  sublabel?: string;
  danger?: boolean;
}) {
  const base = danger ? color.danger : accentColor[accent];
  const solid = variant === 'solid';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        s.bigButton,
        solid
          ? { backgroundColor: disabled ? color.disabledFill : base }
          : { backgroundColor: disabled ? color.disabledFill : color.surface, borderWidth: 2, borderColor: disabled ? color.disabledFill : color.borderControl },
        pressed && !disabled ? { transform: [{ scale: 0.985 }], opacity: 0.92 } : null,
      ]}
    >
      <T
        style={[
          s.bigButtonLabel,
          { color: disabled ? color.disabledText : solid ? color.onAccent : color.text },
        ]}
      >
        {label}
      </T>
      {sublabel ? (
        <T
          style={[
            s.bigButtonSub,
            { color: disabled ? color.disabledText : solid ? color.onAccent : color.textMuted },
          ]}
        >
          {sublabel}
        </T>
      ) : null}
    </Pressable>
  );
}

export function SecondaryButton({
  label,
  onPress,
  accent = 'dose',
  danger,
}: {
  label: string;
  onPress: () => void;
  accent?: Accent;
  danger?: boolean;
}) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={s.secondary}>
      <T style={[s.secondaryLabel, { color: danger ? color.danger : accentColor[accent] }]}>
        {label}
      </T>
    </Pressable>
  );
}

/**
 * A state badge. Colour is ALWAYS paired with this word - roughly 8% of men are
 * red-green colourblind, and a sunlit clinic window flattens colour on any phone.
 */
export function Badge({
  text,
  tone,
}: {
  text: string;
  tone: 'low' | 'danger' | 'ok' | 'neutral';
}) {
  const map = {
    low: { bg: color.lowSoft, fg: color.lowInk },
    danger: { bg: color.dangerSoft, fg: color.dangerInk },
    ok: { bg: color.okSoft, fg: color.okInk },
    neutral: { bg: color.surfaceSunken, fg: color.more },
  }[tone];
  return (
    <View style={[s.badge, { backgroundColor: map.bg }]}>
      <T style={[s.badgeText, { color: map.fg }]}>{text}</T>
    </View>
  );
}

export function Chip({
  label,
  selected,
  onPress,
  sublabel,
  accent = 'dose',
  compact,
}: {
  label: string;
  selected?: boolean;
  onPress: () => void;
  sublabel?: string;
  accent?: Accent;
  compact?: boolean;
}) {
  const base = accentColor[accent];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: !!selected }}
      onPress={onPress}
      style={({ pressed }) => [
        s.chip,
        compact ? s.chipCompact : null,
        // The box keeps its original 2px edge. Unselected draws a 1px
        // control edge and takes the other pixel as padding, so a chip is
        // exactly its old size either way and selecting one shifts nothing.
        selected
          ? { backgroundColor: accentSoft[accent], borderColor: base }
          : { backgroundColor: color.surface, borderColor: color.borderControl, borderWidth: 1, paddingHorizontal: (compact ? space.md : space.lg) + 1 },
        pressed ? { backgroundColor: selected ? accentSoft[accent] : color.surfaceSunken } : null,
      ]}
    >
      <T style={[s.chipLabel, selected ? { color: base } : null]}>{label}</T>
      {sublabel ? <T style={s.chipSub}>{sublabel}</T> : null}
    </Pressable>
  );
}

/**
 * A stepper, not a keyboard.
 *
 * The reason is correctness, not comfort: a stepper CANNOT produce 100 when you
 * meant 10, and in a derived-stock ledger that typo is silent corruption that
 * only surfaces weeks later as inventory that does not exist.
 */
export function Stepper({
  value,
  onChange,
  min = 1,
  max = 999,
  quickValues,
  accent = 'dose',
}: {
  value: number;
  onChange: (n: number) => void;
  min?: number;
  max?: number;
  quickValues?: number[];
  accent?: Accent;
}) {
  const step = (delta: number) => onChange(Math.min(max, Math.max(min, value + delta)));
  return (
    <View>
      <View style={s.stepperRow}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Decrease"
          onPress={() => step(-1)}
          onLongPress={() => step(-5)}
          disabled={value <= min}
          style={({ pressed }) => [s.stepperBtn, value <= min && s.stepperBtnDisabled, pressed && s.stepperBtnPressed]}
        >
          <T style={[s.stepperSign, value <= min && s.stepperSignDisabled]}>−</T>
        </Pressable>
        <T style={s.stepperValue} accessibilityLabel={`${value}`}>
          {value}
        </T>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Increase"
          onPress={() => step(1)}
          onLongPress={() => step(5)}
          disabled={value >= max}
          style={({ pressed }) => [s.stepperBtn, value >= max && s.stepperBtnDisabled, pressed && s.stepperBtnPressed]}
        >
          <T style={[s.stepperSign, value >= max && s.stepperSignDisabled]}>+</T>
        </Pressable>
      </View>
      {quickValues?.length ? (
        <View style={s.chipRow}>
          {quickValues.map((q) => (
            <Chip
              key={q}
              compact
              accent={accent}
              label={String(q)}
              selected={value === q}
              onPress={() => onChange(q)}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

export function Field({
  label,
  hint,
  children,
  dense,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
  /** Half the gap below, for a form where every field is optional and the button is the point. */
  dense?: boolean;
}) {
  return (
    <View style={{ marginBottom: dense ? space.md : space.xl }}>
      <T style={s.fieldLabel}>{label}</T>
      {hint ? <T style={s.fieldHint}>{hint}</T> : null}
      {children}
    </View>
  );
}

/** clinic-queue's input: white, a border-control edge (3:1 is the bar for a field's outline), 8px. */
export function Input(props: TextInputProps) {
  return (
    <TextInput
      placeholderTextColor={color.textMuted}
      {...scale}
      {...props}
      style={[s.input, props.style]}
    />
  );
}

export function Row({
  title,
  subtitle,
  right,
  onPress,
  last,
  dense,
}: {
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
  onPress?: () => void;
  last?: boolean;
  /**
   * Height for what the row IS, not one size for everything: a row she taps
   * keeps the 56dp floor, a line she only reads sits at its text height. The
   * text keeps its size either way; only the empty space around it goes.
   */
  dense?: boolean;
}) {
  const body = (
    <View
      style={[
        s.row,
        dense && (onPress ? s.rowDenseTap : s.rowDenseRead),
        last && { borderBottomWidth: 0 },
      ]}
    >
      <View style={{ flex: 1 }}>
        <T style={s.rowTitle}>{title}</T>
        {subtitle ? <T style={s.rowSub}>{subtitle}</T> : null}
      </View>
      {right}
      {onPress ? <T style={s.chevron}>›</T> : null}
    </View>
  );
  return onPress ? (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => (pressed ? { backgroundColor: color.pressed } : null)}
    >
      {body}
    </Pressable>
  ) : (
    body
  );
}

export function Banner({
  text,
  tone,
  actionLabel,
  onAction,
  onDismiss,
}: {
  text: string;
  tone: 'low' | 'danger';
  actionLabel?: string;
  onAction?: () => void;
  onDismiss?: () => void;
}) {
  const map =
    tone === 'danger'
      ? { bg: color.dangerSoft, fg: color.dangerInk }
      : { bg: color.lowSoft, fg: color.lowInk };
  return (
    <View style={[s.banner, { backgroundColor: map.bg }]}>
      <T style={[s.bannerText, { color: map.fg }]}>{text}</T>
      <View style={s.bannerActions}>
        {actionLabel && onAction ? (
          <Pressable accessibilityRole="button" onPress={onAction} hitSlop={{ top: 6, bottom: 6 }} style={s.bannerBtn}>
            <T style={[s.bannerBtnText, { color: map.fg }]}>{actionLabel}</T>
          </Pressable>
        ) : null}
        {onDismiss ? (
          <Pressable accessibilityRole="button" onPress={onDismiss} hitSlop={{ top: 6, bottom: 6 }} style={s.bannerBtn}>
            <T style={[s.bannerBtnText, { color: map.fg }]}>Later</T>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

export function Loading({ label = 'Loading' }: { label?: string }) {
  return (
    <View style={s.center}>
      <ActivityIndicator size="large" color={color.dose} />
      <T style={s.rowSub}>{label}</T>
    </View>
  );
}

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <View style={s.center}>
      <T style={s.emptyTitle}>{title}</T>
      {hint ? <T style={[s.rowSub, { textAlign: 'center' }]}>{hint}</T> : null}
    </View>
  );
}

export const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.bg },
  footer: {
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
    backgroundColor: color.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.border,
  },
  footerFloating: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.xl,
    gap: space.md,
  },
  errorTitle: { fontSize: type.title, fontWeight: weight.bold, color: color.text, textAlign: 'center' },
  errorBody: { fontSize: type.body, color: color.textMuted, textAlign: 'center', lineHeight: 26 },
  emptyTitle: {
    fontSize: type.title,
    fontWeight: weight.semibold,
    color: color.text,
    textAlign: 'center',
  },

  // The edge sits inside the box; padding gives its pixel back so the content keeps its old size.
  card: { borderRadius: radius.lg, padding: space.lg - 1, borderWidth: 1, borderColor: color.border },
  // clinic-queue section title: sentence case, 600, never tracked-out capitals.
  sectionTitle: {
    fontSize: type.min,
    fontWeight: weight.bold,
    color: color.text,
    letterSpacing: 0.8,
    marginTop: space.xl,
    marginBottom: space.sm,
  },

  bigButton: {
    minHeight: touch.cta,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.lg,
  },
  bigButtonLabel: { fontSize: type.title, fontWeight: weight.bold, letterSpacing: 0.3 },
  bigButtonSub: { fontSize: type.min, marginTop: 2, fontWeight: weight.medium },

  secondary: { minHeight: touch.min, justifyContent: 'center', alignSelf: 'flex-start' },
  secondaryLabel: { fontSize: type.body, fontWeight: weight.semibold },

  badge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.pill },
  badgeText: { fontSize: type.min, fontWeight: weight.bold, letterSpacing: 0.6 },

  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.sm },
  chip: {
    minHeight: touch.min,
    justifyContent: 'center',
    paddingHorizontal: space.lg,
    borderRadius: radius.md,
    borderWidth: 2,
  },
  chipCompact: { paddingHorizontal: space.md, minWidth: touch.min },
  chipLabel: { fontSize: type.body, fontWeight: weight.semibold, color: color.text },
  chipSub: { fontSize: type.min, color: color.textMuted, marginTop: 1 },

  stepperRow: { flexDirection: 'row', alignItems: 'center', gap: space.lg },
  stepperBtn: {
    width: touch.min,
    height: touch.min,
    borderRadius: radius.md,
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.borderControl,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // A token swap, not opacity. Component-wide opacity fades the glyph along
  // with the surface, and a 0.4 minus sign is indistinguishable from a broken
  // button to someone deciding whether the app is stuck or she is at the limit.
  stepperBtnDisabled: { backgroundColor: color.disabledFill, borderColor: color.disabledFill },
  stepperSignDisabled: { color: color.disabledText },
  stepperBtnPressed: { backgroundColor: color.surfaceSunken },
  stepperSign: { fontSize: type.big, fontWeight: weight.bold, color: color.text },
  stepperValue: {
    fontSize: type.hero,
    fontWeight: weight.bold,
    color: color.text,
    minWidth: 72,
    textAlign: 'center',
  },

  fieldLabel: {
    fontSize: type.label,
    fontWeight: weight.semibold,
    color: color.text,
    marginBottom: space.xs,
  },
  fieldHint: { fontSize: type.min, color: color.textMuted, marginBottom: space.sm, lineHeight: 20 },
  input: {
    minHeight: touch.min,
    borderRadius: radius.md,
    paddingHorizontal: space.lg - 1, // the 1px edge takes the other pixel
    fontSize: type.body,
    color: color.text,
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.borderControl,
  },

  row: {
    minHeight: touch.min + 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.border,
  },
  rowDenseTap: { minHeight: touch.min, paddingVertical: space.sm },
  rowDenseRead: { minHeight: 0, paddingVertical: space.sm },
  rowTitle: { fontSize: type.body, fontWeight: weight.semibold, color: color.text },
  rowSub: { fontSize: type.label, color: color.textMuted, marginTop: 2 },
  chevron: { fontSize: type.big, color: color.borderControl, marginTop: -4 },

  banner: { borderRadius: radius.md, padding: space.lg, marginBottom: space.md },
  bannerText: { fontSize: type.label, fontWeight: weight.semibold, lineHeight: 22 },
  bannerActions: { flexDirection: 'row', gap: space.sm, marginTop: space.sm },
  bannerBtn: {
    minHeight: touch.min - 12,
    justifyContent: 'center',
    paddingHorizontal: space.md,
    borderRadius: radius.sm,
  },
  bannerBtnText: { fontSize: type.label, fontWeight: weight.bold },
});
