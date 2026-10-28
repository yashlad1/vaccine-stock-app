/**
 * Vialbook — read-only dashboard.
 *
 * Opened from the home screen on a phone that is not in the clinic, to answer
 * two questions: is there stock, and did today actually get entered.
 *
 * Three rules shape it:
 *
 *  1. NO ARITHMETIC HERE. Every number comes from a Postgres view that mirrors
 *     the app's own definitions. Two implementations of "what is on hand" would
 *     drift, and the drifting one would still look authoritative.
 *  2. FRESHNESS BEFORE FIGURES. A stock count read at home while a device has
 *     not synced for hours is wrong and reads as fact. So staleness is stated
 *     above the numbers, not below them.
 *  3. READ ONLY. No write path exists in this file.
 */

const CFG = window.CLINIC_CONFIG;
const SESSION_KEY = 'clinic.session';

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------------------------------------------------------------- session */

const loadSession = () => {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); }
  catch { return null; }
};
const saveSession = (s) => localStorage.setItem(SESSION_KEY, JSON.stringify(s));
const clearSession = () => localStorage.removeItem(SESSION_KEY);

async function authRequest(path, body) {
  const r = await fetch(`${CFG.url}${path}`, {
    method: 'POST',
    headers: { apikey: CFG.key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.msg || j.error_description || `Sign-in failed (${r.status})`);
  return {
    access: j.access_token,
    refresh: j.refresh_token,
    // 60s of slack so a slow page load does not expire mid-request.
    expires: Date.now() + (j.expires_in - 60) * 1000,
  };
}

async function token() {
  let s = loadSession();
  if (!s) throw new Error('not signed in');
  if (Date.now() < s.expires) return s.access;
  // Refreshing keeps her signed in for months, so the password is typed once.
  s = await authRequest('/auth/v1/token?grant_type=refresh_token', { refresh_token: s.refresh });
  saveSession(s);
  return s.access;
}

async function read(pathAndQuery) {
  const t = await token();
  const r = await fetch(`${CFG.url}/rest/v1/${pathAndQuery}`, {
    headers: { apikey: CFG.key, Authorization: `Bearer ${t}` },
  });
  if (r.status === 401 || r.status === 403) throw new Error('signed out');
  if (!r.ok) throw new Error(`Could not load data (${r.status})`);
  return r.json();
}

/* ------------------------------------------------------------ formatting */

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function ago(ms) {
  if (!ms) return 'never';
  const mins = Math.floor((Date.now() - ms) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} ${hrs === 1 ? 'hour' : 'hours'} ago`;
  const days = Math.floor(hrs / 24);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}

/**
 * THE CLINIC RUNS ON IST, SO THIS PAGE DOES TOO - wherever it is opened from.
 *
 * Every date and time in the ledger is stamped by the phone in the clinic's own
 * local time. A dashboard that used the VIEWER's timezone would therefore
 * disagree with the ledger by a whole day. Measured, not theorised: at
 * 2026-09-10T02:00Z the clinic is mid-morning on the 10th, but
 * `new Date().getDate()` in America/New_York returns the 9th - so the hero
 * would read "0 doses" through a busy immunisation morning.
 *
 * India has no daylight saving, so the offset is a constant +05:30. The IANA
 * zone is still used rather than a hardcoded offset, because a hardcoded one is
 * a silent lie the day any rule changes.
 */
const CLINIC_TZ = 'Asia/Kolkata';
const CLINIC_TZ_OFFSET_MIN = 330;

const IST_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: CLINIC_TZ,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
});

/**
 * Read via `formatToParts`, not a formatted string: the layout of a locale's
 * output is not a contract, and parsing it back is how this breaks quietly on
 * some browser two years from now.
 */
function istParts(d = new Date()) {
  const p = {};
  for (const { type, value } of IST_PARTS.formatToParts(d)) p[type] = value;
  // Some engines render midnight as hour "24" under hour12:false.
  if (p.hour === '24') p.hour = '00';
  return p;
}

/** The clinic's wall clock, e.g. "3:04 pm". */
function clockTime(d = new Date()) {
  const p = istParts(d);
  const h = Number(p.hour);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${p.minute} ${h < 12 ? 'am' : 'pm'}`;
}

/**
 * Calendar arithmetic on a YYYY-MM-DD string, done in UTC on purpose.
 *
 * Pure calendar dates carry no timezone, and `setDate()` on a local Date would
 * drag the viewer's DST into a clinic date. `Date.UTC` has no such rules.
 */
function shiftDays(ymd, delta) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d) + delta * 86400000);
  const p = (n) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}

