import React, { useEffect, useState } from 'react';
import { Alert, ScrollView, StyleSheet, View } from 'react-native';
import {
  BigButton, Chip, ErrorState, Field, Input, Loading, Row, SecondaryButton, SectionTitle, T, useBottomInset,
} from '../../ui/components';
import { color, space, type, weight } from '../../ui/tokens';
import { centred } from '../../ui/layout';
import { useDb, useQuery } from '../../db/provider';
import { useToast } from '../../ui/snackbar';
import { useAction } from '../../ui/use-action';
import { SYNC_SETTING, loadSyncConfig, saveSyncConfig } from '../../sync/config';
import { EMBEDDED_SYNC, hasEmbeddedSync } from '../../sync/embedded';
import { supabaseBackend } from '../../sync/backend.supabase';
import { pushOnce, syncStatus } from '../../sync/push';
import { previewServer, restoreFromServer } from '../../sync/restore';
import { getSetting } from '../../db/repo/settings';
import { formatDate } from '../../domain/time';

/**
 * Server backup setup.
 *
 * Behind More, not on a data-entry path: configured once, then never touched.
 * The phone stays the source of truth; this screen only decides whether a copy
 * is also kept off it.
 */
export default function SyncScreen() {
  const bottomInset = useBottomInset();
  const { db, deviceId, bump } = useDb();
  const toast = useToast();
  const run = useAction();

  const [url, setUrl] = useState('');
  const [key, setKey] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);

  const { data: saved, error, reload } = useQuery(async (d) => ({
    url: (await getSetting(d, SYNC_SETTING.url)) ?? '',
    key: (await getSetting(d, SYNC_SETTING.key)) ?? '',
    email: (await getSetting(d, SYNC_SETTING.email)) ?? '',
    password: (await getSetting(d, SYNC_SETTING.password)) ?? '',
    enabledRaw: await getSetting(d, SYNC_SETTING.enabled),
  }));
  const { data: status } = useQuery((d) => syncStatus(d));

  useEffect(() => {
    if (!saved) return;
    // Show whatever is actually in force: this phone's own settings if it has
    // any, otherwise the values the build shipped with. Blank fields on a build
    // that is already backing up would be a lie.
    setUrl(saved.url || EMBEDDED_SYNC?.url || '');
    setKey(saved.key || EMBEDDED_SYNC?.publishableKey || '');
    setEmail(saved.email || EMBEDDED_SYNC?.email || '');
    setPassword(saved.password || EMBEDDED_SYNC?.password || '');
    // Unset means "follow the build", so an embedded build reads as on.
    setEnabled(saved.enabledRaw === '1' || (saved.enabledRaw === null && hasEmbeddedSync));
  }, [saved]);

  if (error) return <ErrorState error={error} onRetry={reload} what="load your backup settings" />;
  if (!saved) return <Loading />;

  const complete = !!(url.trim() && key.trim() && email.trim() && password);

  const save = () =>
    void run('save these settings', async () => {
      await saveSyncConfig(db, { url, publishableKey: key, email, password, enabled });
      bump();
      toast.show(enabled ? 'Server backup is on.' : 'Saved. Server backup is off.');
    });

  const test = () =>
    void run('reach the server', async () => {
      setBusy(true);
      try {
        // Tested against what is on screen, not what is saved - otherwise a
        // typo has to be saved before it can be diagnosed.
        await supabaseBackend({ url, publishableKey: key, email, password }).ping();
        toast.show('Connected. The server is ready.');
      } finally {
        setBusy(false);
      }
    });

  const uploadNow = () =>
    void run('upload your entries', async () => {
      setBusy(true);
      try {
        const cfg = await loadSyncConfig(db);
        if (!cfg) return toast.showError('Turn server backup on and save first.');
        const out = await pushOnce(db, supabaseBackend(cfg), deviceId);
        bump();
        if (!out.ok) {
          return toast.showError(out.error ?? 'Upload failed. Your entries are safe on this phone.');
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

  const bringDown = () =>
    void run('read the server', async () => {
      setBusy(true);
      try {
        const cfg = await loadSyncConfig(db);
        if (!cfg) return toast.showError('Turn server backup on and save first.');
        const backend = supabaseBackend(cfg);
        // Same rule as the zip restore: real numbers BEFORE anything is
        // touched. A restore offered without counts asks for blind trust.
        const counts = await previewServer(backend);
        const here = (await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM stock_movements`))?.n ?? 0;
        const { stock_movements: there, vaccines } = counts;
        Alert.alert(
          'Bring records down from the server?',
          `The server has ${there} ${there === 1 ? 'entry' : 'entries'} and ` +
            `${vaccines} ${vaccines === 1 ? 'vaccine' : 'vaccines'}.\n\n` +
            `This phone has ${here} ${here === 1 ? 'entry' : 'entries'}.\n\n` +
            'Anything the server has and this phone does not will be added. Nothing on this phone ' +
            'is deleted or overwritten.',
          [
            { text: 'Cancel', style: 'cancel' },
            {
              text: 'Bring it down',
              onPress: () =>
                void run('bring down the records', async () => {
                  const report = await restoreFromServer(db, backend);
                  bump();
                  toast.show(
                    report.total
                      ? `Added ${report.total} ${report.total === 1 ? 'record' : 'records'}.`
                      : 'Nothing new. This phone already had everything.',
                  );
                }),
            },
          ],
        );
      } finally {
        setBusy(false);
      }
    });

  return (
    <ScrollView
      style={st.screen}
      contentContainerStyle={[centred, { padding: space.lg, paddingBottom: space.xxl + bottomInset }]}
      keyboardShouldPersistTaps="handled"
    >
      <T style={st.intro}>
        Your records always live on this phone, and the app works with no internet. Server backup
        keeps a second copy off the phone, so a lost or broken phone does not lose the register.
      </T>

      {hasEmbeddedSync ? (
        <T style={st.builtIn}>
          Already set up. This app was built with the clinic&apos;s server details, so backup runs
          on its own. Nothing below needs changing unless the server moves.
        </T>
      ) : null}

      <T style={st.section}>Status</T>
      <Row title="Waiting to upload" right={<T style={st.num}>{status?.pending ?? 0}</T>} />
      <Row
        title="Last successful upload"
        subtitle={status?.lastOkAt ? formatDate(status.lastOkAt) : 'Not yet'}
      />
      {status?.lastError ? <T style={st.err}>Last attempt failed: {status.lastError}</T> : null}

      <View style={{ gap: space.md, marginTop: space.md }}>
        <SecondaryButton accent="more" label="Upload now" onPress={uploadNow} />
        <SecondaryButton accent="more" label="Bring records down from the server" onPress={bringDown} />
      </View>

      <SectionTitle>Server details</SectionTitle>
      <Field label="Server backup">
        <View style={st.chipRow}>
          <Chip accent="more" label="On" selected={enabled} onPress={() => setEnabled(true)} />
          <Chip accent="more" label="Off" selected={!enabled} onPress={() => setEnabled(false)} />
        </View>
      </Field>

      <Field label="Project URL" hint="Supabase → Project Settings → API.">
        <Input
          value={url}
          onChangeText={setUrl}
          placeholder="https://xxxx.supabase.co"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />
      </Field>

      <Field label="Publishable key" hint="The key starting sb_publishable_. Never the secret one.">
        <Input value={key} onChangeText={setKey} autoCapitalize="none" autoCorrect={false} />
      </Field>

      <Field label="Clinic email">
        <Input
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
        />
      </Field>

      <Field label="Password">
        <Input value={password} onChangeText={setPassword} autoCapitalize="none" secureTextEntry />
      </Field>

      <View style={{ gap: space.md, marginTop: space.md }}>
        <SecondaryButton accent="more" label={busy ? 'Working…' : 'Test the connection'} onPress={test} />
        <BigButton accent="more" label="Save" onPress={save} disabled={enabled && !complete} />
      </View>

      <T style={st.note}>
        This does not replace the backup file. Keep taking those too: a zip you hold yourself is
        the one copy that does not depend on an account still working.
      </T>
    </ScrollView>
  );
}

const st = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.bg },
  intro: { fontSize: type.body, color: color.text, lineHeight: 26, marginBottom: space.lg },
  builtIn: {
    fontSize: type.label, color: color.text, fontWeight: weight.semibold,
    lineHeight: 24, marginBottom: space.lg,
  },
  chipRow: { flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' },
  section: {
    fontSize: type.label, fontWeight: weight.bold, color: color.text,
    letterSpacing: 0.8, marginTop: space.xl, marginBottom: space.sm,
  },
  num: { fontSize: type.title, fontWeight: weight.bold, color: color.text },
  err: { fontSize: type.min, color: color.danger, lineHeight: 21, marginTop: space.sm },
  note: { fontSize: type.min, color: color.textMuted, lineHeight: 21, marginTop: space.xl },
});
