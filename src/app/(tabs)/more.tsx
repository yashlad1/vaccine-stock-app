import React from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Badge, BigButton, Card, Row, SectionTitle, T, useBottomInset } from '../../ui/components';
import { color, space, type, weight } from '../../ui/tokens';
import { centred } from '../../ui/layout';
import { useDb, useQuery } from '../../db/provider';
import { SETTING, getSetting } from '../../db/repo/settings';
import { lastBackupLabel } from '../../domain/backup-nag';
import { missingChildEntries } from '../../domain/reports';
import { pushOnce, syncStatus } from '../../sync/push';
import { pullOnce } from '../../sync/pull';
import { backendFor, loadSyncConfig } from '../../sync/config';
import { useToast } from '../../ui/snackbar';
import { useAction } from '../../ui/use-action';

/** Everything infrequent, as a flat list of large labelled rows. */
export default function MoreScreen() {
  const bottomInset = useBottomInset();
  const router = useRouter();
  const { db, deviceId, bump } = useDb();
  const toast = useToast();
  const run = useAction();
  const [busy, setBusy] = React.useState(false);

  /**
   * Upload now, one tap from the More tab rather than two.
   *
   * Syncing is automatic - after each entry, on returning to the app, and every
   * 15 minutes - so this button is not needed for the app to work. It exists
   * because "did it actually go?" is a reasonable thing to want to settle
   * before leaving the clinic, and a button that answers it in one tap is worth
   * more than a correct claim that it was unnecessary.
   */
  const uploadNow = () =>
    void run('upload your entries', async () => {
      setBusy(true);
      try {
        const backend = await backendFor(db);
        if (!backend) {
          toast.showError('Server backup is not set up yet.');
          return;
        }
        // Pull first, same order as the automatic pass, so this device takes in
        // the other one's entries as well as sending its own.
        await pullOnce(db, backend);
        const out = await pushOnce(db, backend, deviceId);
        bump();
        if (!out.ok) {
          toast.showError(out.error ?? 'Could not upload. Your entries are safe on this phone.');
          return;
        }
        toast.show(
          out.pushedRows
            ? `Uploaded ${out.pushedRows} ${out.pushedRows === 1 ? 'entry' : 'entries'}.`
            : 'Already up to date.',
        );
      } finally {
        setBusy(false);
      }
    });

  const { data: lastBackupAt } = useQuery(
    async (db) => Number(await getSetting(db, SETTING.lastBackupAt)) || null,
  );
  const { data: missing } = useQuery((db) => missingChildEntries(db, 100));
  const { data: sync } = useQuery((db) => syncStatus(db));
  const { data: serverOn } = useQuery(async (db) => (await loadSyncConfig(db)) !== null);

  return (
    <ScrollView
      style={st.screen}
      contentContainerStyle={[centred, { padding: space.lg, paddingBottom: space.xxl + bottomInset }]}
      showsVerticalScrollIndicator={false}
    >
      {/* The one question this screen exists to answer, at the size the other
          three tabs give their headline number.

          CLAUDE.md section 10 asks for a permanent "Last backup" line so she
          can answer "am I safe?" without tapping - but it was set in 16pt
          inside a card, smaller than the row titles under it, so the screen
          opened on a list of destinations rather than on the answer. Same
          string, same source; only the scale and the eyebrow are new. */}
      <T style={st.eyebrow}>Your data</T>
      <T style={st.headline}>{lastBackupLabel(lastBackupAt ?? null)}</T>

      <Card tone="soft" style={{ marginTop: space.md }}>
        <Row title="Back up / restore" onPress={() => router.push('/backup')} />
        {/* The pending count is the honest answer to "is my data safe?" - a
            server backup that is quietly 40 entries behind is worse than none,
            because it is believed. */}
        <Row
          title="Server backup"
          subtitle={
            sync == null
              ? undefined
              : sync.lastOkAt === null
                ? 'Not set up'
                : sync.pending > 0
                  ? `${sync.pending} ${sync.pending === 1 ? 'entry' : 'entries'} waiting to upload`
                  : 'Everything uploaded'
          }
          right={
            sync && sync.lastError && sync.pending > 0 ? <Badge text="NOT SENT" tone="neutral" /> : undefined
          }
          onPress={() => router.push('/sync')}
          last
        />
        <View style={{ marginTop: space.md }}>
          <BigButton
            accent="more"
            variant="outline"
            label={busy ? 'Uploading…' : 'Upload now'}
            sublabel={
              sync && sync.pending > 0
                ? `${sync.pending} ${sync.pending === 1 ? 'entry' : 'entries'} not on the server yet`
                : 'Send today\u2019s entries to the server'
            }
            onPress={uploadNow}
            disabled={busy}
          />
        </View>
      </Card>

      <SectionTitle>Reports</SectionTitle>
      <Card>
        <Row
          title="Given today"
          subtitle="Times, children and totals"
          onPress={() => router.push('/reports/today')}
        />
        <Row
          title="Missing child names"
          subtitle={
            missing?.length
              ? `${missing.length} ${missing.length === 1 ? 'dose has' : 'doses have'} no name`
              : 'Fill in doses logged without a name'
          }
          right={missing?.length ? <Badge text={String(missing.length)} tone="neutral" /> : undefined}
          onPress={() => router.push('/reports/today?missing=1')}
        />
        <Row
          title="All entries"
          subtitle="Full history, with corrections"
          onPress={() => router.push('/ledger')}
          last
        />
      </Card>

      <SectionTitle>Records</SectionTitle>
      <Card>
        <Row
          title="Children"
          subtitle="Saved names and histories"
          onPress={() => router.push('/children')}
        />
        <Row
          title="Settings"
          subtitle="Clinic name, about"
          onPress={() => router.push('/settings')}
          last
        />
      </Card>

      <T style={st.note}>
        {serverOn
          ? 'Saved on this phone first, and copied to the clinic server. Keep a screen lock on the phone.'
          : 'Records are only on this phone. Back them up regularly, and keep a screen lock on the phone.'}
      </T>
    </ScrollView>
  );
}

const st = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.bg },
  eyebrow: { fontSize: type.min, color: color.textMuted, fontWeight: weight.semibold },
  headline: {
    fontSize: type.big,
    fontWeight: weight.bold,
    color: color.text,
    marginTop: 2,
    lineHeight: 34,
  },
  note: {
    fontSize: type.min,
    color: color.textMuted,
    lineHeight: 21,
    marginTop: space.xl,
    paddingHorizontal: space.xs,
  },
});