/**
 * The CLINIC's current date, matching how `local_date` is stamped at write time
 * on the phone. Not the server's date (it runs in UTC) and not the viewer's
 * (she may be reading this from anywhere).
 */
function todayLocal() {
  const p = istParts();
  return `${p.year}-${p.month}-${p.day}`;
}

/** How far back the entries list reaches. One constant, easy to change. */
const DAYS_BACK = 30;

/** A clinic date N days back, in the same YYYY-MM-DD shape as `local_date`. */
function sinceLocal(days) {
  return shiftDays(todayLocal(), -days);
}

/** The day currently being viewed, or null for the rolling window. */
let pickedDate = null;

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * "Today · Mon 8 Sep" for a stored `local_date`.
 *
 * Built from the split parts, NOT `new Date('2026-09-08')`. That form is
 * parsed as UTC midnight, so anywhere behind UTC it names the PREVIOUS day -
 * and this page is opened from wherever she happens to be. `new Date(y, m-1, d)`
 * is local by definition, which is what `local_date` already means.
 */
function dayHeading(localDate, today) {
  const [y, m, d] = String(localDate).split('-').map(Number);
  if (!y || !m || !d) return String(localDate);
  // getUTCDay on a UTC-constructed date gives the weekday of a pure calendar
  // date, independent of wherever the browser happens to be sitting.
  const wd = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  // The year only earns its space once it is not the current one - which
  // starts mattering the moment she searches back past January.
  const yr = String(today).slice(0, 4) === String(y) ? '' : ` ${y}`;
  const label = `${wd} ${d} ${MONTHS[m - 1]}${yr}`;
  if (localDate === today) return `Today · ${label}`;
  if (localDate === shiftDays(today, -1)) return `Yesterday · ${label}`;
  return label;
}

const PILL = { LOW: 'p-low', OUT: 'p-out', NEGATIVE: 'p-check', OK: 'p-ok' };
const WORD = { LOW: 'LOW', OUT: 'OUT', NEGATIVE: 'CHECK', OK: '' };
/** Lower case, for counting them in a sentence: "2 low · 1 out". */
const PLAIN = { LOW: 'low', OUT: 'out', NEGATIVE: 'to check' };

/* ---------------------------------------------------------------- render */

/** Two hours of silence during clinic hours is worth saying out loud. */
const STALE_MS = 2 * 60 * 60 * 1000;

/**
 * A fingerprint of everything on screen, so Refresh can answer the only
 * question a click actually asks: did anything change?
 *
 * Built from the fields that move when real work happens - each device's entry
 * count and last upload, and every vaccine's balance. Deliberately NOT the
 * whole payload: `synced_at` on an unrelated row would make every check look
 * like news, which is the same as telling her nothing.
 */
function signature(stock, devices, todayEntries) {
  return JSON.stringify([
    devices.map((d) => [d.device_id, d.entries, d.last_synced_at]).sort(),
    stock.map((s) => [s.vaccine_id, s.on_hand_doses]).sort(),
    todayEntries.length,
  ]);
}

let lastSignature = null;

function renderDevices(devices) {
  if (!devices.length) {
    $('devices').innerHTML = '<p class="meta">No entries recorded yet.</p>';
    return [];
  }
  const stale = [];
  $('devices').innerHTML = devices
    .map((d) => {
      const entryAt = Number(d.last_entry_at) || 0;
      const syncAt = d.last_synced_at ? new Date(d.last_synced_at).getTime() : 0;
      const isStale = syncAt && Date.now() - syncAt > STALE_MS;
      if (isStale) stale.push(d);
      return `<div class="row">
        <div class="grow">
          <div class="name">Device ${esc(String(d.device_id).slice(0, 6).toUpperCase())}</div>
          <div class="meta">last entry ${esc(ago(entryAt))} · reached the server ${esc(ago(syncAt))}</div>
        </div>
        ${isStale ? '<span class="pill p-low">BEHIND</span>' : '<span class="pill p-ok">UP TO DATE</span>'}
      </div>`;
    })
    .join('');
  return stale;
}

/** Most urgent first. Ordering in SQL would sort the WORDS alphabetically -
 *  LOW, NEGATIVE, OK, OUT - which is not a severity order. */
const RANK = { NEGATIVE: 0, OUT: 1, LOW: 2, OK: 3 };

