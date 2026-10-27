import React from 'react';
import { Pressable } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { DbProvider } from '../db/provider';
import { ToastProvider } from '../ui/snackbar';
import { AutoSync } from '../sync/auto';
import { Empty, Loading, Screen, T } from '../ui/components';
import { color, space, touch, type, weight } from '../ui/tokens';

/** A worded back control for the modals: icon-only controls are not allowed (CLAUDE.md section 8). */
function Cancel({ tint }: { tint: string }) {
  const router = useRouter();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => router.back()}
      // Its own gutter, and room before the title: without them "Cancel" sat on
      // the screen edge and ran into "Give dose" as one phrase.
      style={{
        minWidth: touch.min,
        minHeight: touch.min,
        justifyContent: 'center',
        paddingHorizontal: space.lg,
        marginRight: space.sm,
      }}
    >
      <T style={{ color: tint, fontSize: type.body, fontWeight: weight.semibold }}>Cancel</T>
    </Pressable>
  );
}

const tint = (c: string) => ({ headerTintColor: c });
const cancel = (c: string) => ({ ...tint(c), headerLeft: () => <Cancel tint={c} /> });

/**
 * The migration gate lives here: nothing renders until the schema is current,
 * because a screen that reads a half-migrated database shows numbers that are
 * quietly wrong.
 */
export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <DbProvider
        renderLoading={() => (
          <Screen>
            <Loading label="Opening clinic records" />
          </Screen>
        )}
        renderError={(message) => (
          <Screen>
            <Empty title="Cannot open clinic records" hint={message} />
          </Screen>
        )}
      >
        <ToastProvider>
          <AutoSync />
          <Stack
            screenOptions={{
              headerStyle: { backgroundColor: color.surface },
              headerTitleStyle: { color: color.text, fontSize: 20, fontWeight: '600' },
              headerShadowVisible: false,
              headerTintColor: color.dose,
              contentStyle: { backgroundColor: color.bg },
            }}
          >
            <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
            {/* Full-screen modals, not half-height sheets: full screen is what
                buys 64dp targets and 18pt+ text, which matters more here than
                the visual elegance of a peeking sheet. */}
            <Stack.Screen name="dose/[vaccineId]" options={{ presentation: 'modal', title: 'Give dose', ...cancel(color.dose) }} />
            <Stack.Screen name="receive/index" options={{ presentation: 'modal', title: 'Add stock', ...cancel(color.stock) }} />
            <Stack.Screen name="receive/[vaccineId]" options={{ presentation: 'modal', title: 'Add stock', ...cancel(color.stock) }} />
            <Stack.Screen name="reports/today" options={{ title: 'Given today', ...tint(color.more) }} />
            <Stack.Screen
              name="catalog/new"
              options={{ presentation: 'modal', title: 'New vaccine', ...tint(color.catalog) }}
            />
            <Stack.Screen name="catalog/[id]" options={{ title: 'Edit vaccine', ...tint(color.catalog) }} />
            <Stack.Screen name="children/index" options={{ title: 'Children', ...tint(color.more) }} />
            <Stack.Screen name="ledger/index" options={{ title: 'All entries', ...tint(color.more) }} />
            <Stack.Screen name="backup/index" options={{ title: 'Backup', ...tint(color.more) }} />
            <Stack.Screen name="settings/index" options={{ title: 'Settings', ...tint(color.more) }} />
            <Stack.Screen name="sync/index" options={{ title: 'Server backup', ...tint(color.more) }} />
          </Stack>
        </ToastProvider>
      </DbProvider>
    </SafeAreaProvider>
  );
}
