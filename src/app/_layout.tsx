import { Pressable } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { Observe, ObserveInteractiveMarker, ObserveRoot } from 'expo-observe';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { DbProvider } from '../db/provider';
import { ToastProvider } from '../ui/snackbar';
import { AutoSync } from '../sync/auto';
import { Empty, Loading, Screen, T } from '../ui/components';
import { color, space, touch, type, weight } from '../ui/tokens';

/**
 * EAS Observe. Module scope, before anything renders.
 *
 * Route params are filtered. The exported route NAME stays (`/dose/[vaccineId]`,
 * which is the useful part), but the resolved URL is dropped, so no row id from
 * this clinic's database leaves the phone in a metric. Section 13: nothing
 * clinic-identifying, and a metrics pipeline is not an exception to that.
 *
 * `dispatchInDebug` is deliberately not set - debug builds stay silent, so the
 * Expo Go and web smoke loops never post metrics.
 *
 * Removed on 20 Oct to keep the old fingerprint for an OTA; back with build 5,
 * which ships a new APK anyway (owner, 27 Oct).
 */
Observe.configure({
  integrations: {
    'expo-router': { filteredParams: ['vaccineId', 'id'] },
  },
});

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
function RootLayout() {
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
          {/* Time-to-interactive is marked HERE, not on mount of this layout.
              DbProvider holds its children until migrations finish, so this
              subtree renders at the moment the app is genuinely usable. Marking
              it any earlier would report the app as interactive while she is
              still looking at "Opening clinic records". */}
          <ObserveInteractiveMarker />
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
              options={{ presentation: 'modal', title: 'New vaccine', ...cancel(color.catalog) }}
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

export default ObserveRoot.wrap(RootLayout);