/**
 * "Needs attention" stays a LIST, "All stock" becomes a GRID.
 *
 * They are read differently. The short list is a to-do, read top to bottom in
 * severity order. The full catalog is ~26 vaccines and the only question asked
 * of it is "how much of X is there" - which is a lookup, and a wall of
 * identical rows is the worst shape for a lookup. The grid is the same trick
 * the app's home screen uses, and `auto-fill` widens it on a laptop instead of
 * leaving a phone-width ribbon down the middle of the screen.
 */
function renderStock(rows) {
  const attention = rows
    .filter((r) => r.level !== 'OK')
    .sort((a, b) => (RANK[a.level] ?? 9) - (RANK[b.level] ?? 9));

  const pill = (r) =>
    r.level !== 'OK' ? `<span class="pill ${PILL[r.level]}">${WORD[r.level]}</span>` : '';

  const line = (r) => `<div class="row">
      <div class="grow">
        <div class="name">${esc(r.name)}</div>
        ${Number(r.min_balance_doses) > 0
          ? `<div class="meta">keep ${esc(r.min_balance_doses)} doses</div>` : ''}
      </div>
      ${pill(r)}
      <div class="num">${esc(r.on_hand_doses)}</div>
    </div>`;

  const tile = (r) => `<div class="tile lv-${esc(r.level)}">
      <div class="tname">${esc(r.name)}</div>
      ${pill(r)}
      <div class="tnum">${esc(r.on_hand_doses)} <span class="tunit">doses</span></div>
      ${r.level !== 'OK' && Number(r.min_balance_doses) > 0
        ? `<div class="meta">keep ${esc(r.min_balance_doses)}</div>` : ''}
    </div>`;

  $('attention').innerHTML = attention.length
    ? attention.map(line).join('')
    : '<p class="meta">Nothing low or out. Everything is above its safety limit.</p>';

  // The empty state is a sentence, not a tile, so it must not sit in a grid
  // cell 158px wide.
  $('stock').classList.toggle('grid', rows.length > 0);
  $('stock').innerHTML = rows.length
    ? rows.map(tile).join('')
    : '<p class="meta">No vaccines yet.</p>';

  // A count on the tab, so the reason to open Stock is visible from Today.
  $('stockBadge').textContent = attention.length ? String(attention.length) : '';
  $('attnCount').textContent = String(attention.length);
  $('attnNote').textContent = attention.length
    ? ['NEGATIVE', 'OUT', 'LOW']
        .map((l) => {
          const n = attention.filter((r) => r.level === l).length;
          return n ? `${n} ${PLAIN[l]}` : null;
        })
        .filter(Boolean)
        .join(' · ')
    : `All ${rows.length} above their safety limit`;
}

/**
 * Entries grouped by the day they were given, newest day first.
 *
 * Grouped on `local_date`, which the phone stamps at the moment of the tap, so
 * a day boundary here means the same thing it meant in the clinic - not what
 * the server's UTC clock thinks. The rows arrive already ordered, and a Map
 * preserves insertion order, so this file still sorts nothing itself.
 *
 * The child's name is the primary line because that is what she reads when
 * scanning a day; the vaccine and the time sit beneath it. A skipped name shows
 * as a muted "No name", which doubles as the day-end list of what to chase up.
 */
function renderEntries(rows, today, picked) {
  if (!rows.length) {
    $('entries').innerHTML = picked
      ? `<p class="meta">No doses recorded on ${esc(dayHeading(picked, today))}.</p>`
      : `<p class="meta">Nothing recorded in the last ${DAYS_BACK} days.</p>`;
    return;
  }

  const byDay = new Map();
  for (const m of rows) {
    if (!byDay.has(m.local_date)) byDay.set(m.local_date, []);
    byDay.get(m.local_date).push(m);
  }

  const out = [];
  for (const [date, list] of byDay) {
    const n = list.reduce((t, m) => t + Math.abs(Number(m.delta_doses) || 0), 0);
    out.push(`<div class="dayhead">
        <span>${esc(dayHeading(date, today))}</span>
        <span class="daycount">${n} ${n === 1 ? 'dose' : 'doses'}</span>
      </div>`);
    for (const m of list) {
      const qty = Math.abs(Number(m.delta_doses)) > 1
        ? ` × ${Math.abs(Number(m.delta_doses))}`
        : '';
      out.push(`<div class="row">
          <div class="grow">
            <div class="name${m.patient_label ? '' : ' noname'}">${
              esc(m.patient_label || 'No name')}</div>
            <div class="meta">${esc(m.local_time)} · ${
              esc(m.vaccine_name || 'Vaccine')}${qty}</div>
          </div>
        </div>`);
    }
  }
  $('entries').innerHTML = out.join('');
}

