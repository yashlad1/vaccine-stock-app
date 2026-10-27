import React from 'react';
import { Tabs } from 'expo-router';
import { TopTabBar } from '../../ui/top-tabs';

/**
 * Five tabs, at the TOP, each owning an accent colour.
 *
 *   Give dose  - the launch destination and the dominant flow
 *   Add stock  - deliveries, plus the current stock position
 *   Vaccines   - add a new vaccine, remove an old one, fix doses-per-vial
 *   Trends     - doses by week or month, top vaccines, ages, boys and girls;
 *                read-only, it never writes
 *   More       - reports, backup, children, history, settings
 *
 * Give dose and Add stock are deliberately adjacent because that is what was
 * asked for, but they move the ledger in opposite directions - so they are
 * separated by hue, by heading and by the wording of their primary button
 * rather than by distance.
 */
export default function TabsLayout() {
  return (
    <Tabs
      tabBar={(props) => <TopTabBar {...props} />}
      screenOptions={{ headerShown: false, tabBarPosition: 'top' }}
    >
      <Tabs.Screen name="index" options={{ title: 'Give dose' }} />
      <Tabs.Screen name="stock" options={{ title: 'Add stock' }} />
      <Tabs.Screen name="vaccines" options={{ title: 'Vaccines' }} />
      <Tabs.Screen name="trends" options={{ title: 'Trends' }} />
      <Tabs.Screen name="more" options={{ title: 'More' }} />
    </Tabs>
  );
}
