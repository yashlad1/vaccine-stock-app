import React, { useState } from 'react';
import { Alert, ScrollView, StyleSheet, View } from 'react-native';
import { BigButton, ErrorState, Loading, Row, T, useBottomInset } from '../../ui/components';
import { color, radius, space, type, weight } from '../../ui/tokens';
import { centred } from '../../ui/layout';
import { useDb, useQuery } from '../../db/provider';
import { useToast } from '../../ui/snackbar';
import { SETTING, getNumber, getSetting, markBackedUp } from '../../db/repo/settings';
import { exportBackup, listLocalBackups } from '../../db/backup/export';
import { commitRestore, describeCurrent, pickBackup, previewBackup } from '../../db/backup/import';
import { lastBackupLabel } from '../../domain/backup-nag';
import { formatDate } from '../../domain/time';

/**
 * The screen that decides whether this app is an improvement on paper or a
 * liability. Phone-only storage means a lost, stolen or reset phone loses the
 * ledger unless a backup left the device.
 */
export default function BackupScreen() {
  const bottomInset = useBottomInset();
  const { db, raw, deviceId, appVersion, bump } = useDb();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  const { data: meta, error, reload } = useQuery(async (d) => ({
    lastBackupAt: Number(await getSetting(d, SETTING.lastBackupAt)) || null,
    dosesSinceBackup: await getNumber(d, SETTING.dosesSinceBackup, 0),
    current: await describeCurrent(d),
  }));
  const { data: local, reload: reloadLocal } = useQuery(async () => listLocalBackups());

  if (error) return <ErrorState error={error} onRetry={reload} what="load your backup details" />;
  if (!meta) return <Loading />;

  const doExport = async () => {
    setBusy('export');
    try {
      const res = await exportBackup(db, raw, { appVersion, deviceId });
      await markBackedUp(db);
      bump();
      reloadLocal();
      toast.show(
        res.shared
          ? `Backup ready (${Math.round(res.sizeBytes / 1024)} KB). Send it to yourself.`
          : `Backup saved on this phone (${Math.round(res.sizeBytes / 1024)} KB).`,
      );
    } catch (e) {
      Alert.alert('Backup failed', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const doRestore = async () => {
    setBusy('restore');
    try {
      const picked = await pickBackup();
      if (!picked) return;

      // Opened in memory and fully inspected before a byte touches the live
      // database, so this confirmation can show real numbers.
      const { preview, candidate } = await previewBackup(picked);

      Alert.alert(
        'Restore from backup?',
        `This backup: ${preview.doses} doses, ${preview.vaccines} vaccines` +
          (preview.latestEntryAt ? `, latest entry ${formatDate(preview.latestEntryAt)}` : '') +
          `\n\nYour phone now: ${meta.current.doses} doses, ${meta.current.vaccines} vaccines` +
          (meta.current.latestEntryAt ? `, latest entry ${formatDate(meta.current.latestEntryAt)}` : '') +
          `\n\nRestoring replaces everything on this phone. A copy of your current data will be saved first.`,
        [
          {
            text: 'Cancel',
            style: 'cancel',
            onPress: () => void candidate.closeAsync().catch(() => undefined),
          },
          {
            text: 'Restore',
            style: 'destructive',
            onPress: async () => {
              try {
                await commitRestore(candidate, raw);
                bump();
                reloadLocal();
                toast.show('Data restored from backup.');
              } catch (e) {
                Alert.alert('Restore failed', e instanceof Error ? e.message : String(e));
              }
            },
          },
        ],
      );
    } catch (e) {
      // Rejections are specific on purpose: "restore failed" teaches nothing and
      // leaves her unsure whether her data is safe.
      Alert.alert('Cannot use that file', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <ScrollView style={st.screen} contentContainerStyle={[centred, { padding: space.lg, paddingBottom: space.xxl + bottomInset }]}>
      <View style={st.card}>
        <T style={st.status}>{lastBackupLabel(meta.lastBackupAt)}</T>
        <T style={st.sub}>
          {meta.dosesSinceBackup === 0
            ? 'Everything on this phone is backed up.'
            : `${meta.dosesSinceBackup} ${meta.dosesSinceBackup === 1 ? 'entry' : 'entries'} since the last backup.`}
        </T>
      </View>

      <View style={{ gap: space.md, marginTop: space.lg }}>
        <BigButton
          label={busy === 'export' ? 'Preparing…' : 'Back up now'}
          sublabel="Send it to yourself on WhatsApp or save to Drive"
          onPress={doExport}
          disabled={!!busy}
        />
        <BigButton
          label="Restore from a backup"
          variant="outline"
          onPress={doRestore}
          disabled={!!busy}
        />
      </View>

      <T style={st.section}>What is in a backup</T>
      <T style={st.body}>
        One zip file containing the full database (which is what restores exactly) plus
        spreadsheet-friendly CSVs (doses.csv, stock_movements.csv, vaccines.csv and
        patients.csv) that open in Excel or Google Sheets.
      </T>

      <T style={st.section}>On this phone</T>
      {local?.length ? (
        local.slice(0, 10).map((f) => (
          <Row
            key={f.uri}
            title={f.name}
            subtitle={f.size ? `${Math.round(f.size / 1024)} KB` : undefined}
          />
        ))
      ) : (
        <T style={st.body}>No local copies yet.</T>
      )}
      <T style={st.warn}>
        Copies on this phone do not survive a lost or reset phone. Always send the backup somewhere
        else as well.
      </T>
    </ScrollView>
  );
}

const st = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.bg },
  card: { padding: space.lg, borderRadius: radius.md, backgroundColor: color.surface, borderWidth: 1, borderColor: color.border },
  status: { fontSize: type.title, fontWeight: weight.semibold, color: color.text },
  sub: { fontSize: type.label, color: color.textMuted, marginTop: space.xs },
  section: { fontSize: type.label, fontWeight: weight.semibold, color: color.textMuted, marginTop: space.xl, marginBottom: space.sm },
  body: { fontSize: type.label, color: color.text, lineHeight: 24 },
  warn: { fontSize: type.label, color: color.low, fontWeight: weight.semibold, marginTop: space.lg, lineHeight: 22 },
});
