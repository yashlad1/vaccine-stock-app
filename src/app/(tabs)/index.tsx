import { useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Badge, Chip, ErrorState, Input, Loading, Screen, SecondaryButton, SectionTitle, T, useBottomInset } from '../../ui/components';
import { color, radius, space, type, weight } from '../../ui/tokens';
import { useDb, useQuery } from '../../db/provider';
import { dosesGivenTotals, vaccinesByUsage } from '../../domain/reports';
import { describeStockRow } from '../../domain/stock';
import { daysAgoLocal, formatDayLabel, todayLocal } from '../../domain/time';
import { BackupBanner } from '../../ui/backup-banner';
import { SyncBanner } from '../../ui/sync-banner';
import { centred, useColumns } from '../../ui/layout';
import { searchRank } from '../../domain/search';
import { isAwaitingCatalog, startNewClinicHere } from '../../sync/adopt';
import { useAction } from '../../ui/use-action';

/**
 * HOME IS THE DOSE-ENTRY SCREEN, NOT A DASHBOARD.
 *
 * Any design where the doctor lands on summary tiles and then taps "Give dose"
 * has already lost. The grid also does double duty: "what do I have" and "how
 * much is left" - two of the three requested reports - are ambient here, so she
 * never navigates to read them.
 */
export default function GiveDoseScreen() {
  const router = useRouter();
  const bottomInset = useBottomInset();
  const columns = useColumns();
  const run = useAction();
  const { db, deviceId, bump } = useDb();
  const [q, setQ] = useState('');
  const today = todayLocal();
  const since = daysAgoLocal(30);

  const { data: rows, loading, error, reload } = useQuery((db) => vaccinesByUsage(db, since, today), [since, today]);
  const { data: given } = useQuery((db) => dosesGivenTotals(db, today), [today]);
  const { data: awaiting } = useQuery((d) => isAwaitingCatalog(d), []);

  const dosesToday = (given ?? []).reduce((n, g) => n + g.doses, 0);

  // Ranked, not just filtered: an exact or leading match outranks one buried
  // mid-word, and ties keep the 30-day usage order underneath.
  const filtered = useMemo(() => searchRank(rows ?? [], q), [rows, q]);

  /**
   * Counted per level, not as one "not OK" bucket.
   *
   * Lumping them together labelled everything amber "LOW", so a freshly seeded
   * catalog with no stock entered reported "25 LOW" when all 25 were OUT. That
   * is the wrong signal in the wrong colour: LOW means running down, OUT means
   * there is none, and CHECK means the balance went negative and a delivery was
   * probably never logged. CLAUDE.md section 8 requires the colour AND the
   * right word.
   *
   * OUT and LOW count only vaccines given in the last 30 days. Supply systems
   * report stock-outs only for products the facility carries; counting every
   * catalog entry made "16 OUT" mostly vaccines she does not use, and a badge
   * that is mostly noise gets ignored. CHECK always counts: a negative balance
   * is a missing receipt whatever the usage.
   */
  const counts = useMemo(() => {
    const c = { CHECK: 0, OUT: 0, LOW: 0 };
    for (const r of rows ?? []) {
      const level = describeStockRow(r).level;
      if (level === 'NEGATIVE') c.CHECK += 1;
      else if (r.recent_doses > 0 && level === 'OUT') c.OUT += 1;
      else if (r.recent_doses > 0 && level === 'LOW') c.LOW += 1;
    }
    return c;
  }, [rows]);

  // Most urgent first, and only what is actually non-zero.
  const flags = (
    [
      ['CHECK', counts.CHECK, 'danger'],
      ['OUT', counts.OUT, 'danger'],
      ['LOW', counts.LOW, 'low'],
    ] as const
  ).filter(([, n]) => n > 0);

  // In use (given in the last 30 days) stay tiles; the rest become chips below.
  // CHECK always stays a tile: a negative balance needs attention whatever the use.
  const tiles = filtered.filter((r) => r.recent_doses > 0 || describeStockRow(r).level === 'NEGATIVE');
  const idle = filtered.filter((r) => !tiles.includes(r));

  if (error) return <ErrorState error={error} onRetry={reload} what="load your vaccines" />;
  if (loading && !rows) return <Loading label="Loading vaccines" />;

  return (
    <Screen>
      <View style={[st.header, centred]}>
        <View style={st.statusLeft}>
          <T style={st.status}>{formatDayLabel()} ·</T>
          <Pressable
            accessibilityRole="button"
            onPress={() => router.push('/reports/today')}
            hitSlop={{ top: 18, bottom: 18, left: 4, right: 8 }}
          >
            <T style={[st.status, st.statusCount]}>
              {dosesToday} {dosesToday === 1 ? 'dose' : 'doses'} today
            </T>
          </Pressable>
        </View>
        {flags.length ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={flags.map(([w, n]) => `${n} ${w}`).join(', ')}
            onPress={() => router.push('/stock')}
            hitSlop={{ top: 15, bottom: 15 }}
            style={st.flags}
          >
            {flags.map(([word, n, tone]) => (
              <Badge key={word} text={`${n} ${word}`} tone={tone} />
            ))}
          </Pressable>
        ) : null}
      </View>

      <View style={[st.pad, centred]}>
        <BackupBanner />
        <SyncBanner />
        {/* Not autofocused: the keyboard must not cover the grid on arrival. */}
        <Input
          placeholder="Search vaccine"
          value={q}
          onChangeText={setQ}
          autoCorrect={false}
          autoCapitalize="none"
          returnKeyType="search"
          accessibilityLabel="Search vaccine"
        />
      </View>

      <FlatList
        data={tiles}
        keyExtractor={(r) => r.vaccine_id}
        // FlatList caches its layout per column count, so it must be re-keyed
        // when that changes - otherwise a rotation leaves the old grid behind.
        key={`cols-${columns}`}
        numColumns={columns}
        columnWrapperStyle={{ gap: space.md }}
        contentContainerStyle={[st.grid, centred, { paddingBottom: space.xxl + bottomInset }]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        ListFooterComponent={
          idle.length ? (
            <View>
              <SectionTitle>Not given in the last 30 days</SectionTitle>
              <View style={st.chips}>
                {idle.map((r) => {
                  const d = describeStockRow(r);
                  return (
                    <Chip
                      key={r.vaccine_id}
                      label={r.name}
                      sublabel={d.badge ?? d.primary}
                      onPress={() => {
                        setQ('');
                        router.push(`/dose/${r.vaccine_id}`);
                      }}
                    />
                  );
                })}
              </View>
            </View>
          ) : null
        }
        ListEmptyComponent={
          idle.length ? null : <View style={{ padding: space.xl }}>
            {q ? (
              <T style={st.emptyText}>No vaccine matches &quot;{q}&quot;.</T>
            ) : awaiting ? (
              // Sync is switched on but the server has not answered, so the
              // vaccine list has deliberately NOT been created here: guessing
              // wrong makes a second copy of the catalog, which is the one
              // mistake that cannot be cleanly undone. The app cannot know
              // whether this is the first phone or a second one, so it asks.
              <>
                <T style={st.emptyText}>
                  Waiting for the clinic&apos;s vaccine list. Check the internet connection. It
                  will load on its own.
                </T>
                <T style={st.emptyHint}>
                  If this is the first phone in the clinic, you can start the list here instead.
                </T>
                <SecondaryButton
                  label="Start a new list on this phone"
                  onPress={() =>
                    void run('start the vaccine list', async () => {
                      await startNewClinicHere(db, deviceId);
                      bump();
                    })
                  }
                />
              </>
            ) : (
              <T style={st.emptyText}>No vaccines yet. Add one from the Vaccines tab.</T>
            )}
          </View>
        }
        renderItem={({ item }) => {
          const d = describeStockRow(item);
          const tone = d.level === 'OK' ? color.text : d.level === 'LOW' ? color.low : color.danger;
          return (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${item.name}, ${d.primary}${d.badge ? `, ${d.badge}` : ''}`}
              onPress={() => {
                setQ('');
                router.push(`/dose/${item.vaccine_id}`);
              }}
              style={({ pressed }) => [st.tile, pressed && st.tilePressed]}
            >
              <T style={st.tileName} numberOfLines={3}>
                {item.name}
              </T>
              <View style={{ flex: 1, minHeight: space.sm }} />
              {/* The badge sits IN FLOW beside the number, not absolutely
                  positioned over the corner. At font scale 1.6x a two-line
                  trade name reaches the top-right corner and the old badge
                  printed straight over it - and a LOW pill sitting on top of
                  the vaccine's own name is exactly the kind of thing that only
                  shows up on the phone of the person relying on it. Keeping
                  the two together also reads better: the count and its state
                  are one fact, not two. */}
              <View style={st.tileFoot}>
                <T style={[st.tileStock, { color: tone }]}>{d.primary}</T>
                {d.badge ? (
                  <Badge text={d.badge} tone={d.level === 'LOW' ? 'low' : 'danger'} />
                ) : null}
              </View>
            </Pressable>
          );
        }}
      />
    </Screen>
  );
}

const st = StyleSheet.create({
  // Wraps rather than clipping the last badge at font scale 1.6x.
  flags: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs, justifyContent: 'flex-end' },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: space.xs,
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
    paddingBottom: space.md,
  },
  statusLeft: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  status: { fontSize: type.body, color: color.textMuted, fontWeight: weight.semibold },
  statusCount: { color: color.text, fontWeight: weight.bold },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.sm },
  pad: { paddingHorizontal: space.lg, paddingBottom: space.md, gap: space.md },
  emptyText: { fontSize: type.body, color: color.textMuted, textAlign: 'center', lineHeight: 26 },
  emptyHint: {
    fontSize: type.label, color: color.textMuted, textAlign: 'center',
    lineHeight: 24, marginTop: space.lg, marginBottom: space.sm,
  },

  grid: { paddingHorizontal: space.lg, gap: space.md },
  tile: {
    flex: 1,
    minHeight: 138,
    borderRadius: radius.lg,
    padding: space.lg,
    backgroundColor: color.surface,
    // White on the ground plus an edge, never a shadow (clinic-queue). A
    // shadow is very faint on Android, and in a sunlit room the grid stopped
    // reading as a set of targets and started reading as floating text.
    borderWidth: 1,
    borderColor: color.border,
  },
  tilePressed: { backgroundColor: color.doseSoft, transform: [{ scale: 0.985 }] },
  tileName: { fontSize: type.title, fontWeight: weight.semibold, color: color.text, lineHeight: 27 },
  tileStock: { fontSize: type.body, fontWeight: weight.bold },
  // Wraps so the badge drops below the count rather than squeezing it at 1.6x.
  tileFoot: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: space.xs,
  },
});
