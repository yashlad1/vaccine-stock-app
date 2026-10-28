import { useRouter } from 'expo-router';
import { Banner } from './components';
import { useQuery } from '../db/provider';
import { syncStatus } from '../sync/push';
import { loadSyncConfig } from '../sync/config';
import { syncNag } from '../domain/sync-nag';

/**
 * Tells you when uploading has stopped working, without being asked.
 *
 * Uploading is automatic, so nobody should need to find a button. The failure
 * that mattered was the SILENT one: sync quietly not working for hours while
 * the More tab - which nobody opens mid-clinic - was the only place that said
 * so.
 *
 * Non-modal and never blocking, like the backup banner. It sits above the
 * search field on the dose screen, so it is seen without being in the way of
 * recording a dose. Invariant 5 is not negotiable: this must never stand
 * between the clinician and a vaccination.
 */
export function SyncBanner() {
  const router = useRouter();

  const { data } = useQuery(async (d) => ({
    configured: (await loadSyncConfig(d)) !== null,
    status: await syncStatus(d),
  }));

  if (!data?.configured) return null; // no server set up: nothing to be behind

  const nag = syncNag({
    pending: data.status.pending,
    lastOkAt: data.status.lastOkAt,
    now: Date.now(),
  });
  if (nag.level === 'none') return null;

  return (
    <Banner
      text={nag.message}
      tone={nag.level === 'stuck' ? 'danger' : 'low'}
      // No "Upload now" here on purpose. It would invite tapping mid-clinic
      // for something the app already retries by itself, and the honest action
      // is to look at the detail rather than to press harder.
      actionLabel="Details"
      onAction={() => router.push('/sync')}
    />
  );
}
