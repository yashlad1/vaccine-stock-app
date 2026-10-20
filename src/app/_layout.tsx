import React from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { DbProvider } from '../db/provider';
import { ToastProvider } from '../ui/snackbar';
import { AutoSync } from '../sync/auto';
import { Empty, Loading, Screen } from '../ui/components';
import { color } from '../ui/tokens';

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
            <Stack.Screen name="dose/[vaccineId]" options={{ presentation: 'modal', title: 'Give dose' }} />
            <Stack.Screen name="receive/index" options={{ presentation: 'modal', title: 'Receive stock' }} />
            <Stack.Screen name="receive/[vaccineId]" options={{ presentation: 'modal', title: 'Receive stock' }} />
            <Stack.Screen name="reports/today" options={{ title: 'Given today' }} />
            <Stack.Screen
              name="catalog/new"
              options={{ presentation: 'modal', title: 'New vaccine' }}
            />
            <Stack.Screen name="catalog/[id]" options={{ title: 'Edit vaccine' }} />
            <Stack.Screen name="children/index" options={{ title: 'Children' }} />
            <Stack.Screen name="ledger/index" options={{ title: 'All entries' }} />
            <Stack.Screen name="backup/index" options={{ title: 'Backup' }} />
            <Stack.Screen name="settings/index" options={{ title: 'Settings' }} />
            <Stack.Screen name="sync/index" options={{ title: 'Server backup' }} />
          </Stack>
        </ToastProvider>
      </DbProvider>
    </SafeAreaProvider>
  );
}
