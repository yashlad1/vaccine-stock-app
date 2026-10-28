import React, { useState } from 'react';
import { Alert, ScrollView, StyleSheet, View } from 'react-native';
import { BigButton, ErrorState, Loading, Row, T, useBottomInset } from '../../ui/components';
import { color, radius, space, type, weight } from '../../ui/tokens';
import { centred } from '../../ui/layout';
import { useDb, useQuery } from '../../db/provider';
import { useToast } from '../../ui/snackbar';
import { SETTING, getNumber, getSetting, markBackedUp } from '../../db/repo/settings';
import { exportBackup, listLocalBackups } from '../../db/backup/export';
import { commitRestore, pickBackup, previewBackup } from '../../db/backup/import';
import { ledgerSummary } from '../../db/backup/validate';
import { lastBackupLabel } from '../../domain/backup-nag';
import { formatDate, formatTime12h } from '../../domain/time';

/** Readable row title from the snapshot file-name scheme; unknown names pass through. */
function backupTitle(name: string): string {
  let m = /^clinic-backup-(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})\.zip$/.exec(name);
  if (m) {
    const at = new Date(+m[1], +m[2] - 1, +m[3]).getTime();
    return `Backup, ${formatDate(at)}, ${formatTime12h(`${m[4]}:${m[5]}`)}`;
  }
  m = /^daily-(\d{4})-(\d{2})-(\d{2})\.db$/.exec(name);
  if (m) return `Daily copy, ${formatDate(new Date(+m[1], +m[2] - 1, +m[3]).getTime())}`;
  m = /^(?:premigration-v\d+-to-v\d+|prerestore)-(\d+)\.db$/.exec(name);
  if (m) {
    const kind = name.startsWith('prerestore') ? 'Saved before a restore' : 'Saved before an update';
    return `${kind}, ${formatDate(Number(m[1]))}`;
  }
  return name;
}

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
    current: await ledgerSummary(d),
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
        `This backup: ${preview.doses} ${preview.doses === 1 ? 'dose' : 'doses'}, ` +
          `${preview.vaccines} ${preview.vaccines === 1 ? 'vaccine' : 'vaccines'}` +
          (preview.latestEntryAt ? `, latest entry ${formatDate(preview.latestEntryAt)}` : '') +
          `\n\nYour phone now: ${meta.current.doses} ${meta.current.doses === 1 ? 'dose' : 'doses'}, ` +
          `${meta.current.vaccines} ${meta.current.vaccines === 1 ? 'vaccine' : 'vaccines'}` +
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
          {meta.lastBackupAt === null
            ? 'Nothing has been saved to a backup file yet.'
            : meta.dosesSinceBackup === 0
            ? 'Everything on this phone is backed up.'
            : `${meta.dosesSinceBackup} ${meta.dosesSinceBackup === 1 ? 'entry' : 'entries'} since the last backup.`}
        </T>
      </View>

      <View style={{ gap: space.md, marginTop: space.lg }}>
        <BigButton
          label={busy === 'export' ? 'Preparing…' : 'Back up now'}
          sublabel="Send it to yourself on WhatsApp or save to Drive"
          onPress={doExport}
          accent="more"
          disabled={!!busy}
        />
        <BigButton
          label="Restore from a backup"
          variant="outline"
          accent="more"
          onPress={doRestore}
          disabled={!!busy}
        />
      </View>

      <T style={st.section}>What is in a backup</T>
      <T style={st.body}>
        One file. It restores this phone exactly. It also has a list of doses you can open in
        Google Sheets.
      </T>

      <T style={st.section}>On this phone</T>
      {local?.length ? (
        local.slice(0, 10).map((f) => (
          <Row
            key={f.uri}
            title={backupTitle(f.name)}
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
  status: { fontSize: type.title, fontWeight: weight.bold, color: color.text },
  sub: { fontSize: type.label, color: color.textMuted, marginTop: space.xs },
  section: { fontSize: type.label, fontWeight: weight.bold, color: color.textMuted, marginTop: space.xl, marginBottom: space.sm },
  body: { fontSize: type.label, color: color.text, lineHeight: 24 },
  warn: { fontSize: type.label, color: color.low, fontWeight: weight.semibold, marginTop: space.lg, lineHeight: 22 },
});
