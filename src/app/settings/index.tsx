import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { BigButton, ErrorState, Field, Input, Row, T, s as base, useBottomInset } from '../../ui/components';
import { color, space, type, weight } from '../../ui/tokens';
import { centred } from '../../ui/layout';
import { useDb, useQuery } from '../../db/provider';
import { useToast } from '../../ui/snackbar';
import { useAction } from '../../ui/use-action';
import { SETTING, getSetting, setSetting } from '../../db/repo/settings';
import { loadSyncConfig } from '../../sync/config';
import { LATEST_VERSION } from '../../db/migrate';

export default function SettingsScreen() {
  const bottomInset = useBottomInset();
  const { db, deviceId, appVersion, bump } = useDb();
  const toast = useToast();
  const run = useAction();
  const [clinic, setClinic] = useState('');
  const { data: serverOn } = useQuery(async (db) => (await loadSyncConfig(db)) !== null);

  const { data: saved, error, reload } = useQuery((d) => getSetting(d, SETTING.clinicName));

  useEffect(() => {
    if (saved !== null && saved !== undefined) setClinic(saved);
  }, [saved]);

  if (error) return <ErrorState error={error} onRetry={reload} what="load settings" />;

  return (
    <ScrollView style={base.screen} contentContainerStyle={[centred, { padding: space.lg, paddingBottom: space.xxl + bottomInset }]}>
      <Field label="Clinic name" hint="Shown on exported reports.">
        <Input value={clinic} onChangeText={setClinic} autoCapitalize="words" />
      </Field>
      <BigButton
        label="Save clinic name"
        variant="outline"
        accent="more"
        onPress={() => void run('save the clinic name', async () => {
          await setSetting(db, SETTING.clinicName, clinic.trim());
          bump();
          toast.show('Saved.');
        })}
      />

      <T style={st.section}>About</T>
      <Row title="App version" subtitle={appVersion} />
      <Row title="Data format" subtitle={`v${LATEST_VERSION}`} />
      <Row title="This device" subtitle={deviceId.slice(0, 8)} />
      <View style={{ height: space.lg }} />
      <T style={st.note}>
        {serverOn
          ? 'Works with no internet. Records are saved on this phone and copied to the clinic server when there is signal.'
          : 'Works with no internet. Records are only on this phone, so back them up regularly.'}
      </T>
    </ScrollView>
  );
}

const st = StyleSheet.create({
  section: { fontSize: type.label, fontWeight: weight.bold, color: color.textMuted, marginTop: space.xl, marginBottom: space.sm },
  note: { fontSize: type.min, color: color.textMuted, lineHeight: 20 },
});