async function load() {
  const today = todayLocal();

  // Every figure comes from a view. Nothing is computed in this file.
  const COLS = 'local_date,local_time,delta_doses,patient_label,vaccine_id,tz_offset_minutes';

  // The list follows whatever day she is looking at; TODAY is fetched
  // separately and always. That separation is the point: the hero panel says
  // "Today", and it has to keep answering "did today get entered" even while
  // she is reading back through last Tuesday.
  const range = pickedDate
    ? `&local_date=eq.${pickedDate}`
    : `&local_date=gte.${sinceLocal(DAYS_BACK)}`;

  const [stock, devices, given, todayGiven] = await Promise.all([
    read('v_stock_on_hand?select=*&order=name.asc'),
    read('v_device_activity?select=*'),
    read(
      `v_movement_effective?select=${COLS}&movement_type=eq.ADMINISTRATION` +
      range + `&order=local_date.desc,local_time.desc`,
    ),
    read(
      `v_movement_effective?select=${COLS}&movement_type=eq.ADMINISTRATION` +
      `&local_date=eq.${today}&order=local_time.desc`,
    ),
  ]);

  // Fail loudly on an out-of-date view. Without this check `r.level !== 'OK'`
  // is true for every row, because `undefined !== 'OK'` - so every vaccine
  // would appear under "Needs attention" with a blank badge. A dashboard that
  // is confidently wrong is worse than one that says it cannot load.
  if (stock.length && !('level' in stock[0])) {
    throw new Error(
      'The server is out of date: v_stock_on_hand has no "level" column. ' +
      'Re-run supabase/schema.sql in the Supabase SQL Editor.',
    );
  }

  const nameOf = new Map(stock.map((s) => [s.vaccine_id, s.name]));
  const entries = given.map((g) => ({ ...g, vaccine_name: nameOf.get(g.vaccine_id) }));

  const doses = todayGiven
    .reduce((n, e) => n + Math.abs(Number(e.delta_doses) || 0), 0);

  // A device whose timezone is set wrong stamps every date and time it writes
  // incorrectly, and nothing on this page can detect that from the dates
  // alone - they look perfectly ordinary. The stored offset is the only
  // evidence, so it gets checked rather than trusted.
  const offEntries = entries.filter(
    (e) => e.tz_offset_minutes != null && Number(e.tz_offset_minutes) !== CLINIC_TZ_OFFSET_MIN);
  if (offEntries.length) {
    $('tzWarn').textContent =
      `${offEntries.length} ${offEntries.length === 1 ? 'entry was' : 'entries were'} saved ` +
      'by a device that is not set to Indian Standard Time, so its dates and ' +
      'times may be wrong. Check the date, time and time zone settings on that device.';
    $('tzWarn').classList.remove('hide');
  } else {
    $('tzWarn').classList.add('hide');
  }

  // Never offer a future day: there can be nothing there, and an empty result
  // reads as lost data rather than as a day that has not happened yet.
  $('pickDate').max = today;
  $('pickDate').value = pickedDate || '';
  // Just the figure: the tile's own label already says what it counts.
  $('todayCount').textContent = String(doses);

  const lastEntry = Math.max(0, ...devices.map((d) => Number(d.last_entry_at) || 0));
  $('lastEntry').textContent = lastEntry
    ? `Last entry ${ago(lastEntry)}`
    : 'Nothing has been recorded on any device yet.';

  const stale = renderDevices(devices);
  renderStock(stock);
  renderEntries(entries, today, pickedDate);

  // Freshness ABOVE the numbers, not below them.
  if (stale.length) {
    $('staleWarn').textContent =
      `${stale.length === 1 ? 'A device has' : `${stale.length} devices have`} not reached the ` +
      `server for over 2 hours. Anything entered there since is not shown below yet.`;
    $('staleWarn').classList.remove('hide');
  } else {
    $('staleWarn').classList.add('hide');
  }

  $('asOf').textContent = `Stock as of ${clockTime()} IST today`;
  $('footNote').textContent =
    'This page only reads. Doses and deliveries are recorded in the app on the clinic phone.';

  // Whether anything moved since the previous check, and when that check was.
  // `firstLoad` matters: on the very first load there is nothing to compare
  // against, and claiming "nothing new" then would be a guess dressed up as a
  // fact.
  const sig = signature(stock, devices, todayGiven);
  const firstLoad = lastSignature === null;
  const changed = !firstLoad && sig !== lastSignature;
  lastSignature = sig;

  $('checked').textContent = firstLoad
    ? `Checked ${clockTime()}`
    : changed
      ? `Checked ${clockTime()} — new entries loaded`
      : `Checked ${clockTime()} — nothing new since the last check`;

  return { changed, firstLoad };
}

