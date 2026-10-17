import React from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { centred } from './layout';
import type { BottomTabBarProps } from 'expo-router/build/react-navigation/bottom-tabs/types';
import { T } from './components';
import { type Accent, accentColor, accentSoft, color, radius, space, touch, type, weight } from './tokens';

/**
 * Top tab bar.
 *
 * Written by hand rather than pulling in @react-navigation/material-top-tabs
 * and react-native-pager-view: two native dependencies for a four-item
 * segmented control is a bad trade, and this way the 56dp targets and the
 * per-tab accent colour are enforced here rather than fought with overrides.
 *
 * The per-tab accent is the safety feature, not the styling. "Give dose" and
 * "Add stock" now sit next to each other, and they move the ledger in OPPOSITE
 * directions - so each tab owns a hue, and it carries through to the screen
 * heading and the primary button on it. A wrong tab looks wrong immediately,
 * before anything is written.
 *
 * The bar scrolls horizontally so it degrades gracefully at Android font scale
 * 1.6x instead of clipping the last tab (NFR-6).
 */

const ACCENTS: Record<string, Accent> = {
  index: 'dose',
  stock: 'stock',
  vaccines: 'catalog',
  more: 'more',
};

export function TopTabBar({ state, descriptors, navigation }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();

  return (
    <View style={[st.wrap, { paddingTop: insets.top }]}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        // Centred and bounded on a tablet, so the four tabs stay together as
        // a group instead of drifting apart across ten inches. On a phone this
        // is a no-op.
        contentContainerStyle={[st.row, centred]}
        // Keeps the bar usable when enlarged text makes it wider than the screen.
        bounces={false}
      >
        {state.routes.map((route, index) => {
          const { options } = descriptors[route.key];
          const label =
            typeof options.tabBarLabel === 'string'
              ? options.tabBarLabel
              : (options.title ?? route.name);
          const focused = state.index === index;
          const accent = ACCENTS[route.name] ?? 'dose';
          const tint = accentColor[accent];

          return (
            <Pressable
              key={route.key}
              accessibilityRole="tab"
              accessibilityState={{ selected: focused }}
              accessibilityLabel={label}
              onPress={() => {
                const event = navigation.emit({
                  type: 'tabPress',
                  target: route.key,
                  canPreventDefault: true,
                });
                if (!focused && !event.defaultPrevented) {
                  navigation.navigate(route.name, route.params);
                }
              }}
              style={({ pressed }) => [
                st.tab,
                focused ? { backgroundColor: accentSoft[accent] } : null,
                pressed && !focused ? { backgroundColor: color.pressed } : null,
              ]}
            >
              <T
                numberOfLines={1}
                style={[st.label, { color: focused ? tint : color.textMuted }]}
              >
                {label}
              </T>
              {/* A second, non-colour signal that this tab is active. */}
              <View style={[st.underline, focused ? { backgroundColor: tint } : null]} />
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

const st = StyleSheet.create({
  wrap: {
    backgroundColor: color.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.border,
  },
  row: {
    flexDirection: 'row',
    gap: space.xs,
    paddingHorizontal: space.md,
    paddingBottom: space.sm,
    paddingTop: space.sm,
  },
  tab: {
    minHeight: touch.min,
    minWidth: 84,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.md,
    // clinic-queue's segmented control: a tinted pill for the active item.
    borderRadius: radius.pill,
    gap: 6,
  },
  label: {
    fontSize: type.label,
    fontWeight: weight.semibold,
    ...Platform.select({ android: { includeFontPadding: false }, default: {} }),
  },
  underline: { height: 3, width: 26, borderRadius: radius.pill, backgroundColor: 'transparent' },
});
