import { useRouter } from 'expo-router';
import { Banner } from './components';
import { useDb, useQuery } from '../db/provider';
import { SETTING, getNumber, getSetting, setSetting } from '../db/repo/settings';
import { backupNag } from '../domain/backup-nag';
import { syncStatus } from '../sync/push';
import { loadSyncConfig } from '../sync/config';

const SNOOZE_KEY = 'backup_snoozed_until';
const DAY = 86_400_000;

/** Non-modal, never blocking. It must not stand between the doctor and a dose. */
export function BackupBanner() {
  const router = useRouter();
  const { db, bump } = useDb();

  const { data } = useQuery(async (d) => {
    // The server copy counts as the second copy, so this banner has to know
    // whether uploading is actually working before it demands a zip.
    const status = await syncStatus(d);
    return {
      lastBackupAt: Number(await getSetting(d, SETTING.lastBackupAt)) || null,
      dosesSinceBackup: await getNumber(d, SETTING.dosesSinceBackup, 0),
      snoozedUntil: Number(await getSetting(d, SNOOZE_KEY)) || null,
      serverOn: (await loadSyncConfig(d)) !== null,
      pendingUploads: status.pending,
      lastUploadAt: status.lastOkAt,
    };
  });

  if (!data) return null;
  const nag = backupNag({ ...data, now: Date.now() });
  if (nag.level === 'none') return null;

  return (
    <Banner
      text={nag.message}
      tone={nag.level === 'overdue' ? 'danger' : 'low'}
      actionLabel="Back up"
      onAction={() => router.push('/backup')}
      onDismiss={
        nag.level === 'due'
          ? async () => {
              await setSetting(db, SNOOZE_KEY, String(Date.now() + DAY));
              bump();
            }
          : undefined
      }
    />
  );
}