/* ------------------------------------------------------------------ tabs */

/**
 * Three views instead of one endless column.
 *
 * Everything used to be stacked: today, devices, attention, the whole catalog,
 * then a month of entries - so the two controls at the bottom sat below a few
 * hundred rows, and "is there stock" meant scrolling past everything else.
 *
 * `data-tab` on <body> also drives the accent, so which view is open is legible
 * from the colour alone - the same safety cue the app's top tabs carry.
 */
function showTab(name) {
  document.body.dataset.tab = name;
  for (const b of document.querySelectorAll('.tab')) {
    b.setAttribute('aria-selected', String(b.dataset.tab === name));
  }
  for (const p of document.querySelectorAll('.pane')) {
    p.classList.toggle('hide', p.dataset.tab !== name);
  }
  window.scrollTo(0, 0);
}

$('tabs').addEventListener('click', (e) => {
  const b = e.target.closest('.tab');
  if (b) showTab(b.dataset.tab);
});

/* ------------------------------------------------------------------ boot */

function showLogin(msg) {
  $('dash').classList.add('hide');
  $('login').classList.remove('hide');
  if (msg) { $('loginError').textContent = msg; $('loginError').classList.remove('hide'); }
  $('email').value = $('email').value || CFG.email || '';
}

async function showDash() {
  $('login').classList.add('hide');
  $('dash').classList.remove('hide');
  $('loadError').classList.add('hide');
  try {
    return await load();
  } catch (e) {
    if (String(e.message).includes('signed out') || String(e.message).includes('not signed in')) {
      clearSession();
      showLogin('Please sign in again.');
    } else {
      // In the red banner above the figures, not in the subtitle. A page that
      // failed to load must not look like a page that loaded.
      $('loadError').textContent = e.message;
      $('loadError').classList.remove('hide');
      // Never leave a stale "Checked 3:04pm" implying this read succeeded.
      $('checked').textContent = `Could not check — last shown figures are from earlier`;
    }
    return null;
  }
}

$('signin').addEventListener('click', async () => {
  const btn = $('signin');
  btn.disabled = true;
  btn.textContent = 'Signing in…';
  $('loginError').classList.add('hide');
  try {
    saveSession(await authRequest('/auth/v1/token?grant_type=password', {
      email: $('email').value.trim(),
      password: $('password').value,
    }));
    $('password').value = '';
    await showDash();
  } catch (e) {
    showLogin(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign in';
  }
});

$('password').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('signin').click(); });

/**
 * Refresh has to SAY it did something.
 *
 * It always worked, but it re-rendered the same figures into the same DOM and
 * changed nothing on screen - and `asOf` is minute-resolution, so two clicks in
 * one minute produced byte-identical output. A button with no feedback is
 * indistinguishable from a broken button, and it got reported as broken.
 *
 * So: disabled with a label change while in flight, then a brief confirmation.
 * Same pattern the Sign in button already used.
 */
$('refresh').addEventListener('click', async () => {
  const btn = $('refresh');
  if (btn.disabled) return;
  btn.disabled = true;
  btn.textContent = 'Refreshing…';
  let result = null;
  try {
    result = await showDash();
  } finally {
    // The label answers the click; the line above it keeps the answer around
    // after the label reverts.
    btn.textContent = !result
      ? 'Refresh'
      : result.changed
        ? 'Updated'
        : 'No changes';
    btn.disabled = false;
    if (result) setTimeout(() => { btn.textContent = 'Refresh'; }, 1800);
  }
});
// Picking a day asks a different question of the same data. The Refresh
// comparison is deliberately NOT reset here: its baseline is today's entries,
// which do not change just because she is reading back through last Tuesday.
$('pickDate').addEventListener('change', () => {
  pickedDate = $('pickDate').value || null;
  void showDash();
});
$('pickClear').addEventListener('click', () => {
  pickedDate = null;
  void showDash();
});

$('signout').addEventListener('click', () => { clearSession(); showLogin(); });

// Coming back to the page is the moment the numbers matter, so re-read then.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && loadSession()) void showDash();
});

if (!CFG || !CFG.url || !CFG.key) {
  document.body.innerHTML =
    '<div class="wrap"><p class="err">config.js is missing. Copy web/config.example.js to ' +
    'web/config.js and fill it in.</p></div>';
} else if (loadSession()) {
  void showDash();
} else {
  showLogin();
}
