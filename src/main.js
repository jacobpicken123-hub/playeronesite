/* =====================================================
   P1 — Player One Season Creator
   Vanilla JS single-page app
   ===================================================== */

/* =====================================================
   ▼ SUPABASE CLOUD LAYER ▼
   Wraps the existing localStorage-backed `state` with a cloud sync.
   - If P1_CONFIG.SUPABASE_URL is empty, the app runs in local-only mode (unchanged).
   - If filled in, the app shows a sign-in screen, hydrates state from cloud
     on login, and mirrors every saveState() to cloud in the background.

   To enable: set SUPABASE_URL and SUPABASE_ANON_KEY below to your project values.
   ===================================================== */
const P1_CONFIG = {
  SUPABASE_URL:      'https://ujrjjxxdwhlmgailrnbw.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVqcmpqeHhkd2hsbWdhaWxybmJ3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg1MTE5NTIsImV4cCI6MjA5NDA4Nzk1Mn0.4-uGvz_o69mgGzf9sjXh7jP5Qgeo_YsR8TQiMxG334o',
};

const CLOUD = (() => {
  // If config is empty, return a no-op shim — the app continues to work locally exactly as before.
  if (!P1_CONFIG.SUPABASE_URL || !P1_CONFIG.SUPABASE_ANON_KEY) {
    return { enabled: false };
  }
  if (typeof supabase === 'undefined') {
    console.warn('[P1] Supabase SDK not loaded — running in local-only mode');
    return { enabled: false };
  }
  const client = supabase.createClient(P1_CONFIG.SUPABASE_URL, P1_CONFIG.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  return { enabled: true, client };
})();

// Current signed-in user (null = signed out). Populated by cloudInit().
let currentUser = null;

// Track which save IDs originated in the cloud so we don't try to push them again on first sync
const cloudSaveIds = new Set();
// Diff-tracking: each entity's last-pushed hash. Lets us skip unchanged upserts
// during typing. Reset on sign-in / sign-out via cloudPullAllSaves.
let cloudLastPushHashes = {};
// In-flight write counter — used to debounce sync after a flurry of edits
let pendingCloudWrites = 0;
let cloudSyncTimer = null;
// Timestamp (ms) until which incoming realtime events are treated as echoes of
// our OWN writes and ignored. A counter alone wasn't enough: a big import push
// (hundreds of row inserts) takes longer than the counter stayed elevated, so
// the echoes slipped through and triggered partial re-pulls — making driver
// points visibly recalculate. This window stays up for the whole push + drain.
let cloudEchoSuppressUntil = 0;

/* ---------- AUTH wrappers ---------- */
async function cloudSignUp(email, password) {
  const { data, error } = await CLOUD.client.auth.signUp({
    email, password,
    options: { emailRedirectTo: window.location.origin },
  });
  if (error) throw error;
  return data;
}
async function cloudSignIn(email, password) {
  const { data, error } = await CLOUD.client.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}
async function cloudMagicLink(email) {
  const { error } = await CLOUD.client.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: window.location.origin },
  });
  if (error) throw error;
}
async function cloudGoogleSignIn() {
  const { error } = await CLOUD.client.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin },
  });
  if (error) throw error;
}
async function cloudSignOut() {
  await CLOUD.client.auth.signOut();
  // Clear all local state on sign-out so user B doesn't see user A's cached data
  localStorage.removeItem(STORAGE_KEY);
  location.reload();
}

/* ---------- CLOUD DATA: pull all saves user has access to into local `state` shape ----------
   Cloud rows live in normalized tables; we re-assemble them into the same shape your
   render code already expects (state.saves[id] = { id, name, seasons: { [seasonId]: {...} } }).
*/
async function cloudPullAllSaves(preferLocalIfNewer = false) {
  if (!CLOUD.enabled || !currentUser) return;

  // 1. Saves the user can access (via RLS — only owned/shared)
  const { data: saves, error: e1 } = await CLOUD.client
    .from('saves').select('*');
  if (e1) throw e1;

  const { data: seasons, error: e2 } = await CLOUD.client.from('seasons').select('*');
  if (e2) throw e2;
  const { data: teams, error: e3 } = await CLOUD.client.from('teams').select('*');
  if (e3) throw e3;
  const { data: drivers, error: e4 } = await CLOUD.client.from('drivers').select('*');
  if (e4) throw e4;
  const { data: races, error: e5 } = await CLOUD.client.from('races').select('*');
  if (e5) throw e5;
  const { data: rresults, error: e6 } = await CLOUD.client.from('race_results').select('*');
  if (e6) throw e6;
  const { data: sresults, error: e7 } = await CLOUD.client.from('sprint_results').select('*');
  if (e7) throw e7;
  const { data: members, error: e8 } = await CLOUD.client
    .from('save_members').select('save_id, user_id, role');
  if (e8) throw e8;

  // Build the in-memory tree
  const newSaves = {};
  cloudSaveIds.clear();
  for (const s of saves) {
    newSaves[s.id] = {
      id: s.id, name: s.name,
      createdAt: new Date(s.created_at).getTime(),
      updatedAt: new Date(s.updated_at).getTime(),
      seasons: {},
      _cloud: true,
      _members: members.filter(m => m.save_id === s.id),
    };
    cloudSaveIds.add(s.id);
  }
  for (const sn of seasons) {
    const save = newSaves[sn.save_id]; if (!save) continue;
    save.seasons[sn.id] = {
      id: sn.id, name: sn.name, year: sn.year,
      pointsSystemId: sn.points_system_id,
      polePointEnabled: sn.pole_point_enabled,
      polePointValue: sn.pole_point_value ?? 1,
      // Reconstruct the fields calcDriverStandings actually reads
      // (flPointEnabled / flPointValue) so a pulled season scores identically
      // to the locally-built one — otherwise points jump on every pull.
      // fl_point_value isn't stored separately in the cloud schema, so default
      // to 1 (the standard FL bonus, which matches buildSeasonFromImport).
      flPointEnabled: sn.fl_enabled,
      flPointValue: 1,
      flEnabled: sn.fl_enabled,
      drivers: [], teams: [], races: [],
      _cloud: true,
    };
  }
  // Teams under their season
  const teamsBySeason = {};
  for (const t of teams) {
    (teamsBySeason[t.season_id] ||= []).push({
      id: t.id, name: t.name, short: t.short, country: t.country,
      color: t.color, logo: t.logo, dsq: t.dsq,
      _updatedAt: t.updated_at ? new Date(t.updated_at).getTime() : null,
      _lastEditedBy: t.last_edited_by || null,
    });
  }
  // Drivers under their season
  const driversBySeason = {};
  for (const d of drivers) {
    (driversBySeason[d.season_id] ||= []).push({
      id: d.id, name: d.name, number: d.number, country: d.country,
      photo: d.photo, teamId: d.team_id, dsq: d.dsq,
      _updatedAt: d.updated_at ? new Date(d.updated_at).getTime() : null,
      _lastEditedBy: d.last_edited_by || null,
    });
  }
  // Races under their season, with results re-nested as arrays (matches local shape)
  const racesBySeason = {};
  const resultsByRace = {};
  const sprintByRace = {};
  for (const r of rresults) {
    (resultsByRace[r.race_id] ||= []).push({
      driverId: r.driver_id, position: r.position, time: r.time,
      dnf: r.dnf, dsq: r.dsq, dns: r.dns,
    });
  }
  for (const r of sresults) {
    (sprintByRace[r.race_id] ||= []).push({
      driverId: r.driver_id, position: r.position,
      dnf: r.dnf, dsq: r.dsq, dns: r.dns,
    });
  }
  for (const rc of races) {
    (racesBySeason[rc.season_id] ||= []).push({
      id: rc.id, round: rc.round, name: rc.name, circuit: rc.circuit,
      country: rc.country, flagImage: rc.flag_image,
      date: rc.date ? new Date(rc.date).getTime() : null,
      sprint: rc.sprint, completed: rc.completed,
      poleDriverId: rc.pole_driver_id,
      fastestLapDriverId: rc.fastest_lap_driver_id,
      results: resultsByRace[rc.id] || [],
      sprintResults: sprintByRace[rc.id] || [],
      _updatedAt: rc.updated_at ? new Date(rc.updated_at).getTime() : null,
      _lastEditedBy: rc.last_edited_by || null,
    });
    // Restore the per-race half/double-points multiplier (if the column exists).
    if (rc.point_multiplier !== undefined && rc.point_multiplier !== null) {
      state.racePointsMultipliers ||= {};
      const pm = Number(rc.point_multiplier);
      if (pm === 0.5 || pm === 2) state.racePointsMultipliers[rc.id] = pm;
      else delete state.racePointsMultipliers[rc.id];
    }
  }
  // Attach to seasons
  for (const seasonId of Object.keys(teamsBySeason)) {
    for (const save of Object.values(newSaves)) {
      if (save.seasons[seasonId]) save.seasons[seasonId].teams = teamsBySeason[seasonId];
    }
  }
  for (const seasonId of Object.keys(driversBySeason)) {
    for (const save of Object.values(newSaves)) {
      if (save.seasons[seasonId]) save.seasons[seasonId].drivers = driversBySeason[seasonId];
    }
  }
  for (const seasonId of Object.keys(racesBySeason)) {
    for (const save of Object.values(newSaves)) {
      if (save.seasons[seasonId]) save.seasons[seasonId].races = racesBySeason[seasonId];
    }
  }

  // Merge cloud saves into state. Cloud is authoritative EXCEPT, on the initial
  // reload, where a local save is newer than its cloud copy (edits the debounced
  // push hadn't flushed before the last reload) or exists only locally — those are
  // kept and queued for re-push, so a reload never silently reverts recent work.
  let needsRepush = false;
  if (preferLocalIfNewer) {
    for (const localId in (state.saves || {})) {
      const local = state.saves[localId];
      const cloud = newSaves[localId];
      if (!cloud) { newSaves[localId] = local; needsRepush = true; }
      else if ((local.updatedAt || 0) > (cloud.updatedAt || 0)) { newSaves[localId] = local; needsRepush = true; }
    }
  }
  state.saves = newSaves;
  if (state.activeSaveId && !newSaves[state.activeSaveId]) state.activeSaveId = null;
  if (state.activeSeasonId && state.activeSaveId && newSaves[state.activeSaveId] && !newSaves[state.activeSaveId].seasons[state.activeSeasonId]) state.activeSeasonId = null;

  // The cloud round-trip can lose a team's logo (e.g. large image payloads). Re-fill
  // any blank team logo from its matching preset in the local library so preset
  // images survive a reload / cloud sync.
  backfillTeamLogosFromPresets(); backfillDriverPhotosFromPresets();

  // Reset the push-hash cache: whatever we just pulled is now our up-to-date baseline.
  cloudLastPushHashes = {};

  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(stateForStorage())); } catch {}

  // If we kept any newer-local or local-only saves above, re-push them so the
  // cloud catches up to what's on screen.
  if (needsRepush) scheduleCloudSync();
}

/* ---------- CLOUD IMAGE STORAGE ----------
   Driver photos / team logos are large base64 data-URLs. Storing them inside the
   Postgres rows bloats the database toward Supabase's free-tier limit. Instead we
   upload them once to a Storage bucket ("season-images") and store only the short
   public URL in the row. If the bucket isn't set up yet (or anything fails), we
   return the original value so the app falls back to the previous base64 behavior
   — nothing breaks before the one-time bucket setup is done. */
const SEASON_IMAGE_BUCKET = 'season-images';
async function uploadImageToBucket(value, path) {
  if (!CLOUD.enabled || !currentUser) return value;
  // Already a URL (or empty) → nothing to upload.
  if (!value || typeof value !== 'string' || !value.startsWith('data:')) return value;
  try {
    const blob = await (await fetch(value)).blob();
    const ext = (blob.type && blob.type.split('/')[1]) || 'jpg';
    const key = `${currentUser.id}/${path}.${ext}`;
    const { error } = await CLOUD.client.storage.from(SEASON_IMAGE_BUCKET)
      .upload(key, blob, { upsert: true, contentType: blob.type || 'image/jpeg' });
    if (error) return value; // bucket missing / no policy → keep base64 for now
    const { data } = CLOUD.client.storage.from(SEASON_IMAGE_BUCKET).getPublicUrl(key);
    return data?.publicUrl || value;
  } catch { return value; }
}

/* ---------- CLOUD PUSH: serialize the active save tree and upsert into cloud ----------
   Called from saveState() after every local change. Debounced to avoid hammering the API.
*/
async function cloudPushActive() {
  if (!CLOUD.enabled || !currentUser) return;
  // Upgrade any legacy short IDs to proper UUIDs before pushing — Supabase rejects non-UUID strings
  upgradeIdsToUuids();
  // Push EVERY local save, not just the active one, so all seasons reach the cloud
  // and none silently disappear on the next reload.
  for (const save of Object.values(state.saves || {})) {
    if (!save) continue;
    try { await cloudPushOneSave(save); }
    catch (e) { console.warn('[P1] cloud push (save) failed', save.id, e); }
  }
}

async function cloudPushOneSave(save) {
  if (!CLOUD.enabled || !currentUser || !save) return;

  // First-time push of this save: use explicit INSERT (the only path the INSERT policy allows)
  // and immediately create the save_members owner row so subsequent updates pass user_is_save_owner().
  // Subsequent pushes of the same save: use explicit UPDATE (gated on owner role, which we now have).
  // Using upsert() here fails because Supabase evaluates BOTH the INSERT and UPDATE policies, and the
  // UPDATE policy requires us to already be an owner — which we aren't until the member row is inserted.
  if (!cloudSaveIds.has(save.id)) {
    // Brand new save → INSERT, then become owner
    const { error: eIns } = await CLOUD.client.from('saves').insert({ id: save.id, name: save.name });
    if (eIns) { console.warn('[P1] save insert failed', eIns); return; }
    const { error: eMem } = await CLOUD.client.from('save_members').insert({
      save_id: save.id, user_id: currentUser.id, role: 'owner',
    });
    if (eMem && eMem.code !== '23505') { // 23505 = duplicate key (already a member — harmless)
      console.warn('[P1] member insert failed', eMem);
      return;
    }
    cloudSaveIds.add(save.id);
    // Populate _members locally so the SHARE modal immediately reflects us as owner
    // (otherwise it sits empty until the next cloudPullAllSaves call).
    save._members = [{ save_id: save.id, user_id: currentUser.id, role: 'owner' }];
    save._cloud = true;
  } else {
    // Existing save → UPDATE name only
    const { error: eUpd } = await CLOUD.client.from('saves').update({ name: save.name }).eq('id', save.id);
    if (eUpd) { console.warn('[P1] save update failed', eUpd); return; }
  }

  // Upsert every season in this save
  // Each entity is hashed; we skip the cloud round-trip when the hash hasn't
  // changed since last successful push. Saves ~95% of wasted writes during typing.
  const hash = (o) => {
    // Stable, compact hash. JSON.stringify with sorted keys is enough at this scale.
    return JSON.stringify(o, Object.keys(o).sort());
  };
  for (const season of Object.values(save.seasons || {})) {
    const seasonRow = {
      id: season.id, save_id: save.id, name: season.name, year: season.year,
      points_system_id: season.pointsSystemId,
      pole_point_enabled: season.polePointEnabled || false,
      pole_point_value: season.polePointValue || 1,
      // calcDriverStandings reads season.flPointEnabled — persist THAT, not the
      // non-existent `flEnabled`. Reading the wrong field used to push a bogus
      // value, and on pull the real flPointEnabled came back undefined, so the
      // cloud copy scored fastest laps differently than the local build and the
      // driver points oscillated on every realtime pull.
      fl_enabled: season.flPointEnabled !== false,
    };
    const sh = hash(seasonRow);
    if (cloudLastPushHashes[`season:${season.id}`] !== sh) {
      const { error: eSn } = await CLOUD.client.from('seasons').upsert(seasonRow);
      if (eSn) { console.warn('[P1] season sync failed', eSn); continue; }
      cloudLastPushHashes[`season:${season.id}`] = sh;
    }

    // Teams — only push changed rows. Logos are uploaded to Storage first so the
    // row holds just a short URL instead of a big base64 blob.
    if (season.teams?.length) {
      const teamRows = [];
      for (const t of season.teams) {
        const logo = await uploadImageToBucket(t.logo, `teams/${t.id}`);
        if (logo && logo !== t.logo) t.logo = logo; // keep in-memory copy as the URL
        teamRows.push({
          id: t.id, season_id: season.id, name: t.name, short: t.short,
          country: t.country, color: t.color, logo: logo || null, dsq: t.dsq || false,
        });
      }
      const changed = teamRows.filter(r => cloudLastPushHashes[`team:${r.id}`] !== hash(r));
      if (changed.length) {
        const { error } = await CLOUD.client.from('teams').upsert(changed);
        if (!error) changed.forEach(r => cloudLastPushHashes[`team:${r.id}`] = hash(r));
      }
    }
    // Drivers — photos uploaded to Storage first (URL stored instead of base64).
    if (season.drivers?.length) {
      const drvRows = [];
      for (const d of season.drivers) {
        const photo = await uploadImageToBucket(d.photo, `drivers/${d.id}`);
        if (photo && photo !== d.photo) d.photo = photo; // keep in-memory copy as the URL
        drvRows.push({
          id: d.id, season_id: season.id, name: d.name, number: d.number,
          country: d.country, photo: photo || null, team_id: d.teamId || null,
          dsq: d.dsq || false,
        });
      }
      const changed = drvRows.filter(r => cloudLastPushHashes[`driver:${r.id}`] !== hash(r));
      if (changed.length) {
        const { error } = await CLOUD.client.from('drivers').upsert(changed);
        if (!error) changed.forEach(r => cloudLastPushHashes[`driver:${r.id}`] = hash(r));
      }
    }
    // Races — and for each race, replace results + sprint results
    if (season.races?.length) {
      const raceRows = season.races.map(r => ({
        id: r.id, season_id: season.id, round: r.round, name: r.name,
        circuit: r.circuit, country: r.country, flag_image: r.flagImage || null,
        date: r.date ? new Date(r.date).toISOString().slice(0, 10) : null,
        sprint: r.sprint || false, completed: r.completed || false,
        pole_driver_id: r.poleDriverId || null,
        fastest_lap_driver_id: r.fastestLapDriverId || null,
        // Half / double points per race, persisted so they survive a reload / new device.
        point_multiplier: racePointsMultiplier(r),
      }));
      const changedRaces = raceRows.filter(r => cloudLastPushHashes[`race:${r.id}`] !== hash(r));
      if (changedRaces.length) {
        let { error } = await CLOUD.client.from('races').upsert(changedRaces);
        if (error && /point_multiplier|column/i.test(error.message || '')) {
          // The point_multiplier column hasn't been added yet — retry without it so
          // races still sync. (Run the one-time ALTER TABLE to enable multiplier sync.)
          const stripped = changedRaces.map(({ point_multiplier, ...rest }) => rest);
          ({ error } = await CLOUD.client.from('races').upsert(stripped));
        }
        if (!error) changedRaces.forEach(r => cloudLastPushHashes[`race:${r.id}`] = hash(r));
      }
      // Results & sprint results — BATCHED. A fresh import has hundreds of result
      // rows; doing a delete+insert per race meant 40+ sequential round-trips that
      // could take many seconds. If a reload landed mid-push, the races not yet
      // uploaded came back empty on the next pull — their winners "disappeared".
      // Batching collapses it to a couple of bulk requests so the push is fast and
      // the delete→insert gap is tiny.
      const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };

      const flushResults = async (table, key, getRows) => {
        const changedRaces = [];
        const rows = [];
        for (const race of season.races) {
          const arr = getRows(race) || [];
          const h = hash(arr);
          if (arr.length && cloudLastPushHashes[`${key}:${race.id}`] !== h) {
            changedRaces.push({ id: race.id, h });
            for (const rr of arr) rows.push({ ...rr, race_id: race.id });
          }
        }
        if (!changedRaces.length) return;
        const { error: delErr } = await CLOUD.client.from(table)
          .delete().in('race_id', changedRaces.map(r => r.id));
        if (delErr) return; // leave hashes unset so the next push retries cleanly
        let ok = true;
        for (const part of chunk(rows, 500)) {
          const { error } = await CLOUD.client.from(table).insert(part);
          if (error) { ok = false; break; }
        }
        if (ok) changedRaces.forEach(r => cloudLastPushHashes[`${key}:${r.id}`] = r.h);
      };

      await flushResults('race_results', 'results', race => (race.results || []).map(rr => ({
        driver_id: rr.driverId, position: rr.position || null, time: rr.time || null,
        dnf: rr.dnf || false, dsq: rr.dsq || false, dns: rr.dns || false,
      })));
      await flushResults('sprint_results', 'sprint', race => (race.sprintResults || []).map(rr => ({
        driver_id: rr.driverId, position: rr.position || null,
        dnf: rr.dnf || false, dsq: rr.dsq || false, dns: rr.dns || false,
      })));
    }
  }
}

/* =====================================================
   CLOUD DELETION HELPERS
   ---------------------------------------------------------------
   These exist because the original cloud sync was upsert-only.
   When you deleted something locally, the cloud copy stayed alive,
   and the next pull (on sign-in, refresh, or any realtime event)
   would re-hydrate the deleted row from Supabase.

   Each helper:
   1. Issues an explicit DELETE to Supabase. CASCADE in the schema
      means deleting a save cascades to seasons → teams/drivers/races
      → race_results/sprint_results. So we only need to delete the
      topmost entity in each case.
   2. Strips the deleted entity's hashes from cloudLastPushHashes so
      the next push doesn't try to re-create it.
   3. Bumps pendingCloudWrites so the realtime echo of our own
      DELETE doesn't trigger a pull-down that overwrites local state
      during the brief window before our pull settles.

   All helpers are safe to call when CLOUD.enabled is false — they
   no-op silently. Local-only deletes still work as before.
   ===================================================== */
async function cloudDeleteSave(saveId) {
  if (!CLOUD.enabled || !currentUser || !saveId) return;
  pendingCloudWrites++;
  try {
    const { error } = await CLOUD.client.from('saves').delete().eq('id', saveId);
    if (error) console.warn('[P1] cloudDeleteSave failed', error);
    // Strip all hashes that referenced this save's seasons/teams/drivers/races
    // (we don't track save:<id> hashes, but its children may be tracked)
    for (const k of Object.keys(cloudLastPushHashes)) {
      // We can't know which child belongs to which save without a lookup,
      // so for a save-level delete just blow the whole cache. Next push
      // will recompute hashes for surviving saves from scratch.
      delete cloudLastPushHashes[k];
    }
    cloudSaveIds.delete(saveId);
  } finally {
    // Settle pending counter after a short delay so the realtime echo arrives during the hold window
    setTimeout(() => { pendingCloudWrites = Math.max(0, pendingCloudWrites - 1); }, 600);
  }
}

async function cloudDeleteSeason(seasonId) {
  if (!CLOUD.enabled || !currentUser || !seasonId) return;
  pendingCloudWrites++;
  try {
    const { error } = await CLOUD.client.from('seasons').delete().eq('id', seasonId);
    if (error) console.warn('[P1] cloudDeleteSeason failed', error);
    // Clean hashes for this season + any of its children that we track
    delete cloudLastPushHashes[`season:${seasonId}`];
    for (const k of Object.keys(cloudLastPushHashes)) {
      // We don't store the season-id on child hash keys, so we can't
      // selectively prune. Safe fallback: drop all team/driver/race/results
      // hashes — they'll be recomputed on next push.
      if (k.startsWith('team:') || k.startsWith('driver:') ||
          k.startsWith('race:') || k.startsWith('results:') || k.startsWith('sprint:')) {
        delete cloudLastPushHashes[k];
      }
    }
  } finally {
    setTimeout(() => { pendingCloudWrites = Math.max(0, pendingCloudWrites - 1); }, 600);
  }
}

async function cloudDeleteDriver(driverId) {
  if (!CLOUD.enabled || !currentUser || !driverId) return;
  pendingCloudWrites++;
  try {
    const { error } = await CLOUD.client.from('drivers').delete().eq('id', driverId);
    if (error) console.warn('[P1] cloudDeleteDriver failed', error);
    delete cloudLastPushHashes[`driver:${driverId}`];
    // Driver deletion cascades to race_results and sprint_results in the schema,
    // so those child caches need clearing too — they'll be re-pushed next time.
    for (const k of Object.keys(cloudLastPushHashes)) {
      if (k.startsWith('results:') || k.startsWith('sprint:')) delete cloudLastPushHashes[k];
    }
  } finally {
    setTimeout(() => { pendingCloudWrites = Math.max(0, pendingCloudWrites - 1); }, 600);
  }
}

async function cloudDeleteTeam(teamId) {
  if (!CLOUD.enabled || !currentUser || !teamId) return;
  pendingCloudWrites++;
  try {
    const { error } = await CLOUD.client.from('teams').delete().eq('id', teamId);
    if (error) console.warn('[P1] cloudDeleteTeam failed', error);
    delete cloudLastPushHashes[`team:${teamId}`];
    // Team deletion sets drivers.team_id = NULL (schema rule), so drivers may need re-push.
    for (const k of Object.keys(cloudLastPushHashes)) {
      if (k.startsWith('driver:')) delete cloudLastPushHashes[k];
    }
  } finally {
    setTimeout(() => { pendingCloudWrites = Math.max(0, pendingCloudWrites - 1); }, 600);
  }
}

async function cloudDeleteRace(raceId) {
  if (!CLOUD.enabled || !currentUser || !raceId) return;
  pendingCloudWrites++;
  try {
    const { error } = await CLOUD.client.from('races').delete().eq('id', raceId);
    if (error) console.warn('[P1] cloudDeleteRace failed', error);
    delete cloudLastPushHashes[`race:${raceId}`];
    delete cloudLastPushHashes[`results:${raceId}`];
    delete cloudLastPushHashes[`sprint:${raceId}`];
  } finally {
    setTimeout(() => { pendingCloudWrites = Math.max(0, pendingCloudWrites - 1); }, 600);
  }
}

// Debounced sync — called from saveState; coalesces a flurry of edits into one push
// ---------- cloud sync status badge ----------
// Shows the user whether their changes are still uploading. While it says
// "Saving…" they should NOT reload (the beforeunload guard below also warns them).
let cloudSyncStatus = 'idle'; // 'idle' | 'pending' | 'syncing' | 'saved' | 'error'
let _cloudSavedTimer = null;
function cloudSyncBadgeHTML() {
  if (!CLOUD.enabled || !currentUser) return '';
  const map = {
    idle:    { t: '✓ Saved',        c: 'sync-ok' },
    pending: { t: '⟳ Saving…',      c: 'sync-busy' },
    syncing: { t: '⟳ Saving…',      c: 'sync-busy' },
    saved:   { t: '✓ Saved',        c: 'sync-ok' },
    error:   { t: '⚠ Not saved',    c: 'sync-err' },
  };
  const m = map[cloudSyncStatus] || map.idle;
  const busy = cloudSyncStatus === 'syncing' || cloudSyncStatus === 'pending';
  const title = busy ? 'Uploading to the cloud — please wait before reloading'
    : cloudSyncStatus === 'error' ? 'Last upload failed — it will retry on your next change'
    : 'All changes are saved to the cloud';
  return `<span class="cloud-sync-badge ${m.c}" title="${title}">${m.t}</span>`;
}
function renderCloudSyncBadge() {
  const slot = document.getElementById('cloud-sync-slot');
  if (slot) slot.innerHTML = cloudSyncBadgeHTML();
}
function setCloudSyncStatus(s) {
  cloudSyncStatus = s;
  renderCloudSyncBadge();
  if (s === 'saved') {
    clearTimeout(_cloudSavedTimer);
    _cloudSavedTimer = setTimeout(() => { if (cloudSyncStatus === 'saved') { cloudSyncStatus = 'idle'; renderCloudSyncBadge(); } }, 4000);
  }
}

function scheduleCloudSync() {
  if (!CLOUD.enabled || !currentUser) return;
  pendingCloudWrites++;
  setCloudSyncStatus('pending');
  clearTimeout(cloudSyncTimer);
  cloudSyncTimer = setTimeout(async () => {
    // Hold the echo-suppression window across the ENTIRE push. cloudPushActive()
    // can insert hundreds of rows for a freshly imported season; each insert
    // fires a realtime event back at us. We must keep ignoring those echoes
    // until the push finishes, otherwise a mid-push pull sees partial results
    // and the on-screen driver points keep recalculating. A generous ceiling
    // covers even a very large import; it's reset to a short drain window the
    // moment the push actually resolves.
    cloudEchoSuppressUntil = Date.now() + 60000;
    setCloudSyncStatus('syncing');
    let okPush = true;
    try {
      await cloudPushActive();
    } catch (e) {
      okPush = false;
      console.warn('[P1] cloud push failed', e);
      // Don't toast on every failure — just log. Local save still worked.
    } finally {
      // Push settled — keep ignoring our own trailing echoes for a short drain
      // window, then resume reacting to genuine remote (collaborator) changes.
      pendingCloudWrites = 0;
      cloudEchoSuppressUntil = Date.now() + 2500;
      setCloudSyncStatus(okPush ? 'saved' : 'error');
    }
  }, 800);
}

// Push to the cloud RIGHT NOW (not debounced) and block the UI with an overlay
// until it finishes — used after an import so the user physically waits for the
// whole season to finish uploading before they can touch anything (no reload mid-push).
async function cloudPushNowBlocking(message) {
  if (!CLOUD.enabled || !currentUser) return true; // local-only: nothing to wait for
  clearTimeout(cloudSyncTimer);
  pendingCloudWrites++;
  cloudEchoSuppressUntil = Date.now() + 120000;
  setCloudSyncStatus('syncing');
  showSyncOverlay(message || 'Uploading to the cloud…');
  let ok = true;
  try { await cloudPushActive(); }
  catch (e) { ok = false; console.warn('[P1] blocking cloud push failed', e); }
  finally {
    pendingCloudWrites = 0;
    cloudEchoSuppressUntil = Date.now() + 2500;
    setCloudSyncStatus(ok ? 'saved' : 'error');
    hideSyncOverlay();
  }
  return ok;
}

function showSyncOverlay(message) {
  let el = document.getElementById('sync-overlay');
  if (!el) { el = document.createElement('div'); el.id = 'sync-overlay'; el.className = 'sync-overlay'; document.body.appendChild(el); }
  el.innerHTML = `
    <div class="sync-overlay-card">
      <div class="sync-overlay-title">⟳ Saving to cloud</div>
      <div class="sync-overlay-msg">${esc(message || '')}</div>
      <div class="sync-overlay-sub">Please don't close or reload this tab until it finishes.</div>
    </div>`;
  el.style.display = 'flex';
}
function hideSyncOverlay() {
  const el = document.getElementById('sync-overlay');
  if (el) el.remove();
}

// Best-effort: when the page is being hidden/closed/reloaded, flush any pending
// (debounced) cloud write immediately instead of waiting out the timer — so a quick
// reload doesn't lose the last edit. If the request gets cut off mid-flight, the
// next load's "prefer newer local" merge still recovers it from localStorage.
(function wireCloudFlushOnExit() {
  if (typeof window === 'undefined') return;
  const flush = () => {
    if (!CLOUD.enabled || !currentUser || pendingCloudWrites <= 0) return;
    clearTimeout(cloudSyncTimer);
    cloudEchoSuppressUntil = Date.now() + 60000;
    try { cloudPushActive(); } catch {}
  };
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
  // Warn before leaving/reloading while a cloud upload is still pending or running,
  // so the user doesn't reload mid-push and lose race results.
  window.addEventListener('beforeunload', (e) => {
    if (CLOUD.enabled && currentUser &&
        (pendingCloudWrites > 0 || cloudSyncStatus === 'pending' || cloudSyncStatus === 'syncing')) {
      flush();
      e.preventDefault();
      e.returnValue = 'Still saving to the cloud — wait a moment before leaving so your changes are not lost.';
      return e.returnValue;
    }
  });
})();

/* ---------- COLLABORATION: invite + accept ---------- */
async function cloudInvite(saveId, role = 'editor') {
  if (!CLOUD.enabled || !currentUser) throw new Error('Not signed in');
  // The RLS policy requires invited_by = auth.uid() — set it explicitly.
  // We pass a placeholder email since the token is the real secret; if you later
  // wire up SMTP, replace 'shared-link' with the recipient's actual email.
  const { data, error } = await CLOUD.client.from('invitations').insert({
    save_id: saveId,
    invited_email: 'shared-link',
    invited_by: currentUser.id,
    role,
  }).select().single();
  if (error) throw error;
  return `${window.location.origin}${window.location.pathname}?invite=${data.token}`;
}

// FEATURE #1 — Member kick: remove a collaborator from a save
async function cloudRemoveMember(saveId, userId) {
  if (!CLOUD.enabled || !currentUser) throw new Error('Not signed in');
  const { error } = await CLOUD.client
    .from('save_members')
    .delete()
    .eq('save_id', saveId)
    .eq('user_id', userId);
  if (error) throw error;
  // Update local cache so the SHARE modal refreshes without a round-trip
  const save = state.saves[saveId];
  if (save?._members) save._members = save._members.filter(m => m.user_id !== userId);
}

// FEATURE #2 — Change a member's role between editor and viewer
async function cloudUpdateMemberRole(saveId, userId, newRole) {
  if (!CLOUD.enabled || !currentUser) throw new Error('Not signed in');
  if (!['editor', 'viewer'].includes(newRole)) throw new Error('Invalid role');
  const { error } = await CLOUD.client
    .from('save_members')
    .update({ role: newRole })
    .eq('save_id', saveId)
    .eq('user_id', userId);
  if (error) throw error;
  const save = state.saves[saveId];
  if (save?._members) {
    const m = save._members.find(x => x.user_id === userId);
    if (m) m.role = newRole;
  }
}

// FEATURE #11 — Public read-only share links
async function cloudEnablePublicShare(saveId) {
  if (!CLOUD.enabled || !currentUser) throw new Error('Not signed in');
  // Check if already public
  const { data: existing } = await CLOUD.client
    .from('public_shares').select('slug').eq('save_id', saveId).maybeSingle();
  if (existing?.slug) {
    return `${window.location.origin}${window.location.pathname}?view=${existing.slug}`;
  }
  const { data, error } = await CLOUD.client
    .from('public_shares')
    .insert({ save_id: saveId, enabled_by: currentUser.id })
    .select('slug').single();
  if (error) throw error;
  return `${window.location.origin}${window.location.pathname}?view=${data.slug}`;
}
async function cloudDisablePublicShare(saveId) {
  if (!CLOUD.enabled || !currentUser) throw new Error('Not signed in');
  const { error } = await CLOUD.client
    .from('public_shares').delete().eq('save_id', saveId);
  if (error) throw error;
}
async function cloudGetPublicShareSlug(saveId) {
  if (!CLOUD.enabled) return null;
  const { data } = await CLOUD.client
    .from('public_shares').select('slug').eq('save_id', saveId).maybeSingle();
  return data?.slug || null;
}
// Anonymous fetch: read a public save by its slug (no auth required)
async function cloudFetchPublicSave(slug) {
  if (!CLOUD.enabled) throw new Error('Cloud disabled');
  const { data, error } = await CLOUD.client.rpc('get_public_save', { public_slug: slug });
  if (error) throw error;
  return data; // jsonb object with save/seasons/teams/drivers/races/results
}

async function cloudAcceptInvite(token) {
  if (!CLOUD.enabled || !currentUser) throw new Error('Not signed in');
  const { data, error } = await CLOUD.client.rpc('accept_invitation', {
    invitation_token: token,
  });
  if (error) throw error;
  return data; // joined save_id
}

/* ---------- REALTIME: subscribe to changes on saves the user has access to ---------- */
let cloudRealtimeChannel = null;
function cloudSubscribeRealtime() {
  if (!CLOUD.enabled || !currentUser) return;
  if (cloudRealtimeChannel) {
    CLOUD.client.removeChannel(cloudRealtimeChannel);
  }
  // Listen to changes on all relevant tables; RLS makes sure we only get events for accessible rows.
  cloudRealtimeChannel = CLOUD.client.channel('p1-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'saves' }, onCloudChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'seasons' }, onCloudChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'teams' }, onCloudChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'drivers' }, onCloudChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'races' }, onCloudChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'race_results' }, onCloudChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'sprint_results' }, onCloudChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'save_members' }, onCloudChange)
    .subscribe();
}
// On any incoming change, re-pull everything and re-render. Cheap because there are at most a handful of saves.
let realtimeMergeTimer = null;
function onCloudChange(payload) {
  // Ignore changes we just pushed (avoids feedback loops). We skip while either
  // a write is pending OR we're still inside the post-push echo window — the
  // latter covers big imports whose row inserts echo back over several seconds.
  if (pendingCloudWrites > 0 || Date.now() < cloudEchoSuppressUntil) return;
  clearTimeout(realtimeMergeTimer);
  realtimeMergeTimer = setTimeout(async () => {
    try {
      await cloudPullAllSaves();
      renderAll();
    } catch (e) { console.warn('[P1] realtime merge failed', e); }
  }, 300);
}

// FEATURE #3 — Presence: show who else is currently viewing the active save.
// Each save has its own presence channel. When you select a save we join it
// and announce ourselves; we leave when you change saves or sign out.
let presenceChannel = null;
let presenceState = {};  // { user_id: { email, joinedAt } }
function cloudSubscribePresence(saveId) {
  if (!CLOUD.enabled || !currentUser || !saveId) return;
  if (presenceChannel) {
    CLOUD.client.removeChannel(presenceChannel);
    presenceChannel = null;
    presenceState = {};
  }
  presenceChannel = CLOUD.client.channel(`presence:save:${saveId}`, {
    config: { presence: { key: currentUser.id } },
  });
  presenceChannel
    .on('presence', { event: 'sync' }, () => {
      // Rebuild local presence state from the channel
      const newState = presenceChannel.presenceState();
      const flat = {};
      for (const userId of Object.keys(newState)) {
        const entries = newState[userId];
        if (entries.length) {
          flat[userId] = { email: entries[0].email, joinedAt: entries[0].joinedAt };
        }
      }
      presenceState = flat;
      renderPresenceDots();
    })
    .subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        await presenceChannel.track({
          email: currentUser.email,
          joinedAt: Date.now(),
        });
      }
    });
}
function renderPresenceDots() {
  const slot = $('#presence-slot');
  if (!slot) return;
  const others = Object.entries(presenceState).filter(([uid]) => uid !== currentUser?.id);
  if (!others.length) { slot.innerHTML = ''; return; }
  slot.innerHTML = others.map(([uid, info]) => {
    const initials = (info.email || '?').slice(0, 2).toUpperCase();
    const color = `hsl(${Math.abs([...uid].reduce((a,c) => a + c.charCodeAt(0), 0)) % 360}, 60%, 55%)`;
    return `<span class="presence-dot" style="background:${color}" title="${esc(info.email)} is here">${esc(initials)}</span>`;
  }).join('');
}

/* ---------- INIT: detect signed-in user on boot, hydrate, then render ---------- */
async function cloudInit() {
  if (!CLOUD.enabled) return false;

  // FEATURE #11: Public read-only view. If URL has ?view=SLUG, render in
  // public mode (no auth required, no edits possible) and return true so we
  // skip the sign-in screen.
  const viewSlug = new URLSearchParams(location.search).get('view');
  if (viewSlug) {
    try {
      const data = await cloudFetchPublicSave(viewSlug);
      if (data) {
        renderPublicView(data);
        return true;
      } else {
        // Slug invalid — fall through to normal flow
        toast('Public link not found — it may have been disabled.', 'error');
      }
    } catch (e) {
      console.warn('Public-view fetch failed', e);
    }
  }

  // Catch ?invite=TOKEN before showing sign-in
  const inviteToken = new URLSearchParams(location.search).get('invite');

  // Listen for auth changes so we re-hydrate after sign-in
  CLOUD.client.auth.onAuthStateChange((event, session) => {
    if (isPublicView) return; // Don't re-render over a public view
    const newUser = session?.user || null;
    const wasSignedIn = !!currentUser;
    currentUser = newUser;
    if (newUser && !wasSignedIn) {
      // Just signed in — pull data, accept any pending invite, render
      (async () => {
        try {
          if (inviteToken) {
            await cloudAcceptInvite(inviteToken).catch(e =>
              toast('Invite link is invalid or expired: ' + e.message, 'error'));
            // Strip the token from the URL
            const url = new URL(location.href); url.searchParams.delete('invite');
            history.replaceState({}, '', url.toString());
          }
          await cloudPullAllSaves();
          cloudSubscribeRealtime();
          renderAll();
        } catch (e) { console.warn('[P1] post-signin hydrate failed', e); }
      })();
    } else if (!newUser && wasSignedIn) {
      // Signed out — reload to clear
      location.reload();
    }
  });

  // Check current session synchronously
  const { data: { session } } = await CLOUD.client.auth.getSession();
  currentUser = session?.user || null;

  if (currentUser) {
    // Already signed in — upgrade any legacy short IDs in localStorage to UUIDs,
    // then accept invite if present, pull, subscribe, return true to skip login UI
    upgradeIdsToUuids();
    if (inviteToken) {
      try {
        await cloudAcceptInvite(inviteToken);
        const url = new URL(location.href); url.searchParams.delete('invite');
        history.replaceState({}, '', url.toString());
      } catch (e) { console.warn('Could not accept invite:', e.message); }
    }
    // Initial reload while already signed in: keep any local edits newer than the
    // cloud copy so a refresh doesn't revert work the debounced push hadn't flushed.
    await cloudPullAllSaves(true);
    cloudSubscribeRealtime();
    return true;
  }
  return false; // not signed in
}

/* ---------- PUBLIC READ-ONLY VIEW (Feature #11) ---------- */
let isPublicView = false;
function renderPublicView(data) {
  isPublicView = true;
  // Suppress topbar/tabs — clean focused viewing experience
  $('#topbar-selectors').innerHTML = '';
  $('#topbar-actions').innerHTML = `<a href="${esc(window.location.origin + window.location.pathname)}" class="btn btn-ghost btn-sm">⚡ Make your own P1 universe</a>`;
  $('#tabs').innerHTML = '';

  const root = $('#app');
  const save = data.save || {};
  const seasons = (data.seasons || []).slice().sort((a, b) => (b.season?.year || 0) - (a.season?.year || 0));
  // Default to most recent season
  let activeIdx = 0;

  const renderShell = () => {
    const sn = seasons[activeIdx]?.season;
    const teams = seasons[activeIdx]?.teams || [];
    const drivers = seasons[activeIdx]?.drivers || [];
    const races = (seasons[activeIdx]?.races || []).slice().sort((a, b) => (a.race?.round || 0) - (b.race?.round || 0));

    // Compute standings from the season data
    let standings = [];
    if (sn && drivers.length) {
      const localShape = {
        ...sn,
        pointsSystemId: sn.points_system_id,
        flPointEnabled: sn.fl_enabled,
        flPointValue: 1,
        flEnabled: sn.fl_enabled,
        polePointEnabled: sn.pole_point_enabled,
        polePointValue: sn.pole_point_value ?? 1,
        drivers: drivers.map(d => ({ id: d.id, name: d.name, number: d.number, teamId: d.team_id, dsq: d.dsq })),
        teams,
        races: races.map(r => ({
          ...r.race,
          completed: r.race?.completed,
          sprint: r.race?.sprint,
          fastestLapDriverId: r.race?.fastest_lap_driver_id,
          poleDriverId: r.race?.pole_driver_id,
          results: (r.results || []).map(x => ({ driverId: x.driver_id, position: x.position, dnf: x.dnf, dsq: x.dsq, dns: x.dns })),
          sprintResults: (r.sprintResults || []).map(x => ({ driverId: x.driver_id, position: x.position, dnf: x.dnf, dsq: x.dsq, dns: x.dns })),
        })),
      };
      try { standings = calcDriverStandings(localShape); } catch {}
    }

    root.innerHTML = `
      <div class="public-view">
        <div class="public-head">
          <div class="public-eyebrow">PLAYER ONE · PUBLIC VIEW</div>
          <h1 class="public-title">${esc(save.name || 'Untitled Save')}</h1>
          <div class="public-sub">A fictional motorsport universe · shared in read-only mode</div>
        </div>

        ${seasons.length > 1 ? `
        <div class="f1-filter-strip" style="margin-bottom:24px">
          ${seasons.map((s, i) => `<button class="f1-filter ${i === activeIdx ? 'active' : ''}" data-idx="${i}">${esc(String(s.season?.year || ''))} · ${esc(s.season?.name || '')}</button>`).join('')}
        </div>` : ''}

        <div class="public-section">
          <h2 class="public-section-title">CHAMPIONSHIP STANDINGS</h2>
          ${standings.length ? `
            <table class="public-table">
              <thead><tr><th>#</th><th>Driver</th><th>Team</th><th>Pts</th><th>W</th><th>P</th></tr></thead>
              <tbody>
                ${standings.slice(0, 20).map((row, i) => {
                  const drv = drivers.find(d => d.id === row.driverId);
                  const team = drv ? teams.find(t => t.id === drv.team_id) : null;
                  return `<tr ${i===0?'class="public-champ"':''}>
                    <td>${i+1}</td>
                    <td>${esc(drv?.name || '—')}</td>
                    <td style="color:${esc(team?.color || 'inherit')}">${esc(team?.name || '—')}</td>
                    <td><b>${row.points}</b></td>
                    <td>${row.wins}</td>
                    <td>${row.podiums}</td>
                  </tr>`;
                }).join('')}
              </tbody>
            </table>` : '<div class="empty-row">No completed races yet.</div>'}
        </div>

        <div class="public-section">
          <h2 class="public-section-title">CALENDAR · ${races.length} ROUND${races.length === 1 ? '' : 'S'}</h2>
          <div class="public-calendar">
            ${races.map(r => {
              const rr = r.race || {};
              const winner = (r.results || []).find(x => x.position === 1);
              const winnerDrv = winner ? drivers.find(d => d.id === winner.driver_id) : null;
              return `<div class="public-race-row ${rr.completed ? '' : 'pending'}">
                <div class="public-race-num">R${rr.round}</div>
                <div class="public-race-name">${esc(rr.name)}<div class="public-race-circuit">${esc(rr.circuit || '')}</div></div>
                <div class="public-race-winner">${rr.completed ? (winnerDrv ? '🏆 ' + esc(winnerDrv.name) : '—') : '<span style="color:var(--text-muted)">upcoming</span>'}</div>
              </div>`;
            }).join('')}
          </div>
        </div>

        <div class="public-section">
          <h2 class="public-section-title">${drivers.length} DRIVERS · ${teams.length} TEAMS</h2>
          <div class="public-roster">
            ${drivers.map(d => {
              const team = teams.find(t => t.id === d.team_id);
              return `<div class="public-driver-card" style="--team-color:${esc(team?.color || '#666')}">
                <div class="public-driver-num">${d.number || '–'}</div>
                <div class="public-driver-info">
                  <div class="public-driver-name">${esc(d.name)}</div>
                  <div class="public-driver-team">${esc(team?.name || 'Free agent')} · ${flag(d.country)} ${esc(d.country || '')}</div>
                </div>
              </div>`;
            }).join('')}
          </div>
        </div>

        <div class="public-foot">
          Made with <a href="${esc(window.location.origin + window.location.pathname)}">P1 — Player One Season Creator</a>
        </div>
      </div>`;

    $$('.f1-filter[data-idx]', root).forEach(b => {
      b.onclick = () => { activeIdx = +b.dataset.idx; renderShell(); };
    });
  };
  renderShell();
}

/* ---------- SIGN-IN UI: shown when cloud is enabled and no user signed in ---------- */
function renderSignInScreen() {
  const root = $('#app');
  root.innerHTML = `
    <div class="signin-screen">
      <div class="signin-card">
        <div class="signin-head">
          <h1 class="signin-title">Sign in to <span class="accent">P1</span></h1>
          <p class="signin-sub">Cloud sync · multi-device · collaborate with friends</p>
        </div>
        <form id="signin-form" class="signin-form">
          <div class="field">
            <label>Email</label>
            <input type="email" name="email" required autocomplete="email" placeholder="you@example.com">
          </div>
          <div class="field">
            <label>Password <span class="field-help-inline">(min 6 characters)</span></label>
            <input type="password" name="password" required autocomplete="current-password" minlength="6">
          </div>
          <div class="signin-actions">
            <button type="submit" class="btn btn-primary" data-act="signin">SIGN IN</button>
            <button type="button" class="btn btn-ghost" data-act="signup">CREATE ACCOUNT</button>
          </div>
          <div class="signin-divider">or</div>
          <button type="button" class="btn btn-ghost btn-full" data-act="magic">✦ EMAIL ME A MAGIC LINK</button>
          <button type="button" class="btn btn-ghost btn-full" data-act="google">G · CONTINUE WITH GOOGLE</button>
          <button type="button" class="btn btn-ghost btn-full" data-act="guest">→ CONTINUE AS GUEST · local only, no cloud sync</button>
          <div class="signin-msg" id="signin-msg"></div>
        </form>
        <div class="signin-foot">
          <small>By signing in you agree to keep your fictional motorsport universe to yourself.</small>
        </div>
      </div>
    </div>`;

  // Clear topbar/tabs so login is the full focus
  $('#topbar-selectors').innerHTML = '';
  $('#topbar-actions').innerHTML = '';
  $('#tabs').innerHTML = '';

  const msg = $('#signin-msg');
  const setMsg = (text, tone = 'info') => { msg.textContent = text; msg.className = `signin-msg tone-${tone}`; };

  const form = $('#signin-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    setMsg('Signing in…', 'info');
    try { await cloudSignIn(fd.get('email'), fd.get('password')); }
    catch (err) { setMsg(err.message, 'error'); }
  });
  $('[data-act="signup"]').addEventListener('click', async () => {
    const fd = new FormData(form);
    if (!fd.get('email') || !fd.get('password')) { setMsg('Enter email + password first.', 'error'); return; }
    setMsg('Creating account…', 'info');
    try {
      await cloudSignUp(fd.get('email'), fd.get('password'));
      setMsg('Account created. Check your email to confirm — then sign in.', 'success');
    } catch (err) { setMsg(err.message, 'error'); }
  });
  $('[data-act="magic"]').addEventListener('click', async () => {
    const fd = new FormData(form);
    if (!fd.get('email')) { setMsg('Enter your email first.', 'error'); return; }
    setMsg('Sending magic link…', 'info');
    try { await cloudMagicLink(fd.get('email')); setMsg('Magic link sent — check your inbox.', 'success'); }
    catch (err) { setMsg(err.message, 'error'); }
  });
  $('[data-act="google"]').addEventListener('click', async () => {
    try { await cloudGoogleSignIn(); }
    catch (err) { setMsg(err.message, 'error'); }
  });
  $('[data-act="guest"]').addEventListener('click', () => enterGuestMode());
}

/* ---------- GUEST MODE: use the app locally without signing in ----------
   State lives in localStorage only; all cloud helpers no-op while currentUser
   is null. The flag persists so a reload stays in guest mode (lets you verify
   that local changes survive a refresh). */
const GUEST_KEY = 'p1_guest';
const isGuest = () => { try { return localStorage.getItem(GUEST_KEY) === '1'; } catch { return false; } };
function enterGuestMode() {
  try { localStorage.setItem(GUEST_KEY, '1'); } catch {}
  renderTopbar(); renderTabs(); renderAll();
}
function exitGuestMode() {
  try { localStorage.removeItem(GUEST_KEY); } catch {}
  location.reload();
}
/* =====================================================
   ▲ END SUPABASE CLOUD LAYER ▲
   ===================================================== */

/* ---------- constants ---------- */
const STORAGE_KEY = 'p1_season_creator_v2';
const LEGACY_KEYS = ['apex_f1_creator_v1']; // migrate from old saves

/* Historical points systems. Each season picks one. */
const POINTS_SYSTEMS = [
  {
    id: 'modern_fl',
    name: 'Modern + Fastest Lap (2019 → present)',
    short: 'MODERN+FL',
    points: [25, 18, 15, 12, 10, 8, 6, 4, 2, 1],
    flBonus: 1,
    flRequiresTop10: true,
    sprintPoints: [8, 7, 6, 5, 4, 3, 2, 1],
    era: 'Current',
  },
  {
    id: 'modern',
    name: 'Modern (2010 → 2018)',
    short: 'MODERN',
    points: [25, 18, 15, 12, 10, 8, 6, 4, 2, 1],
    flBonus: 0,
    sprintPoints: [],
    era: '2010s',
  },
  {
    id: 'top8',
    name: 'Top 8 (2003 → 2009)',
    short: 'TOP-8',
    points: [10, 8, 6, 5, 4, 3, 2, 1],
    flBonus: 0,
    sprintPoints: [],
    era: '2000s',
  },
  {
    id: 'classic_10',
    name: 'Classic Top 6 — 10 for win (1991 → 2002)',
    short: 'CLASSIC-10',
    points: [10, 6, 4, 3, 2, 1],
    flBonus: 0,
    sprintPoints: [],
    era: '1990s',
  },
  {
    id: 'classic_9',
    name: 'Classic Top 6 — 9 for win (1961 → 1990)',
    short: 'CLASSIC-9',
    points: [9, 6, 4, 3, 2, 1],
    flBonus: 0,
    sprintPoints: [],
    era: '1980s',
  },
  {
    id: 'classic_8',
    name: 'Top 6 — 8 for win (1960)',
    short: 'CLASSIC-8',
    points: [8, 6, 4, 3, 2, 1],
    flBonus: 0,
    sprintPoints: [],
    era: '1960',
  },
  {
    id: 'fifties',
    name: '1950s — Top 5 + Fastest Lap (1950 → 1959)',
    short: 'FIFTIES',
    points: [8, 6, 4, 3, 2],
    flBonus: 1,
    flRequiresTop10: false,
    sprintPoints: [],
    era: '1950s',
  },
  {
    id: 'sprint_2021',
    name: 'Sprint Pre-2022 (3-2-1)',
    short: 'SPR-2021',
    points: [25, 18, 15, 12, 10, 8, 6, 4, 2, 1],
    flBonus: 1,
    flRequiresTop10: true,
    sprintPoints: [3, 2, 1],
    era: '2021',
  },
];

const DEFAULT_POINTS_SYSTEM_ID = 'modern_fl';

const getPointsSystem = (id) => POINTS_SYSTEMS.find(p => p.id === id) || POINTS_SYSTEMS[0];

/* preset 10 default teams (fictional) */
const PRESET_TEAMS = [
  { name: 'Aurora Racing',     short: 'AUR', color: '#1e3a8a', country: 'GBR' },
  { name: 'Crimson Velocity',  short: 'CRV', color: '#dc2626', country: 'ITA' },
  { name: 'Halcyon Motorsport',short: 'HAL', color: '#0891b2', country: 'GBR' },
  { name: 'Vortex Performance',short: 'VTX', color: '#16a34a', country: 'AUT' },
  { name: 'Stellar Dynamics',  short: 'STL', color: '#f59e0b', country: 'USA' },
  { name: 'Nordic Werks',      short: 'NRD', color: '#64748b', country: 'GER' },
  { name: 'Solano Corse',      short: 'SOL', color: '#ea580c', country: 'ITA' },
  { name: 'Meridian GP',       short: 'MER', color: '#a855f7', country: 'FRA' },
  { name: 'Tempest Racing',    short: 'TMP', color: '#0d9488', country: 'JPN' },
  { name: 'Ignis Sport',       short: 'IGN', color: '#be185d', country: 'ESP' },
];

/* preset classic calendar */
const PRESET_CALENDAR = [
  { name: 'Australian Grand Prix',  circuit: 'Albert Park',          country: 'AUS' },
  { name: 'Japanese Grand Prix',    circuit: 'Suzuka',               country: 'JPN' },
  { name: 'Saudi Arabian Grand Prix',circuit:'Jeddah Corniche',      country: 'KSA' },
  { name: 'Bahrain Grand Prix',     circuit: 'Bahrain International',country: 'BHR' },
  { name: 'Miami Grand Prix',       circuit: 'Miami International',  country: 'USA', sprint: true },
  { name: 'Emilia-Romagna GP',      circuit: 'Imola',                country: 'ITA' },
  { name: 'Monaco Grand Prix',      circuit: 'Circuit de Monaco',    country: 'MCO' },
  { name: 'Spanish Grand Prix',     circuit: 'Catalunya',            country: 'ESP' },
  { name: 'Canadian Grand Prix',    circuit: 'Gilles Villeneuve',    country: 'CAN' },
  { name: 'Austrian Grand Prix',    circuit: 'Red Bull Ring',        country: 'AUT', sprint: true },
  { name: 'British Grand Prix',     circuit: 'Silverstone',          country: 'GBR' },
  { name: 'Hungarian Grand Prix',   circuit: 'Hungaroring',          country: 'HUN' },
  { name: 'Belgian Grand Prix',     circuit: 'Spa-Francorchamps',    country: 'BEL', sprint: true },
  { name: 'Dutch Grand Prix',       circuit: 'Zandvoort',            country: 'NED' },
  { name: 'Italian Grand Prix',     circuit: 'Monza',                country: 'ITA' },
  { name: 'Singapore Grand Prix',   circuit: 'Marina Bay',           country: 'SGP' },
  { name: 'United States Grand Prix',circuit: 'Circuit of the Americas', country: 'USA', sprint: true },
  { name: 'Mexico City Grand Prix', circuit: 'Hermanos Rodriguez',   country: 'MEX' },
  { name: 'São Paulo Grand Prix',   circuit: 'Interlagos',           country: 'BRA', sprint: true },
  { name: 'Las Vegas Grand Prix',   circuit: 'Las Vegas Strip',      country: 'USA' },
  { name: 'Qatar Grand Prix',       circuit: 'Lusail International', country: 'QAT', sprint: true },
  { name: 'Abu Dhabi Grand Prix',   circuit: 'Yas Marina',           country: 'UAE' },
];

/* ============================================
   TRACK PRESETS — searchable library of circuits across every era.
   Add your own; everything is editable after.
   ============================================ */
const TRACK_PRESETS = [
  // CURRENT ERA
  { name: 'Australian Grand Prix',     circuit: 'Albert Park',           country: 'AUS', length: 5.278, era: 'Current' },
  { name: 'Japanese Grand Prix',       circuit: 'Suzuka',                country: 'JPN', length: 5.807, era: 'Current' },
  { name: 'Saudi Arabian Grand Prix',  circuit: 'Jeddah Corniche',       country: 'KSA', length: 6.174, era: 'Current' },
  { name: 'Bahrain Grand Prix',        circuit: 'Bahrain International', country: 'BHR', length: 5.412, era: 'Current' },
  { name: 'Miami Grand Prix',          circuit: 'Miami International',   country: 'USA', length: 5.412, era: 'Current', sprint: true },
  { name: 'Emilia-Romagna Grand Prix', circuit: 'Imola',                 country: 'ITA', length: 4.909, era: 'Current' },
  { name: 'Monaco Grand Prix',         circuit: 'Circuit de Monaco',     country: 'MCO', length: 3.337, era: 'Current' },
  { name: 'Spanish Grand Prix',        circuit: 'Catalunya',             country: 'ESP', length: 4.657, era: 'Current' },
  { name: 'Canadian Grand Prix',       circuit: 'Gilles Villeneuve',     country: 'CAN', length: 4.361, era: 'Current' },
  { name: 'Austrian Grand Prix',       circuit: 'Red Bull Ring',         country: 'AUT', length: 4.318, era: 'Current', sprint: true },
  { name: 'British Grand Prix',        circuit: 'Silverstone',           country: 'GBR', length: 5.891, era: 'Current' },
  { name: 'Hungarian Grand Prix',      circuit: 'Hungaroring',           country: 'HUN', length: 4.381, era: 'Current' },
  { name: 'Belgian Grand Prix',        circuit: 'Spa-Francorchamps',     country: 'BEL', length: 7.004, era: 'Current', sprint: true },
  { name: 'Dutch Grand Prix',          circuit: 'Zandvoort',             country: 'NED', length: 4.259, era: 'Current' },
  { name: 'Italian Grand Prix',        circuit: 'Monza',                 country: 'ITA', length: 5.793, era: 'Current' },
  { name: 'Singapore Grand Prix',      circuit: 'Marina Bay',            country: 'SGP', length: 4.940, era: 'Current' },
  { name: 'United States Grand Prix',  circuit: 'Circuit of the Americas', country: 'USA', length: 5.513, era: 'Current', sprint: true },
  { name: 'Mexico City Grand Prix',    circuit: 'Hermanos Rodriguez',    country: 'MEX', length: 4.304, era: 'Current' },
  { name: 'São Paulo Grand Prix',      circuit: 'Interlagos',            country: 'BRA', length: 4.309, era: 'Current', sprint: true },
  { name: 'Las Vegas Grand Prix',      circuit: 'Las Vegas Strip',       country: 'USA', length: 6.201, era: 'Current' },
  { name: 'Qatar Grand Prix',          circuit: 'Lusail International',  country: 'QAT', length: 5.419, era: 'Current', sprint: true },
  { name: 'Abu Dhabi Grand Prix',      circuit: 'Yas Marina',            country: 'UAE', length: 5.281, era: 'Current' },

  // 2010s favourites & departures
  { name: 'German Grand Prix',         circuit: 'Hockenheim',            country: 'GER', length: 4.574, era: '2010s' },
  { name: 'European Grand Prix',       circuit: 'Valencia Street',       country: 'ESP', length: 5.419, era: '2010s' },
  { name: 'Korean Grand Prix',         circuit: 'Korea International',   country: 'KOR', length: 5.615, era: '2010s' },
  { name: 'Indian Grand Prix',         circuit: 'Buddh International',   country: 'IND', length: 5.125, era: '2010s' },
  { name: 'Russian Grand Prix',        circuit: 'Sochi Autodrom',        country: 'RUS', length: 5.848, era: '2010s' },
  { name: 'Azerbaijan Grand Prix',     circuit: 'Baku City Circuit',     country: 'AZE', length: 6.003, era: '2010s' },
  { name: 'European Grand Prix (Baku)', circuit: 'Baku City Circuit',    country: 'AZE', length: 6.003, era: '2010s' },
  { name: 'Turkish Grand Prix',        circuit: 'Istanbul Park',         country: 'TUR', length: 5.338, era: '2010s' },

  // 2000s
  { name: 'Malaysian Grand Prix',      circuit: 'Sepang International',  country: 'MAL', length: 5.543, era: '2000s' },
  { name: 'Chinese Grand Prix',        circuit: 'Shanghai International',country: 'CHN', length: 5.451, era: '2000s' },
  { name: 'European Grand Prix',       circuit: 'Nürburgring',           country: 'GER', length: 5.148, era: '2000s' },
  { name: 'United States GP (Indy)',   circuit: 'Indianapolis Motor Speedway', country: 'USA', length: 4.192, era: '2000s' },
  { name: 'French Grand Prix',         circuit: 'Magny-Cours',           country: 'FRA', length: 4.411, era: '2000s' },
  { name: 'San Marino Grand Prix',     circuit: 'Imola',                 country: 'ITA', length: 4.933, era: '2000s' },

  // 1990s
  { name: 'Pacific Grand Prix',        circuit: 'TI Aida',               country: 'JPN', length: 3.703, era: '1990s' },
  { name: 'Argentine Grand Prix',      circuit: 'Oscar Galvez',          country: 'ARG', length: 4.259, era: '1990s' },
  { name: 'Portuguese Grand Prix',     circuit: 'Estoril',               country: 'POR', length: 4.360, era: '1990s' },
  { name: 'Luxembourg Grand Prix',     circuit: 'Nürburgring',           country: 'GER', length: 4.556, era: '1990s' },
  { name: 'European Grand Prix',       circuit: 'Donington Park',        country: 'GBR', length: 4.020, era: '1990s' },
  { name: 'South African Grand Prix',  circuit: 'Kyalami',               country: 'RSA', length: 4.261, era: '1990s' },

  // 1980s
  { name: 'Detroit Grand Prix',        circuit: 'Detroit Street',        country: 'USA', length: 4.023, era: '1980s' },
  { name: 'Dallas Grand Prix',         circuit: 'Fair Park',             country: 'USA', length: 3.901, era: '1980s' },
  { name: 'Caesars Palace Grand Prix', circuit: 'Caesars Palace',        country: 'USA', length: 3.650, era: '1980s' },
  { name: 'Las Vegas Grand Prix',      circuit: 'Caesars Palace',        country: 'USA', length: 3.650, era: '1980s' },
  { name: 'Brazilian Grand Prix',      circuit: 'Jacarepaguá',           country: 'BRA', length: 5.031, era: '1980s' },
  { name: 'British Grand Prix',        circuit: 'Brands Hatch',          country: 'GBR', length: 4.207, era: '1980s' },
  { name: 'French Grand Prix',         circuit: 'Paul Ricard',           country: 'FRA', length: 5.810, era: '1980s' },

  // 1970s
  { name: 'United States GP (Watkins)',circuit: 'Watkins Glen',          country: 'USA', length: 5.435, era: '1970s' },
  { name: 'Swedish Grand Prix',        circuit: 'Anderstorp',            country: 'SWE', length: 4.025, era: '1970s' },
  { name: 'Spanish Grand Prix',        circuit: 'Jarama',                country: 'ESP', length: 3.404, era: '1970s' },
  { name: 'Belgian Grand Prix',        circuit: 'Zolder',                country: 'BEL', length: 4.011, era: '1970s' },
  { name: 'Austrian Grand Prix',       circuit: 'Österreichring',        country: 'AUT', length: 5.911, era: '1970s' },

  // 1960s & 1950s — historical
  { name: 'German Grand Prix',         circuit: 'Nürburgring Nordschleife', country: 'GER', length: 22.835, era: '1960s' },
  { name: 'Mexican Grand Prix',        circuit: 'Hermanos Rodriguez (old)', country: 'MEX', length: 5.000, era: '1960s' },
  { name: 'British Grand Prix',        circuit: 'Aintree',               country: 'GBR', length: 4.828, era: '1950s' },
  { name: 'Italian Grand Prix',        circuit: 'Pescara',               country: 'ITA', length: 25.838, era: '1950s' },
  { name: 'French Grand Prix',         circuit: 'Reims-Gueux',           country: 'FRA', length: 7.816, era: '1950s' },
  { name: 'Indianapolis 500',          circuit: 'Indianapolis Motor Speedway', country: 'USA', length: 4.023, era: '1950s' },
];

/* sample driver name generator pool (for "+ ADD SAMPLE DRIVER") */
const SAMPLE_FIRSTS = ['Marco','Lando','Felix','Adrian','Kenji','Mateo','Dimitri','Theo','Rasmus','Lucas','Hugo','Pierre','Niko','Andrei','Diego','Otto','Bastian','Yuki','Carlos','Mika'];
const SAMPLE_LASTS  = ['Alvarez','Brennan','Costa','Delacroix','Eriksen','Falcone','Gallego','Hartmann','Iversen','Jansson','Kowalski','Linden','Marchetti','Novak','Oliveira','Petrov','Quinn','Rinaldi','Schaefer','Tanaka'];
const SAMPLE_COUNTRIES = ['GBR','ITA','GER','FRA','ESP','NED','MEX','BRA','AUS','MON','FIN','DEN','BEL','JPN','THA','USA','CAN','POL','SUI','SWE'];

/* ============================================
   DRIVER PRESETS — searchable library of famous F1 drivers across every era.
   Names + nationalities + traditional numbers only (no copyrighted likenesses).
   Add your own to the season; everything is editable after.
   ============================================ */
const DRIVER_PRESETS = [
  // 2026 SEASON — official grid (driver → 2026 team; abbr + team editable after signing)
  { name: 'Max Verstappen',       country: 'NED', number: 1,  era: '2026', abbr: 'VER', team: 'Red Bull Racing' },
  { name: 'Isack Hadjar',         country: 'FRA', number: 6,  era: '2026', abbr: 'HAD', team: 'Red Bull Racing' },
  { name: 'Charles Leclerc',      country: 'MON', number: 16, era: '2026', abbr: 'LEC', team: 'Ferrari' },
  { name: 'Lewis Hamilton',       country: 'GBR', number: 44, era: '2026', abbr: 'HAM', team: 'Ferrari' },
  { name: 'George Russell',       country: 'GBR', number: 63, era: '2026', abbr: 'RUS', team: 'Mercedes' },
  { name: 'Andrea Kimi Antonelli',country: 'ITA', number: 12, era: '2026', abbr: 'ANT', team: 'Mercedes' },
  { name: 'Lando Norris',         country: 'GBR', number: 4,  era: '2026', abbr: 'NOR', team: 'McLaren' },
  { name: 'Oscar Piastri',        country: 'AUS', number: 81, era: '2026', abbr: 'PIA', team: 'McLaren' },
  { name: 'Fernando Alonso',      country: 'ESP', number: 14, era: '2026', abbr: 'ALO', team: 'Aston Martin' },
  { name: 'Lance Stroll',         country: 'CAN', number: 18, era: '2026', abbr: 'STR', team: 'Aston Martin' },
  { name: 'Pierre Gasly',         country: 'FRA', number: 10, era: '2026', abbr: 'GAS', team: 'Alpine' },
  { name: 'Franco Colapinto',     country: 'ARG', number: 43, era: '2026', abbr: 'COL', team: 'Alpine' },
  { name: 'Alexander Albon',      country: 'THA', number: 23, era: '2026', abbr: 'ALB', team: 'Williams' },
  { name: 'Carlos Sainz',         country: 'ESP', number: 55, era: '2026', abbr: 'SAI', team: 'Williams' },
  { name: 'Liam Lawson',          country: 'NZL', number: 30, era: '2026', abbr: 'LAW', team: 'Racing Bulls' },
  { name: 'Arvid Lindblad',       country: 'GBR', number: 8,  era: '2026', abbr: 'LIN', team: 'Racing Bulls' },
  { name: 'Esteban Ocon',         country: 'FRA', number: 31, era: '2026', abbr: 'OCO', team: 'Haas' },
  { name: 'Oliver Bearman',       country: 'GBR', number: 87, era: '2026', abbr: 'BEA', team: 'Haas' },
  { name: 'Nico Hülkenberg',      country: 'GER', number: 27, era: '2026', abbr: 'HUL', team: 'Audi' },
  { name: 'Gabriel Bortoleto',    country: 'BRA', number: 5,  era: '2026', abbr: 'BOR', team: 'Audi' },
  { name: 'Sergio Pérez',         country: 'MEX', number: 11, era: '2026', abbr: 'PER', team: 'Cadillac' },
  { name: 'Valtteri Bottas',      country: 'FIN', number: 77, era: '2026', abbr: 'BOT', team: 'Cadillac' },

  // CURRENT ERA
  { name: 'Max Verstappen',       country: 'NED', number: 1,  era: 'Current', eras: ['Current', '2010s'] },
  { name: 'Lewis Hamilton',       country: 'GBR', number: 44, era: 'Current', eras: ['Current', '2010s', '2000s'] },
  { name: 'Charles Leclerc',      country: 'MON', number: 16, era: 'Current' },
  { name: 'Lando Norris',         country: 'GBR', number: 4,  era: 'Current' },
  { name: 'George Russell',       country: 'GBR', number: 63, era: 'Current' },
  { name: 'Carlos Sainz',         country: 'ESP', number: 55, era: 'Current' },
  { name: 'Fernando Alonso',      country: 'ESP', number: 14, era: 'Current' },
  { name: 'Oscar Piastri',        country: 'AUS', number: 81, era: 'Current' },
  { name: 'Sergio Pérez',         country: 'MEX', number: 11, era: 'Current' },
  { name: 'Lance Stroll',         country: 'CAN', number: 18, era: 'Current' },
  { name: 'Yuki Tsunoda',         country: 'JPN', number: 22, era: 'Current' },
  { name: 'Alexander Albon',      country: 'THA', number: 23, era: 'Current' },
  { name: 'Valtteri Bottas',      country: 'FIN', number: 77, era: 'Current' },
  { name: 'Zhou Guanyu',          country: 'CHN', number: 24, era: 'Current' },
  { name: 'Kevin Magnussen',      country: 'DEN', number: 20, era: 'Current' },
  { name: 'Nico Hülkenberg',      country: 'GER', number: 27, era: 'Current' },
  { name: 'Pierre Gasly',         country: 'FRA', number: 10, era: 'Current' },
  { name: 'Esteban Ocon',         country: 'FRA', number: 31, era: 'Current' },
  { name: 'Daniel Ricciardo',     country: 'AUS', number: 3,  era: 'Current' },
  { name: 'Logan Sargeant',       country: 'USA', number: 2,  era: 'Current' },
  { name: 'Liam Lawson',          country: 'NZL', number: 30, era: 'Current' },
  { name: 'Andrea Kimi Antonelli',country: 'ITA', number: 12, era: 'Current' },
  { name: 'Oliver Bearman',       country: 'GBR', number: 87, era: 'Current' },
  { name: 'Isack Hadjar',         country: 'FRA', number: 6,  era: 'Current' },
  { name: 'Jack Doohan',          country: 'AUS', number: 7,  era: 'Current' },
  { name: 'Gabriel Bortoleto',    country: 'BRA', number: 5,  era: 'Current' },
  { name: 'Franco Colapinto',     country: 'ARG', number: 43, era: 'Current' },

  // 2010s
  { name: 'Sebastian Vettel',     country: 'GER', number: 5,  era: '2010s' },
  { name: 'Kimi Räikkönen',       country: 'FIN', number: 7,  era: '2010s' },
  { name: 'Mark Webber',          country: 'AUS', number: 2,  era: '2010s' },
  { name: 'Felipe Massa',         country: 'BRA', number: 19, era: '2010s' },
  { name: 'Jenson Button',        country: 'GBR', number: 22, era: '2010s' },
  { name: 'Nico Rosberg',         country: 'GER', number: 6,  era: '2010s' },
  { name: 'Romain Grosjean',      country: 'FRA', number: 8,  era: '2010s' },
  { name: 'Daniil Kvyat',         country: 'RUS', number: 26, era: '2010s' },
  { name: 'Pastor Maldonado',     country: 'VEN', number: 13, era: '2010s' },
  { name: 'Heikki Kovalainen',    country: 'FIN', number: 23, era: '2010s' },
  { name: 'Vitaly Petrov',        country: 'RUS', number: 10, era: '2010s' },
  { name: 'Adrian Sutil',         country: 'GER', number: 99, era: '2010s' },
  { name: 'Paul di Resta',        country: 'GBR', number: 40, era: '2010s' },
  { name: 'Jean-Éric Vergne',     country: 'FRA', number: 25, era: '2010s' },

  // 2000s
  { name: 'Mika Häkkinen',        country: 'FIN', number: 1,  era: '2000s' },
  { name: 'David Coulthard',      country: 'GBR', number: 3,  era: '2000s' },
  { name: 'Rubens Barrichello',   country: 'BRA', number: 11, era: '2000s' },
  { name: 'Juan Pablo Montoya',   country: 'COL', number: 6,  era: '2000s' },
  { name: 'Jarno Trulli',         country: 'ITA', number: 9,  era: '2000s' },
  { name: 'Ralf Schumacher',      country: 'GER', number: 7,  era: '2000s' },
  { name: 'Giancarlo Fisichella', country: 'ITA', number: 21, era: '2000s' },
  { name: 'Eddie Irvine',         country: 'GBR', number: 4,  era: '2000s' },
  { name: 'Mark Webber',          country: 'AUS', number: 12, era: '2000s' },
  { name: 'Robert Kubica',        country: 'POL', number: 88, era: '2000s' },
  { name: 'Timo Glock',           country: 'GER', number: 10, era: '2000s' },

  // 1990s
  { name: 'Ayrton Senna',         country: 'BRA', number: 1,  era: '1990s' },
  { name: 'Alain Prost',          country: 'FRA', number: 2,  era: '1990s' },
  { name: 'Nigel Mansell',        country: 'GBR', number: 5,  era: '1990s' },
  { name: 'Damon Hill',           country: 'GBR', number: 0,  era: '1990s' },
  { name: 'Jacques Villeneuve',   country: 'CAN', number: 3,  era: '1990s' },
  { name: 'Gerhard Berger',       country: 'AUT', number: 28, era: '1990s' },
  { name: 'Michael Schumacher',   country: 'GER', number: 1,  era: '1990s' },
  { name: 'Jean Alesi',           country: 'FRA', number: 27, era: '1990s' },
  { name: 'Olivier Panis',        country: 'FRA', number: 4,  era: '1990s' },
  { name: 'Heinz-Harald Frentzen',country: 'GER', number: 4,  era: '1990s' },
  { name: 'Eddie Irvine',         country: 'GBR', number: 4,  era: '1990s' },

  // 1980s
  { name: 'Niki Lauda',           country: 'AUT', number: 1,  era: '1980s' },
  { name: 'Nelson Piquet',        country: 'BRA', number: 5,  era: '1980s' },
  { name: 'Keke Rosberg',         country: 'FIN', number: 9,  era: '1980s' },
  { name: 'Riccardo Patrese',     country: 'ITA', number: 2,  era: '1980s' },
  { name: 'Michele Alboreto',     country: 'ITA', number: 27, era: '1980s' },
  { name: 'Nigel Mansell',        country: 'GBR', number: 5,  era: '1980s' },
  { name: 'Gilles Villeneuve',    country: 'CAN', number: 27, era: '1980s' },
  { name: 'Didier Pironi',        country: 'FRA', number: 28, era: '1980s' },

  // 1970s
  { name: 'James Hunt',           country: 'GBR', number: 11, era: '1970s' },
  { name: 'Mario Andretti',       country: 'USA', number: 5,  era: '1970s' },
  { name: 'Jody Scheckter',       country: 'RSA', number: 11, era: '1970s' },
  { name: 'Emerson Fittipaldi',   country: 'BRA', number: 1,  era: '1970s' },
  { name: 'Carlos Reutemann',     country: 'ARG', number: 1,  era: '1970s' },
  { name: 'Ronnie Peterson',      country: 'SWE', number: 6,  era: '1970s' },
  { name: 'Gilles Villeneuve',    country: 'CAN', number: 12, era: '1970s' },

  // 1960s
  { name: 'Jim Clark',            country: 'GBR', number: 5,  era: '1960s' },
  { name: 'Graham Hill',          country: 'GBR', number: 9,  era: '1960s' },
  { name: 'Jackie Stewart',       country: 'GBR', number: 6,  era: '1960s' },
  { name: 'Jack Brabham',         country: 'AUS', number: 17, era: '1960s' },
  { name: 'John Surtees',         country: 'GBR', number: 1,  era: '1960s' },
  { name: 'Denny Hulme',          country: 'NZL', number: 4,  era: '1960s' },
  { name: 'Phil Hill',            country: 'USA', number: 4,  era: '1960s' },
  { name: 'Dan Gurney',           country: 'USA', number: 11, era: '1960s' },

  // 1950s
  { name: 'Juan Manuel Fangio',   country: 'ARG', number: 1,  era: '1950s' },
  { name: 'Alberto Ascari',       country: 'ITA', number: 4,  era: '1950s' },
  { name: 'Giuseppe Farina',      country: 'ITA', number: 2,  era: '1950s' },
  { name: 'Mike Hawthorn',        country: 'GBR', number: 6,  era: '1950s' },
  { name: 'Stirling Moss',        country: 'GBR', number: 7,  era: '1950s' },
  { name: 'Tony Brooks',          country: 'GBR', number: 8,  era: '1950s' },
];

const ERA_FILTERS = ['All', '2026', 'Current', '2010s', '2000s', '1990s', '1980s', '1970s', '1960s', '1950s'];

/* =====================================================
   TEAM PRESETS — searchable library of well-known constructors.
   Brand colours are approximations; users can edit after signing.
   ===================================================== */
const TEAM_PRESETS = [
  // 2026 SEASON — official constructors
  { name: 'Red Bull Racing',  short: 'RBR', color: '#1e40af', country: 'AUT', era: '2026' },
  { name: 'Ferrari',          short: 'FER', color: '#dc0000', country: 'ITA', era: '2026' },
  { name: 'Mercedes',         short: 'MER', color: '#27f4d2', country: 'GER', era: '2026' },
  { name: 'McLaren',          short: 'MCL', color: '#ff8000', country: 'GBR', era: '2026' },
  { name: 'Aston Martin',     short: 'AST', color: '#006f62', country: 'GBR', era: '2026' },
  { name: 'Alpine',           short: 'ALP', color: '#0090d0', country: 'FRA', era: '2026' },
  { name: 'Williams',         short: 'WIL', color: '#005aff', country: 'GBR', era: '2026' },
  { name: 'Racing Bulls',     short: 'RB',  color: '#1660ad', country: 'ITA', era: '2026' },
  { name: 'Haas',             short: 'HAA', color: '#b6babd', country: 'USA', era: '2026' },
  { name: 'Audi',             short: 'AUD', color: '#bb0a30', country: 'GER', era: '2026' },
  { name: 'Cadillac',         short: 'CAD', color: '#1b2a4a', country: 'USA', era: '2026' },

  // CURRENT ERA
  { name: 'Red Bull Racing',  short: 'RBR', color: '#1e40af', country: 'AUT', era: 'Current' },
  { name: 'Ferrari',          short: 'FER', color: '#dc0000', country: 'ITA', era: 'Current' },
  { name: 'Mercedes',         short: 'MER', color: '#27f4d2', country: 'GER', era: 'Current' },
  { name: 'McLaren',          short: 'MCL', color: '#ff8000', country: 'GBR', era: 'Current' },
  { name: 'Aston Martin',     short: 'AST', color: '#006f62', country: 'GBR', era: 'Current' },
  { name: 'Alpine',           short: 'ALP', color: '#0090d0', country: 'FRA', era: 'Current' },
  { name: 'Williams',         short: 'WIL', color: '#005aff', country: 'GBR', era: 'Current' },
  { name: 'Haas',             short: 'HAA', color: '#b6babd', country: 'USA', era: 'Current' },
  { name: 'RB',               short: 'RB',  color: '#1660ad', country: 'ITA', era: 'Current' },
  { name: 'Kick Sauber',      short: 'KCK', color: '#52e252', country: 'CHE', era: 'Current' },
  { name: 'AlphaTauri',       short: 'AT',  color: '#2b4562', country: 'ITA', era: 'Current' },
  { name: 'Alfa Romeo',       short: 'ALF', color: '#900000', country: 'ITA', era: 'Current' },

  // 2010s
  { name: 'Lotus F1',         short: 'LOT', color: '#000000', country: 'GBR', era: '2010s' },
  { name: 'Force India',      short: 'FOR', color: '#f97316', country: 'IND', era: '2010s' },
  { name: 'Marussia',         short: 'MAR', color: '#ef4444', country: 'GBR', era: '2010s' },
  { name: 'Manor Racing',     short: 'MAN', color: '#dc2626', country: 'GBR', era: '2010s' },
  { name: 'Caterham',         short: 'CAT', color: '#16a34a', country: 'MAL', era: '2010s' },
  { name: 'HRT',              short: 'HRT', color: '#475569', country: 'ESP', era: '2010s' },
  { name: 'Toro Rosso',       short: 'STR', color: '#1d4ed8', country: 'ITA', era: '2010s' },
  { name: 'Racing Point',     short: 'RP',  color: '#f1afc7', country: 'GBR', era: '2010s' },
  { name: 'Renault F1',       short: 'REN', color: '#fbbf24', country: 'FRA', era: '2010s' },
  { name: 'Sauber',           short: 'SAU', color: '#9ca3af', country: 'CHE', era: '2010s' },
  { name: 'Virgin Racing',    short: 'VIR', color: '#ef4444', country: 'GBR', era: '2010s' },

  // 2000s
  { name: 'Brawn GP',         short: 'BRA', color: '#bef264', country: 'GBR', era: '2000s' },
  { name: 'Honda Racing',     short: 'HON', color: '#cccccc', country: 'JPN', era: '2000s' },
  { name: 'BMW Sauber',       short: 'BMW', color: '#1e3a8a', country: 'GER', era: '2000s' },
  { name: 'Toyota F1',        short: 'TOY', color: '#dc2626', country: 'JPN', era: '2000s' },
  { name: 'BAR Honda',        short: 'BAR', color: '#fbbf24', country: 'GBR', era: '2000s' },
  { name: 'Jordan',           short: 'JOR', color: '#fbbf24', country: 'IRL', era: '2000s' },
  { name: 'Spyker',           short: 'SPY', color: '#ea580c', country: 'NED', era: '2000s' },
  { name: 'Midland',          short: 'MID', color: '#ef4444', country: 'GBR', era: '2000s' },
  { name: 'Super Aguri',      short: 'SAF', color: '#dc2626', country: 'JPN', era: '2000s' },
  { name: 'Minardi',          short: 'MIN', color: '#1f2937', country: 'ITA', era: '2000s' },
  { name: 'Prost Grand Prix', short: 'PRO', color: '#1e3a8a', country: 'FRA', era: '2000s' },

  // 1990s
  { name: 'Benetton',         short: 'BEN', color: '#16a34a', country: 'ITA', era: '1990s' },
  { name: 'Stewart',           short: 'STW', color: '#fbbf24', country: 'GBR', era: '1990s' },
  { name: 'Tyrrell',          short: 'TYR', color: '#1e40af', country: 'GBR', era: '1990s' },
  { name: 'Ligier',           short: 'LIG', color: '#1e3a8a', country: 'FRA', era: '1990s' },
  { name: 'Arrows',           short: 'ARR', color: '#ea580c', country: 'GBR', era: '1990s' },
  { name: 'Footwork',         short: 'FOO', color: '#1f2937', country: 'GBR', era: '1990s' },
  { name: 'Larrousse',        short: 'LAR', color: '#1e40af', country: 'FRA', era: '1990s' },
  { name: 'Forti',            short: 'FOR', color: '#16a34a', country: 'ITA', era: '1990s' },
  { name: 'Pacific',          short: 'PAC', color: '#fbbf24', country: 'GBR', era: '1990s' },
  { name: 'Simtek',           short: 'SIM', color: '#1e40af', country: 'GBR', era: '1990s' },

  // 1980s
  { name: 'Brabham',          short: 'BRA', color: '#1e3a8a', country: 'GBR', era: '1980s' },
  { name: 'Lotus',            short: 'LOT', color: '#000000', country: 'GBR', era: '1980s' },
  { name: 'Renault',          short: 'REN', color: '#fbbf24', country: 'FRA', era: '1980s' },
  { name: 'Alfa Romeo',       short: 'ALF', color: '#900000', country: 'ITA', era: '1980s' },
  { name: 'Ensign',           short: 'ENS', color: '#dc2626', country: 'GBR', era: '1980s' },
  { name: 'Toleman',          short: 'TOL', color: '#1e40af', country: 'GBR', era: '1980s' },
  { name: 'ATS',              short: 'ATS', color: '#dc2626', country: 'GER', era: '1980s' },
  { name: 'Osella',           short: 'OSE', color: '#1e3a8a', country: 'ITA', era: '1980s' },
  { name: 'Tyrrell',          short: 'TYR', color: '#1e40af', country: 'GBR', era: '1980s' },

  // 1970s
  { name: 'Tyrrell',          short: 'TYR', color: '#1e40af', country: 'GBR', era: '1970s' },
  { name: 'Lotus',            short: 'LOT', color: '#000000', country: 'GBR', era: '1970s' },
  { name: 'McLaren',          short: 'MCL', color: '#ea580c', country: 'GBR', era: '1970s' },
  { name: 'Brabham',          short: 'BRA', color: '#dc2626', country: 'GBR', era: '1970s' },
  { name: 'Wolf',             short: 'WLF', color: '#1e3a8a', country: 'CAN', era: '1970s' },
  { name: 'Hesketh',          short: 'HES', color: '#000000', country: 'GBR', era: '1970s' },
  { name: 'Shadow',           short: 'SHA', color: '#1f2937', country: 'GBR', era: '1970s' },
  { name: 'March',            short: 'MAR', color: '#dc2626', country: 'GBR', era: '1970s' },

  // 1960s
  { name: 'Cooper',           short: 'COO', color: '#16a34a', country: 'GBR', era: '1960s' },
  { name: 'BRM',              short: 'BRM', color: '#16a34a', country: 'GBR', era: '1960s' },
  { name: 'Lotus',            short: 'LOT', color: '#16a34a', country: 'GBR', era: '1960s' },
  { name: 'Eagle',            short: 'EAG', color: '#1e40af', country: 'USA', era: '1960s' },
  { name: 'Honda',            short: 'HON', color: '#fbbf24', country: 'JPN', era: '1960s' },
  { name: 'Brabham',          short: 'BRA', color: '#16a34a', country: 'GBR', era: '1960s' },
  { name: 'Matra',            short: 'MAT', color: '#1e40af', country: 'FRA', era: '1960s' },

  // 1950s
  { name: 'Alfa Romeo',       short: 'ALF', color: '#900000', country: 'ITA', era: '1950s' },
  { name: 'Maserati',         short: 'MAS', color: '#1e3a8a', country: 'ITA', era: '1950s' },
  { name: 'Mercedes-Benz',    short: 'MB',  color: '#c0c0c0', country: 'GER', era: '1950s' },
  { name: 'Vanwall',          short: 'VAN', color: '#16a34a', country: 'GBR', era: '1950s' },
  { name: 'Lancia',           short: 'LAN', color: '#dc2626', country: 'ITA', era: '1950s' },
  { name: 'Cooper',           short: 'COO', color: '#16a34a', country: 'GBR', era: '1950s' },
];

/* Country flag emojis (regional indicator pairs). Covers F1 nations + circuits. */
const COUNTRY_FLAGS = {
  AUS: '🇦🇺', AUT: '🇦🇹', BHR: '🇧🇭', CHN: '🇨🇳', ESP: '🇪🇸',
  MON: '🇲🇨', MCO: '🇲🇨', CAN: '🇨🇦', AZE: '🇦🇿', FRA: '🇫🇷', GBR: '🇬🇧',
  HUN: '🇭🇺', BEL: '🇧🇪', NED: '🇳🇱', NLD: '🇳🇱', ITA: '🇮🇹', SGP: '🇸🇬',
  RUS: '🇷🇺', JPN: '🇯🇵', USA: '🇺🇸', MEX: '🇲🇽', BRA: '🇧🇷',
  UAE: '🇦🇪', ARE: '🇦🇪', QAT: '🇶🇦', KSA: '🇸🇦', SAU: '🇸🇦', POR: '🇵🇹', PRT: '🇵🇹', TUR: '🇹🇷',
  GER: '🇩🇪', DEU: '🇩🇪', KOR: '🇰🇷', IND: '🇮🇳', MAL: '🇲🇾', MYS: '🇲🇾',
  FIN: '🇫🇮', DEN: '🇩🇰', DNK: '🇩🇰', SWE: '🇸🇪', NOR: '🇳🇴', POL: '🇵🇱',
  THA: '🇹🇭', NZL: '🇳🇿', RSA: '🇿🇦', ZAF: '🇿🇦', VEN: '🇻🇪', COL: '🇨🇴',
  ARG: '🇦🇷', CHE: '🇨🇭', SUI: '🇨🇭', LIE: '🇱🇮', IRL: '🇮🇪',
  CZE: '🇨🇿', JAM: '🇯🇲', PHL: '🇵🇭', INA: '🇮🇩', IDN: '🇮🇩', SVK: '🇸🇰',
  EST: '🇪🇪', LTU: '🇱🇹', LVA: '🇱🇻', LUX: '🇱🇺', URY: '🇺🇾',
  CHL: '🇨🇱',
};
const flag = (code) => COUNTRY_FLAGS[(code || '').toUpperCase()] || '🏁';
const ISO3_TO_ISO2 = {
  AUS: 'au', AUT: 'at', BHR: 'bh', CHN: 'cn', ESP: 'es', MON: 'mc', MCO: 'mc',
  CAN: 'ca', AZE: 'az', FRA: 'fr', GBR: 'gb', HUN: 'hu', BEL: 'be', NED: 'nl',
  NLD: 'nl', ITA: 'it', SGP: 'sg', RUS: 'ru', JPN: 'jp', USA: 'us', MEX: 'mx',
  BRA: 'br', UAE: 'ae', ARE: 'ae', QAT: 'qa', KSA: 'sa', SAU: 'sa', POR: 'pt',
  PRT: 'pt', TUR: 'tr', GER: 'de', DEU: 'de', KOR: 'kr', IND: 'in', MAL: 'my',
  MYS: 'my', FIN: 'fi', DEN: 'dk', DNK: 'dk', SWE: 'se', NOR: 'no', POL: 'pl',
  THA: 'th', NZL: 'nz', RSA: 'za', ZAF: 'za', VEN: 've', COL: 'co', ARG: 'ar',
  CHE: 'ch', SUI: 'ch', LIE: 'li', IRL: 'ie', CZE: 'cz', JAM: 'jm', PHL: 'ph',
  INA: 'id', IDN: 'id', SVK: 'sk', EST: 'ee', LTU: 'lt', LVA: 'lv', LUX: 'lu',
  URY: 'uy', CHL: 'cl'
};
function flagSvgUrl(code) {
  if (!code) return '';
  const c = String(code).toUpperCase();
  const iso2 = ISO3_TO_ISO2[c] || (c.length === 2 ? c.toLowerCase() : '');
  return iso2 ? `https://flagcdn.com/${iso2}.svg` : '';
}
function flagImg(code, w = 22, h = null) {
  if (!code) return '';
  const url = flagSvgUrl(code);
  if (!url) return `<span class="cf-emoji">${flag(code)}</span>`;
  const height = h ?? Math.round(w * 0.66);
  return `<img class="cf-img" src="${url}" alt="" loading="lazy" style="width:${w}px;height:${height}px">`;
}
const flagAndCode = (code) => code ? `${flagImg(code, 18)} ${esc(code)}` : '???';
function raceFlagHTML(race, size = 18) {
  const w = size + 10;
  const h = Math.round(w * 0.66);
  if (race?.flagImage) {
    return `<img class="race-flag-img" src="${esc(race.flagImage)}" alt="" loading="lazy" style="width:${w}px;height:${h}px">`;
  }
  const url = flagSvgUrl(race?.country);
  if (url) {
    return `<img class="race-flag-img" src="${url}" alt="${esc(race?.country || '')}" loading="lazy" style="width:${w}px;height:${h}px">`;
  }
  return `<span style="font-size:${size}px">${flag(race?.country)}</span>`;
}
// Strip "Grand Prix" / "GP" suffix from race names so the table reads cleanly
function shortGrandPrixName(race) {
  if (!race?.name) return '—';
  return race.name
    .replace(/\bgrand prix\b/i, '')
    .replace(/\bgp\b/i, '')
    .replace(/\s+/g, ' ')
    .trim() || race.name;
}

/* ---------- state ---------- */
let state = loadState();
// Initialize preset extension fields if missing (forwards-compatible)
if (!state.customDriverPresets) state.customDriverPresets = [];
if (!state.customTeamPresets)   state.customTeamPresets   = [];
if (!state.customTrackPresets)  state.customTrackPresets  = [];
if (!state.presetOverrides)     state.presetOverrides     = { drivers: {}, teams: {}, tracks: {} };
if (!state.presetOverrides.tracks) state.presetOverrides.tracks = {};
// Keys of built-in presets the user has deleted (hidden) from the library.
if (!state.hiddenPresets)       state.hiddenPresets       = { drivers: [], teams: [], tracks: [] };
// Per-race championship-points multipliers (raceId -> 0.5 | 2). 1 = regular = absent.
if (!state.racePointsMultipliers) state.racePointsMultipliers = {};
// Roster bundles — saved groups of drivers or teams that can be loaded into any season as a class.
// Each: { id, name, savedAt, drivers: [{ name, number, country, photo, era }], note }
if (!state.driverClasses) state.driverClasses = [];
if (!state.teamClasses)   state.teamClasses   = [];
// Calendar presets — saved race calendars, available across all saves (like roster bundles).
if (!state.calendarPresets) state.calendarPresets = [];
// FEATURE #8: Season templates — full snapshots of a season (calendar + teams + drivers, no results)
if (!state.seasonTemplates) state.seasonTemplates = [];
let standingsTab = 'drivers';
let recordsTab = 'book'; // 'book' (career records) | 'tracks' (per-circuit records)
let seasonWins = []; // populated by calcAllTimeRecords; reset before each call

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
    // try legacy keys (APEX → P1 migration)
    for (const k of LEGACY_KEYS) {
      const legacy = localStorage.getItem(k);
      if (legacy) {
        const parsed = JSON.parse(legacy);
        // save under new key
        localStorage.setItem(STORAGE_KEY, legacy);
        return parsed;
      }
    }
  } catch (e) { console.warn('Could not load save', e); }
  return { saves: {}, activeSaveId: null, activeSeasonId: null, view: 'home' };
}
/* Driver photos and team logos are large data URLs. We keep them in memory (and
   they still sync to the cloud) but DELIBERATELY strip them from the localStorage
   copy so they don't bloat it / blow the storage quota. On load they're
   re-hydrated from the preset library (and from the cloud when signed in). */
function stateForStorage() {
  const saves = {};
  for (const sid in (state.saves || {})) {
    const save = state.saves[sid];
    const seasons = {};
    for (const seid in (save.seasons || {})) {
      const season = save.seasons[seid];
      seasons[seid] = {
        ...season,
        drivers: (season.drivers || []).map(d => {
          // Drop the heavy multi-photo gallery always; drop the single photo only
          // when it's a big base64 blob. Short Storage/URLs are kept so they survive
          // a reload (and the "prefer newer local" merge).
          const { photos, ...rest } = d;
          if (rest.photo && String(rest.photo).startsWith('data:')) delete rest.photo;
          return rest;
        }),
        teams: (season.teams || []).map(t => {
          const rest = { ...t };
          if (rest.logo && String(rest.logo).startsWith('data:')) delete rest.logo;
          return rest;
        }),
      };
    }
    saves[sid] = { ...save, seasons };
  }
  return { ...state, saves };
}

function saveState() {
  try {
    state.saves[state.activeSaveId] && (state.saves[state.activeSaveId].updatedAt = Date.now());
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stateForStorage()));
  } catch (e) { console.warn('Save failed', e); }
  // Mirror to cloud in the background (debounced, no-op if cloud disabled or not signed in)
  scheduleCloudSync();
}

/* ---------- utils ---------- */
// uid() — generates a proper RFC 4122 UUID v4 (36 chars with dashes).
// Postgres' `uuid` column type is strict and rejects short random strings,
// so we use crypto.randomUUID() when available, falling back to a hand-rolled
// v4 generator for very old browsers.
const uid = () => {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  // Fallback for legacy environments
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
};

// Check whether a string is a valid UUID. Used to detect legacy short IDs that
// need upgrading before they can be pushed to Supabase.
const isUuid = (s) => typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

// Walk the entire state and upgrade any short-id entities to UUIDs. We build a
// map of old → new IDs as we go, then patch every cross-reference (teamId on
// drivers, driverId on results, pole/FL on races, etc.) so the data still hangs
// together after the upgrade. Called from saveState() before each cloud sync.
function upgradeIdsToUuids() {
  let changed = false;
  for (const save of Object.values(state.saves || {})) {
    if (!isUuid(save.id)) {
      const newId = uid();
      // Update the keying as well so state.saves[id] lookups keep working
      delete state.saves[save.id];
      save.id = newId;
      state.saves[newId] = save;
      if (state.activeSaveId && !isUuid(state.activeSaveId)) state.activeSaveId = newId;
      changed = true;
    }
    for (const season of Object.values(save.seasons || {})) {
      // Build the old-to-new map for this season's entities
      const teamMap = {};
      const driverMap = {};
      const raceMap = {};
      if (!isUuid(season.id)) {
        const newId = uid();
        delete save.seasons[season.id];
        season.id = newId;
        save.seasons[newId] = season;
        if (state.activeSeasonId && !isUuid(state.activeSeasonId)) state.activeSeasonId = newId;
        changed = true;
      }
      (season.teams || []).forEach(t => {
        if (!isUuid(t.id)) { const n = uid(); teamMap[t.id] = n; t.id = n; changed = true; }
      });
      (season.drivers || []).forEach(d => {
        if (!isUuid(d.id)) { const n = uid(); driverMap[d.id] = n; d.id = n; changed = true; }
        // Patch teamId reference using the team map
        if (d.teamId && teamMap[d.teamId]) d.teamId = teamMap[d.teamId];
      });
      (season.races || []).forEach(r => {
        if (!isUuid(r.id)) { const n = uid(); raceMap[r.id] = n; r.id = n; changed = true; }
        // Patch pole/FL driver references
        if (r.poleDriverId && driverMap[r.poleDriverId]) r.poleDriverId = driverMap[r.poleDriverId];
        if (r.fastestLapDriverId && driverMap[r.fastestLapDriverId]) r.fastestLapDriverId = driverMap[r.fastestLapDriverId];
        // Patch driverId in every result row
        (r.results || []).forEach(res => {
          if (res.driverId && driverMap[res.driverId]) res.driverId = driverMap[res.driverId];
        });
        (r.sprintResults || []).forEach(res => {
          if (res.driverId && driverMap[res.driverId]) res.driverId = driverMap[res.driverId];
        });
      });
    }
  }
  if (changed) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(stateForStorage())); } catch {}
  }
  return changed;
}
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmtDate = (ts) => {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
};
const isoDate = (ts) => ts ? new Date(ts).toISOString().slice(0,10) : '';
// FEATURE #4: Last-edited indicator helpers
const formatRelativeTime = (ts) => {
  if (!ts) return '';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s/60)}m ago`;
  if (s < 86400) return `${Math.floor(s/3600)}h ago`;
  if (s < 604800) return `${Math.floor(s/86400)}d ago`;
  return new Date(ts).toLocaleDateString();
};
const lastEditedBadge = (entity) => {
  if (!entity?._updatedAt) return '';
  const isYou = entity._lastEditedBy && currentUser && entity._lastEditedBy === currentUser.id;
  const who = isYou ? 'you' : (entity._lastEditedBy ? entity._lastEditedBy.slice(0,6) + '…' : '—');
  return `<div class="edit-stamp" title="Edited ${new Date(entity._updatedAt).toLocaleString()}">edited by ${esc(who)} · ${formatRelativeTime(entity._updatedAt)}</div>`;
};
const teamColor = (season, teamId) => season.teams.find(t => t.id === teamId)?.color || '#666';
const teamName  = (season, teamId) => season.teams.find(t => t.id === teamId)?.name || 'No Team';
const teamShort = (season, teamId) => season.teams.find(t => t.id === teamId)?.short || '—';
const driverName = (season, driverId) => {
  const d = season.drivers.find(x => x.id === driverId);
  return d ? d.name : '—';
};
const driverNum = (season, driverId) => {
  const d = season.drivers.find(x => x.id === driverId);
  return d ? d.number : '—';
};
const splitName = (n) => {
  const parts = (n || '').trim().split(/\s+/);
  if (parts.length === 1) return { first: '', last: parts[0] };
  return { first: parts.slice(0,-1).join(' '), last: parts[parts.length-1] };
};

/* ---------- image helpers ---------- */
// Storage budget per image — base64 chars are 4/3 the raw bytes, so 50KB chars ≈ 37KB raw.
// At thousand-user scale, this is the line between "fits free tier" and "billing tier needed".
// Hard cap is the absolute ceiling; target is what we try for in the first pass.
const IMAGE_HARD_CAP = 60 * 1024;      // 60KB max final size (string length in chars)
const IMAGE_TARGET   = 30 * 1024;      // try for 30KB first
const IMAGE_UPLOAD_MAX_BYTES = 5 * 1024 * 1024;  // reject uploads > 5MB pre-compression
const IMAGE_UPLOAD_WARN_BYTES = 1 * 1024 * 1024; // warn at > 1MB

function fileToDataURL(file, maxDim = 200, quality = 0.7) {
  return new Promise((resolve, reject) => {
    if (!file) return reject(new Error('No file'));
    if (!/^image\//.test(file.type)) return reject(new Error('Not an image'));
    if (file.size > IMAGE_UPLOAD_MAX_BYTES) {
      return reject(new Error(`Image too large (${Math.round(file.size / 1024 / 1024)}MB). Please use an image under 5MB.`));
    }
    if (file.size > IMAGE_UPLOAD_WARN_BYTES) {
      // Soft warning — proceed anyway but heavy compression incoming
      console.warn(`[P1] large image (${Math.round(file.size / 1024)}KB), aggressive compression will be applied`);
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        // First pass at the requested dimensions
        let result = encodeAtDim(img, maxDim, quality);
        // If still too big, iteratively shrink + lower quality until we fit under the hard cap
        let currentDim = maxDim;
        let currentQ = quality;
        let iterations = 0;
        while (result.length > IMAGE_HARD_CAP && iterations < 6) {
          iterations++;
          // Each pass: drop dim by 15% AND drop quality by 0.08
          currentDim = Math.round(currentDim * 0.85);
          currentQ = Math.max(0.35, currentQ - 0.08);
          result = encodeAtDim(img, currentDim, currentQ);
        }
        if (result.length > IMAGE_HARD_CAP) {
          return reject(new Error(`Could not compress image below ${Math.round(IMAGE_HARD_CAP/1024)}KB. Try a simpler image.`));
        }
        resolve(result);
      };
      img.onerror = () => reject(new Error('Bad image'));
      img.src = e.target.result;
    };
    reader.onerror = () => reject(new Error('Read fail'));
    reader.readAsDataURL(file);
  });
}
function encodeAtDim(img, maxDim, quality) {
  let w = img.width, h = img.height;
  if (w > h) { if (w > maxDim) { h = h * maxDim / w; w = maxDim; } }
  else      { if (h > maxDim) { w = w * maxDim / h; h = maxDim; } }
  const c = document.createElement('canvas');
  c.width = Math.round(w); c.height = Math.round(h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#1a1a1a'; ctx.fillRect(0,0,c.width,c.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', quality);
}

/**
 * Render a photo-upload widget. The container should already exist in DOM.
 * options: { initial: dataURL or '', shape: 'circle'|'square', placeholder: string, onChange: (newValue) => void }
 */
/* =====================================================
   MULTI-PHOTO PRESET HELPERS
   A driver preset can carry a gallery of photos (e.g. Hamilton at Mercedes
   vs. Ferrari vs. McLaren). One photo is marked the default. When a driver
   is signed from the preset, the user picks which photo to use.
   Legacy presets that only have `photo` are normalised to a single-entry
   gallery on read, so old saves keep working.
   ===================================================== */
function presetPhotosList(preset) {
  if (!preset) return [];
  if (Array.isArray(preset.photos) && preset.photos.length) {
    return preset.photos.filter(p => p && p.url);
  }
  if (preset.photo) return [{ id: 'main', url: preset.photo, label: '', isDefault: true }];
  return [];
}
function defaultPresetPhoto(preset) {
  const all = presetPhotosList(preset);
  if (!all.length) return '';
  return (all.find(p => p.isDefault) || all[0]).url || '';
}
// Pick the preset photo that best fits a specific season. Drivers can carry
// several labelled photos in their gallery (e.g. one tagged "2023", another
// "2024"); when importing a season we match the season's year — then any label
// found in the season name — and only fall back to the default photo if nothing
// matches. So a 2023 import grabs the driver's 2023 portrait automatically.
function pickPresetPhotoForSeason(preset, opts) {
  const photos = presetPhotosList(preset);
  if (!photos.length) return '';
  const year = String((opts && opts.year) || '').trim();
  const name = String((opts && opts.name) || '');
  // 1. A photo whose label contains the season's 4-digit year (word-bounded so
  //    "2023" doesn't match inside "12023").
  if (/^\d{4}$/.test(year)) {
    const re = new RegExp('\\b' + year + '\\b');
    const byYear = photos.find(p => p.label && re.test(p.label));
    if (byYear) return byYear.url;
  }
  // 2. A photo whose label appears within the season name (e.g. name
  //    "2024 World Championship" matching a label of "2024" or "Red Bull 2024").
  if (name.trim()) {
    const lname = name.toLowerCase();
    const byName = photos.find(p => {
      const l = (p.label || '').toLowerCase().trim();
      return l && lname.includes(l);
    });
    if (byName) return byName.url;
  }
  // 3. Default-flagged photo, else the first one.
  return (photos.find(p => p.isDefault) || photos[0]).url || '';
}

function mountPhotoGallery(container, initial, onChange) {
  const items = (initial || []).map(p => ({
    id: p.id || uid(),
    url: p.url || '',
    label: p.label || '',
  })).filter(p => p.url);
  let defaultId = (initial || []).find(p => p.isDefault)?.id || items[0]?.id || null;

  function emit() {
    onChange(items.map(p => ({ id: p.id, url: p.url, label: p.label, isDefault: p.id === defaultId })));
  }

  function render() {
    container.innerHTML = `
      <div class="photo-gallery">
        ${items.map(p => `
          <div class="photo-gallery-item ${p.id === defaultId ? 'is-default' : ''}" data-id="${p.id}">
            <div class="photo-gallery-thumb" style="background-image:url('${esc(p.url)}')">${p.id === defaultId ? '<span class="photo-gallery-default-badge">DEFAULT</span>' : ''}</div>
            <input class="photo-gallery-label" type="text" placeholder="Label (e.g. Mercedes era)" value="${esc(p.label || '')}" data-id="${p.id}" maxlength="40">
            <div class="photo-gallery-actions">
              <button type="button" class="photo-gallery-btn star ${p.id === defaultId ? 'active' : ''}" data-default="${p.id}" title="${p.id === defaultId ? 'Default photo' : 'Set as default'}">
                <svg viewBox="0 0 24 24" width="12" height="12" fill="${p.id === defaultId ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15 8.5 22 9.3 17 14.2 18.2 21 12 17.8 5.8 21 7 14.2 2 9.3 9 8.5 12 2"/></svg>
                <span>${p.id === defaultId ? 'DEFAULT' : 'SET DEFAULT'}</span>
              </button>
              <button type="button" class="photo-gallery-btn remove" data-remove="${p.id}" title="Remove this photo" aria-label="Remove photo">
                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>
              </button>
            </div>
          </div>
        `).join('')}
        <label class="photo-gallery-add">
          <input type="file" accept="image/*" multiple style="display:none">
          <div class="photo-gallery-add-inner">
            <span class="photo-gallery-add-icon">＋</span>
            <span class="photo-gallery-add-label">${items.length ? 'ADD ANOTHER' : 'ADD PHOTO'}</span>
          </div>
        </label>
      </div>`;

    $$('.photo-gallery-label', container).forEach(inp => {
      inp.oninput = () => {
        const item = items.find(p => p.id === inp.dataset.id);
        if (item) { item.label = inp.value; emit(); }
      };
    });
    $$('[data-default]', container).forEach(b => {
      b.onclick = () => { defaultId = b.dataset.default; emit(); render(); };
    });
    $$('[data-remove]', container).forEach(b => {
      b.onclick = () => {
        const id = b.dataset.remove;
        const idx = items.findIndex(p => p.id === id);
        if (idx < 0) return;
        items.splice(idx, 1);
        if (defaultId === id) defaultId = items[0]?.id || null;
        emit(); render();
      };
    });
    container.querySelector('.photo-gallery-add input').onchange = async (e) => {
      const files = Array.from(e.target.files || []);
      for (const f of files) {
        try {
          const url = await fileToDataURL(f, 300);
          const newItem = { id: uid(), url, label: '' };
          items.push(newItem);
          if (!defaultId) defaultId = newItem.id;
        } catch (err) { toast(err.message || 'Could not load image', 'error'); }
      }
      emit(); render();
    };
  }

  render();
  emit();
}

function pickPresetPhoto(preset, onPick) {
  const photos = presetPhotosList(preset);
  if (photos.length <= 1) { onPick(photos[0]?.url || ''); return; }
  modal({
    title: `<span class="accent">Pick</span> a Photo`,
    body: `
      <div class="field-help" style="margin-bottom:14px">
        <b>${esc(preset.name)}</b> has ${photos.length} photos saved. Choose which one to use for this driver — you can change it later.
      </div>
      <div class="photo-picker-grid">
        ${photos.map(p => `
          <button type="button" class="photo-picker-card ${p.isDefault ? 'is-default' : ''}" data-url="${esc(p.url)}">
            <div class="photo-picker-thumb" style="background-image:url('${esc(p.url)}')">${p.isDefault ? '<span class="photo-picker-default-badge">DEFAULT</span>' : ''}</div>
            <div class="photo-picker-label">${esc(p.label || 'Untitled')}</div>
          </button>
        `).join('')}
      </div>`,
    footer: `<button class="btn btn-ghost" data-act="cancel">Cancel</button>`,
    onMount: (root, close) => {
      $('[data-act="cancel"]', root).onclick = close;
      $$('.photo-picker-card', root).forEach(b => {
        b.onclick = () => { onPick(b.dataset.url); close(); };
      });
    }
  });
}

function mountPhotoUpload(container, { initial = '', shape = 'circle', placeholder = '?', onChange = () => {} }) {
  let value = initial || '';
  function render() {
    container.innerHTML = `
      <div class="photo-upload">
        <div class="photo-preview ${shape === 'square' ? 'logo' : ''}" style="${value ? `background-image:url('${esc(value)}')` : ''}">${value ? '' : esc(placeholder)}</div>
        <div class="photo-controls">
          <div class="photo-controls-row">
            <button type="button" class="photo-file-btn" data-act="upload">UPLOAD</button>
            ${value ? `<button type="button" class="photo-clear-btn" data-act="clear">REMOVE</button>` : ''}
          </div>
          <input type="text" data-act="url" placeholder="…or paste image URL" value="${value && !value.startsWith('data:') ? esc(value) : ''}">
        </div>
        <input type="file" accept="image/*" data-act="file" style="display:none">
      </div>`;
    const fileInp = $('[data-act="file"]', container);
    const urlInp  = $('[data-act="url"]', container);
    $('[data-act="upload"]', container).onclick = () => fileInp.click();
    fileInp.onchange = async () => {
      const f = fileInp.files[0]; if (!f) return;
      try {
        const dataUrl = await fileToDataURL(f, shape === 'square' ? 200 : 250);
        value = dataUrl; onChange(value); render();
      } catch (e) { toast(e.message || 'Could not load image', 'error'); }
    };
    urlInp.onchange = () => {
      value = urlInp.value.trim(); onChange(value); render();
    };
    const clearBtn = $('[data-act="clear"]', container);
    if (clearBtn) clearBtn.onclick = () => { value = ''; onChange(value); render(); };
  }
  render();
  return { getValue: () => value, setValue: (v) => { value = v || ''; render(); } };
}

/* derive driver initials for empty photo placeholder */
function driverInitials(name) {
  if (!name) return '??';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0,2).toUpperCase();
  return (parts[0][0] + parts[parts.length-1][0]).toUpperCase();
}

const activeSave    = () => state.saves[state.activeSaveId];
const activeSeason  = () => activeSave()?.seasons[state.activeSeasonId];

/* ---------- toast / modal ---------- */
function toast(msg, type = '') {
  const root = $('#toast-root');
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  root.appendChild(el);
  setTimeout(() => { el.classList.add('fading'); }, 2600);
  setTimeout(() => { el.remove(); }, 3000);
}

function modal({ title, body, footer, onMount, size }) {
  const root = $('#modal-root');
  // Stackable: append a new backdrop on top of any existing modal rather than clearing root
  const back = document.createElement('div');
  back.className = 'modal-backdrop';
  back.innerHTML = `
    <div class="modal ${size || ''}" role="dialog" aria-modal="true">
      <div class="modal-head">
        <div class="modal-title">${title}</div>
        <button class="modal-close" aria-label="Close">✕</button>
      </div>
      <div class="modal-body">${body}</div>
      ${footer ? `<div class="modal-foot">${footer}</div>` : ''}
    </div>`;
  root.appendChild(back);
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => {
    // Only the topmost modal responds to Escape so stacked modals close one-at-a-time
    if (e.key === 'Escape' && root.lastElementChild === back) close();
  };
  document.addEventListener('keydown', onKey);
  back.addEventListener('click', e => { if (e.target === back) close(); });
  $('.modal-close', back).onclick = close;
  if (onMount) onMount(back, close);
  return close;
}

function confirmModal({ title, message, danger, onConfirm }) {
  modal({
    title,
    size: 'confirm',
    body: `<p>${message}</p>`,
    footer: `
      <button class="btn btn-ghost" data-act="cancel">Cancel</button>
      <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-act="ok">Confirm</button>`,
    onMount: (root, close) => {
      $('[data-act="cancel"]', root).onclick = close;
      $('[data-act="ok"]', root).onclick = () => { close(); onConfirm(); };
    }
  });
}

/* ---------- save / season operations ---------- */
function createSave(name) {
  const id = uid();
  state.saves[id] = {
    id, name: name.trim() || 'Untitled Save',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    seasons: {}
  };
  state.activeSaveId = id;
  state.activeSeasonId = null;
  state.view = 'home-save';
  saveState();
}

function deleteSave(id) {
  // Issue the cloud delete BEFORE removing from local state so the helper can
  // still see the save_id in cloudSaveIds for cleanup. The promise fires-and-forgets;
  // local state proceeds regardless of cloud success.
  cloudDeleteSave(id);
  delete state.saves[id];
  if (state.activeSaveId === id) {
    state.activeSaveId = null;
    state.activeSeasonId = null;
    state.view = 'home';
  }
  saveState();
}

function renameSave(id, newName) {
  if (!state.saves[id]) return;
  state.saves[id].name = newName.trim() || state.saves[id].name;
  saveState();
}

function createSeason({
  year, name, pointsSystemId,
  // Legacy boolean API (still supported for the F1 importer + old call sites)
  withPresetTeams, withPresetCalendar, withPresetDrivers,
  // New API — pass IDs to pick specific saved bundles, "default" for built-in, "" for none
  teamBundleId,     // '' | 'default' | <saved-team-class-id>
  driverBundleId,   // '' | 'default' | <saved-driver-class-id>
  calendarPresetId, // '' | 'default' | <saved-calendar-preset-id>
  driverCount,      // how many drivers to generate for the DEFAULT grid (1–30)
}) {
  const save = activeSave(); if (!save) return;
  const id = uid();
  const season = {
    id,
    year: Number(year) || new Date().getFullYear(),
    name: (name || '').trim() || `${year} Season`,
    pointsSystemId: pointsSystemId || DEFAULT_POINTS_SYSTEM_ID,
    polePointEnabled: false,    // toggle: 1 bonus point for pole position
    flPointEnabled: true,       // toggle: 1 bonus point for fastest lap (top-10 only)
    polePointValue: 1,
    flPointValue: 1,
    createdAt: Date.now(),
    drivers: [],
    teams: [],
    races: [],
  };

  // ─── TEAMS ──────────────────────────────────────────────
  // New API takes precedence. If teamBundleId is set, use it; else fall back to the bool.
  const teamChoice = teamBundleId !== undefined
    ? teamBundleId
    : (withPresetTeams ? 'default' : '');
  if (teamChoice === 'default') {
    PRESET_TEAMS.forEach(t => {
      season.teams.push({ id: uid(), name: t.name, short: t.short, color: t.color, country: t.country });
    });
  } else if (teamChoice) {
    const bundle = (state.teamClasses || []).find(c => c.id === teamChoice);
    if (bundle) {
      bundle.teams.forEach(t => {
        season.teams.push({
          id: uid(),
          name: t.name,
          short: t.short || (t.name || '').slice(0, 3).toUpperCase(),
          country: t.country || '',
          color: t.color || '#666',
          logo: t.logo || '',
          dsq: false,
        });
      });
    }
  }

  // ─── DRIVERS ────────────────────────────────────────────
  const driverChoice = driverBundleId !== undefined
    ? driverBundleId
    : (withPresetDrivers && withPresetTeams ? 'default' : '');
  if (driverChoice === 'default' && season.teams.length) {
    // Generate the requested number of sample drivers (clamped 1–30, default 20)
    // and distribute them round-robin across the teams so every team gets an
    // even share (e.g. 30 drivers over 10 teams → 3 each; 25 → some 3, some 2).
    const count = Math.max(1, Math.min(30, Math.round(Number(driverCount) || 20)));
    for (let i = 0; i < count; i++) {
      const team = season.teams[i % season.teams.length];
      // Shift the last-name index by one extra step on each full pass through the
      // first-name list, so names stay unique past 20 drivers (e.g. driver 0 and
      // driver 20 share a first name but get different surnames).
      const cycle = Math.floor(i / SAMPLE_FIRSTS.length);
      const first = SAMPLE_FIRSTS[i % SAMPLE_FIRSTS.length];
      const last  = SAMPLE_LASTS[(i + 5 + cycle) % SAMPLE_LASTS.length];
      season.drivers.push({
        id: uid(),
        name: `${first} ${last}`,
        number: i + 1,
        country: SAMPLE_COUNTRIES[i % SAMPLE_COUNTRIES.length],
        teamId: team.id,
      });
    }
  } else if (driverChoice) {
    const bundle = (state.driverClasses || []).find(c => c.id === driverChoice);
    if (bundle) {
      bundle.drivers.forEach(d => {
        season.drivers.push({
          id: uid(),
          name: d.name,
          number: d.number,
          country: d.country || '',
          photo: d.photo || '',
          teamId: null, // bundle has no team mapping
          dsq: false,
        });
      });
    }
  }

  // ─── CALENDAR ───────────────────────────────────────────
  const calChoice = calendarPresetId !== undefined
    ? calendarPresetId
    : (withPresetCalendar ? 'default' : '');
  if (calChoice === 'default') {
    PRESET_CALENDAR.forEach((r, i) => {
      season.races.push({
        id: uid(),
        round: i + 1,
        name: r.name,
        circuit: r.circuit,
        country: r.country,
        sprint: !!r.sprint,
        date: '',
        completed: false,
        results: [],
        sprintResults: [],
        fastestLapDriverId: null,
        poleDriverId: null,
      });
    });
  } else if (calChoice) {
    const preset = (state.calendarPresets || []).find(c => c.id === calChoice);
    if (preset) {
      preset.races.forEach((r, i) => {
        season.races.push({
          id: uid(),
          round: i + 1,
          name: r.name,
          circuit: r.circuit,
          country: r.country,
          flagImage: r.flagImage || '',
          sprint: !!r.sprint,
          date: '',
          completed: false,
          results: [],
          sprintResults: [],
          fastestLapDriverId: null,
          poleDriverId: null,
        });
      });
    }
  }

  save.seasons[id] = season;
  state.activeSeasonId = id;
  state.view = 'dashboard';
  saveState();
}

function deleteSeason(id) {
  const save = activeSave(); if (!save) return;
  cloudDeleteSeason(id);
  delete save.seasons[id];
  if (state.activeSeasonId === id) {
    state.activeSeasonId = null;
    state.view = 'home-save';
  }
  saveState();
}

/* ---------- driver / team / race CRUD ---------- */
function addDriver({ name, number, country, teamId, photo, abbr }) {
  const s = activeSeason(); if (!s) return;
  s.drivers.push({
    id: uid(),
    name: name.trim(),
    number: Number(number) || 0,
    country: (country || '').toUpperCase().slice(0,3),
    abbr: (abbr || '').toUpperCase().slice(0,3),
    teamId: teamId || null,
    photo: photo || ''
  });
  saveState();
}
function updateDriver(id, patch) {
  const s = activeSeason(); if (!s) return;
  const d = s.drivers.find(x => x.id === id); if (!d) return;
  Object.assign(d, patch);
  if (patch.country) d.country = patch.country.toUpperCase().slice(0,3);
  if (patch.number != null) d.number = Number(patch.number) || d.number;
  saveState();
}
function toggleDriverDsq(id) {
  const s = activeSeason(); if (!s) return;
  const d = s.drivers.find(x => x.id === id); if (!d) return;
  d.dsq = !d.dsq;
  saveState();
}
function toggleTeamDsq(id) {
  const s = activeSeason(); if (!s) return;
  const t = s.teams.find(x => x.id === id); if (!t) return;
  t.dsq = !t.dsq;
  saveState();
}
function deleteDriver(id) {
  const s = activeSeason(); if (!s) return;
  cloudDeleteDriver(id);
  s.drivers = s.drivers.filter(x => x.id !== id);
  s.races.forEach(r => {
    r.results = r.results.filter(x => x.driverId !== id);
    r.sprintResults = r.sprintResults.filter(x => x.driverId !== id);
    if (r.fastestLapDriverId === id) r.fastestLapDriverId = null;
    if (r.poleDriverId === id) r.poleDriverId = null;
  });
  saveState();
}
function addTeam({ name, short, color, country, logo, presetKey }) {
  const s = activeSeason(); if (!s) return;
  s.teams.push({
    id: uid(),
    name: name.trim(),
    short: (short || '').toUpperCase().slice(0,4),
    color: color || '#666',
    country: (country || '').toUpperCase().slice(0,3),
    logo: logo || '',
    presetKey: presetKey || null
  });
  saveState();
}
function updateTeam(id, patch) {
  const s = activeSeason(); if (!s) return;
  const t = s.teams.find(x => x.id === id); if (!t) return;
  Object.assign(t, patch);
  if (patch.short) t.short = patch.short.toUpperCase().slice(0,4);
  if (patch.country) t.country = patch.country.toUpperCase().slice(0,3);
  saveState();
}
function deleteTeam(id) {
  const s = activeSeason(); if (!s) return;
  cloudDeleteTeam(id);
  s.teams = s.teams.filter(x => x.id !== id);
  s.drivers.forEach(d => { if (d.teamId === id) d.teamId = null; });
  saveState();
}
function addRace({ name, circuit, country, sprint, date, flagImage }) {
  const s = activeSeason(); if (!s) return;
  s.races.push({
    id: uid(), round: s.races.length + 1,
    name: name.trim(), circuit: (circuit || '').trim(), country: (country || '').toUpperCase().slice(0,3),
    flagImage: flagImage || '',
    sprint: !!sprint, date: date || '', completed: false,
    results: [], sprintResults: [],
    fastestLapDriverId: null, poleDriverId: null,
  });
  saveState();
}
function updateRace(id, patch) {
  const s = activeSeason(); if (!s) return;
  const r = s.races.find(x => x.id === id); if (!r) return;
  Object.assign(r, patch);
  saveState();
}
function deleteRace(id) {
  const s = activeSeason(); if (!s) return;
  cloudDeleteRace(id);
  s.races = s.races.filter(x => x.id !== id);
  s.races.forEach((r, i) => r.round = i + 1);
  saveState();
}

/* ---------- standings & records calculations ---------- */
/* Per-race championship-points multiplier. 1 = regular (default), 0.5 = half
   points, 2 = double points. Stored in a local map keyed by race id (kept out of
   the cloud-synced save objects so a cloud pull never drops it). */
function racePointsMultiplier(race) {
  if (!race) return 1;
  const m = Number((state.racePointsMultipliers || {})[race.id]);
  return (m === 0.5 || m === 2) ? m : 1;
}
function setRacePointsMultiplier(raceId, value) {
  if (!state.racePointsMultipliers) state.racePointsMultipliers = {};
  const v = Number(value);
  if (v === 0.5 || v === 2) state.racePointsMultipliers[raceId] = v;
  else delete state.racePointsMultipliers[raceId]; // 1 = regular → no entry
  saveState();
}

function calcDriverStandings(season) {
  const ps = getPointsSystem(season.pointsSystemId || DEFAULT_POINTS_SYSTEM_ID);
  const totals = {};
  season.drivers.forEach(d => {
    const team = season.teams.find(t => t.id === d.teamId);
    const champDsq = !!d.dsq || !!(team && team.dsq);
    totals[d.id] = {
      driverId: d.id,
      points: 0, wins: 0, podiums: 0, polePositions: 0,
      fastestLaps: 0, dnfs: 0, dsqs: 0, dnss: 0, races: 0,
      sprintWins: 0,
      championshipDsq: champDsq,
    };
  });
  season.races.forEach(race => {
    if (!race.completed) return;
    // Per-race points multiplier: 1 = regular (default), 0.5 = half, 2 = double.
    // Scales every point this race awards (positions, sprint, pole, fastest lap).
    const mult = racePointsMultiplier(race);
    const finishers = (race.results || []).slice().sort((a,b) => (a.position || 999) - (b.position || 999));
    finishers.forEach(res => {
      const tot = totals[res.driverId]; if (!tot) return;
      // DNS = did not start (no race start counted, no points)
      if (res.dns) { tot.dnss++; return; }
      // count race start
      tot.races++;
      // DSQ = race-disqualified (no points, no win, no podium counted)
      if (res.dsq) { tot.dsqs++; return; }
      // DNF = retired (start counted, no points, no win/podium)
      if (res.dnf) { tot.dnfs++; return; }
      // championship-DSQd drivers earn no points
      if (tot.championshipDsq) return;
      if (res.position && res.position <= ps.points.length) {
        tot.points += ps.points[res.position - 1] * mult;
      }
      if (res.position === 1) tot.wins++;
      if (res.position && res.position <= 3) tot.podiums++;
    });
    // sprint points
    if (race.sprint && race.sprintResults && ps.sprintPoints && ps.sprintPoints.length) {
      race.sprintResults.forEach(sr => {
        const tot = totals[sr.driverId]; if (!tot) return;
        if (sr.dns || sr.dsq || sr.dnf) return;
        if (tot.championshipDsq) return;
        if (sr.position && sr.position <= ps.sprintPoints.length) {
          tot.points += ps.sprintPoints[sr.position - 1] * mult;
        }
        if (sr.position === 1) tot.sprintWins++;
      });
    }
    // pole
    if (race.poleDriverId && totals[race.poleDriverId] && !totals[race.poleDriverId].championshipDsq) {
      totals[race.poleDriverId].polePositions++;
      // pole-point bonus when enabled per-season
      if (season.polePointEnabled && Number(season.polePointValue) > 0) {
        totals[race.poleDriverId].points += Number(season.polePointValue) * mult;
      }
    }
    // fastest lap
    if (race.fastestLapDriverId && totals[race.fastestLapDriverId]) {
      const tot = totals[race.fastestLapDriverId];
      tot.fastestLaps++;
      // resolve FL points: explicit per-season toggle wins, else fall back to points-system default
      const flEnabled = (season.flPointEnabled !== undefined)
        ? !!season.flPointEnabled
        : (ps.flBonus > 0);
      const flValue = (season.flPointEnabled !== undefined)
        ? (Number(season.flPointValue) || 0)
        : (ps.flBonus || 0);
      if (!tot.championshipDsq && flEnabled && flValue) {
        const flRes = (race.results || []).find(r => r.driverId === race.fastestLapDriverId);
        if (flRes && !flRes.dnf && !flRes.dsq && !flRes.dns && flRes.position) {
          if (!ps.flRequiresTop10 || flRes.position <= 10) {
            tot.points += flValue * mult;
          }
        }
      }
    }
  });
  return Object.values(totals).sort((a,b) => {
    if (a.championshipDsq !== b.championshipDsq) return a.championshipDsq ? 1 : -1;
    return b.points - a.points || b.wins - a.wins || b.podiums - a.podiums;
  });
}

function calcTeamStandings(season) {
  const driverTotals = calcDriverStandings(season);
  const teamMap = {};
  season.teams.forEach(t => {
    teamMap[t.id] = { teamId: t.id, points: 0, wins: 0, podiums: 0, polePositions: 0, fastestLaps: 0 };
  });
  driverTotals.forEach(d => {
    const driver = season.drivers.find(x => x.id === d.driverId);
    if (!driver || !driver.teamId || !teamMap[driver.teamId]) return;
    teamMap[driver.teamId].points += d.points;
    teamMap[driver.teamId].wins += d.wins;
    teamMap[driver.teamId].podiums += d.podiums;
    teamMap[driver.teamId].polePositions += d.polePositions;
    teamMap[driver.teamId].fastestLaps += d.fastestLaps;
  });
  return Object.values(teamMap).sort((a,b) => b.points - a.points || b.wins - a.wins);
}

/* ALL-TIME records — aggregates across every save and every season */
function calcAllTimeRecords() {
  const driverByName = new Map();
  const teamByName   = new Map();

  const ensureD = (key, name) => {
    if (!driverByName.has(key)) driverByName.set(key, {
      key, name,
      wins: 0, podiums: 0, poles: 0, fastestLaps: 0,
      points: 0, championships: 0, starts: 0,
      sprintWins: 0, dnfs: 0, dsqs: 0, dnss: 0,
      bestSeasonWins: 0, bestSeasonPoles: 0,
      countries: new Set(), latestCountry: '',
      photo: '', latestTeamColor: '#666',
    });
    return driverByName.get(key);
  };
  const ensureT = (key, name) => {
    if (!teamByName.has(key)) teamByName.set(key, {
      key, name,
      wins: 0, podiums: 0, poles: 0, fastestLaps: 0,
      points: 0, championships: 0, dnfs: 0, dsqs: 0,
      latestColor: '#666', logo: '', latestCountry: '',
    });
    return teamByName.get(key);
  };

  Object.values(state.saves).forEach(save => {
    Object.values(save.seasons).forEach(season => {
      const dStandings = calcDriverStandings(season);
      const tStandings = calcTeamStandings(season);
      // aggregate per driver — key by normalised name so accent/punctuation
      // variants combine ("Sergio Pérez" ≡ "Sergio Perez"). A driver who
      // raced for Mercedes one season and Ferrari the next rolls up to one
      // career record automatically.
      dStandings.forEach(d => {
        const drv = season.drivers.find(x => x.id === d.driverId);
        if (!drv) return;
        const key = normalizeDriverName(drv.name) || drv.name.toLowerCase().trim();
        const agg = ensureD(key, drv.name);
        agg.wins += d.wins;
        agg.podiums += d.podiums;
        agg.poles += d.polePositions;
        agg.fastestLaps += d.fastestLaps;
        agg.points += d.points;
        agg.starts += d.races;
        agg.sprintWins += d.sprintWins || 0;
        agg.dnfs += d.dnfs || 0;
        agg.dsqs += d.dsqs || 0;
        agg.dnss += d.dnss || 0;
        // single-season bests (most wins / poles a driver took in one season)
        if (d.wins > agg.bestSeasonWins) agg.bestSeasonWins = d.wins;
        if (d.polePositions > agg.bestSeasonPoles) agg.bestSeasonPoles = d.polePositions;
        if (drv.country) { agg.countries.add(drv.country); agg.latestCountry = drv.country; }
        if (drv.photo) agg.photo = drv.photo;
        const drvTeam = season.teams.find(t => t.id === drv.teamId);
        if (drvTeam?.color) agg.latestTeamColor = drvTeam.color;
      });
      // aggregate per team
      tStandings.forEach(t => {
        const tm = season.teams.find(x => x.id === t.teamId);
        if (!tm) return;
        const key = tm.name.toLowerCase().trim();
        const agg = ensureT(key, tm.name);
        agg.wins += t.wins;
        agg.podiums += t.podiums;
        agg.poles += t.polePositions;
        agg.fastestLaps += t.fastestLaps;
        agg.points += t.points;
        agg.dnfs += (t.dnfs || 0);
        if (tm.color) agg.latestColor = tm.color;
        if (tm.logo) agg.logo = tm.logo;
        if (tm.country) agg.latestCountry = tm.country;
      });
      // A world champion is only crowned when the season is FULLY finished — every
      // round completed. Mid-season leaders are not recorded as champions.
      const seasonFinished = (season.races || []).length > 0 && season.races.every(r => r.completed);
      if (seasonFinished) {
        if (dStandings.length) {
          // skip champ-DSQd
          const winner = dStandings.find(d => !d.championshipDsq);
          if (winner) {
            const champD = season.drivers.find(x => x.id === winner.driverId);
            if (champD) {
              const champKey = normalizeDriverName(champD.name) || champD.name.toLowerCase().trim();
              ensureD(champKey, champD.name).championships++;
            }
          }
        }
        if (tStandings.length) {
          const winner = tStandings.find(t => !t.championshipDsq);
          if (winner) {
            const champT = season.teams.find(x => x.id === winner.teamId);
            if (champT) ensureT(champT.name.toLowerCase().trim(), champT.name).championships++;
          }
        }
      }
    });
  });

  // convert sets to arrays
  driverByName.forEach(d => { d.countries = Array.from(d.countries); });

  return {
    drivers: Array.from(driverByName.values()),
    teams: Array.from(teamByName.values()),
  };
}

function topN(arr, key, n = 5) {
  return arr.slice().sort((a,b) => (b[key] || 0) - (a[key] || 0)).filter(x => (x[key] || 0) > 0).slice(0, n);
}

/* TRACK records — aggregates per circuit across every save and every season.
   A "track" is keyed by its country code (BHR, MIA, USA, LVG … each circuit
   gets its own code on import) so multiple GPs in one nation stay separate.
   Falls back to the normalised race name when no country code is present. */
function calcTrackRecords() {
  const tracks = new Map();

  const ensureTrack = (key, race) => {
    if (!tracks.has(key)) tracks.set(key, {
      key,
      name: shortGrandPrixName(race),
      fullName: race.name || key,
      country: race.country || '',
      circuit: race.circuit || '',
      flagImage: race.flagImage || '',
      count: 0,
      drivers: new Map(),
    });
    const t = tracks.get(key);
    if (!t.flagImage && race.flagImage) t.flagImage = race.flagImage;
    if (!t.circuit && race.circuit) t.circuit = race.circuit;
    if (!t.country && race.country) t.country = race.country;
    return t;
  };
  const ensureDrv = (track, dkey, name) => {
    if (!track.drivers.has(dkey)) track.drivers.set(dkey, {
      key: dkey, name,
      wins: 0, poles: 0, fastestLaps: 0, podiums: 0, starts: 0,
      photo: '', color: '#3a3a4a', country: '',
    });
    return track.drivers.get(dkey);
  };

  Object.values(state.saves).forEach(save => {
    Object.values(save.seasons).forEach(season => {
      season.races.forEach(race => {
        if (!race.completed) return;
        // Key per CIRCUIT, not per country — otherwise multiple GPs in one nation
        // (e.g. Miami, Las Vegas and the US Grand Prix all in 'USA') collapse into
        // a single track record. The GP name is unique per circuit and always set;
        // circuit then country back it up. Same-named GPs across seasons still merge.
        const tkey = (shortGrandPrixName(race) || '').toLowerCase().trim()
          || (race.circuit || '').toLowerCase().trim()
          || (race.country || '').toUpperCase().trim();
        if (!tkey) return;
        const track = ensureTrack(tkey, race);
        track.count++;
        // wins / podiums / starts from race results
        (race.results || []).forEach(res => {
          const drv = season.drivers.find(d => d.id === res.driverId);
          if (!drv) return;
          const dkey = normalizeDriverName(drv.name) || drv.name.toLowerCase().trim();
          const agg = ensureDrv(track, dkey, drv.name);
          if (drv.photo) agg.photo = drv.photo;
          if (drv.country) agg.country = drv.country;
          const team = season.teams.find(t => t.id === drv.teamId);
          if (team?.color) agg.color = team.color;
          if (res.dns) return;
          agg.starts++;
          if (res.dsq || res.dnf) return;
          if (res.position === 1) agg.wins++;
          if (res.position && res.position <= 3) agg.podiums++;
        });
        // pole
        if (race.poleDriverId) {
          const drv = season.drivers.find(d => d.id === race.poleDriverId);
          if (drv) {
            const dkey = normalizeDriverName(drv.name) || drv.name.toLowerCase().trim();
            const agg = ensureDrv(track, dkey, drv.name);
            agg.poles++;
            if (drv.photo) agg.photo = drv.photo;
          }
        }
        // fastest lap
        if (race.fastestLapDriverId) {
          const drv = season.drivers.find(d => d.id === race.fastestLapDriverId);
          if (drv) {
            const dkey = normalizeDriverName(drv.name) || drv.name.toLowerCase().trim();
            const agg = ensureDrv(track, dkey, drv.name);
            agg.fastestLaps++;
            if (drv.photo) agg.photo = drv.photo;
          }
        }
      });
    });
  });

  return Array.from(tracks.values())
    .map(t => ({ ...t, drivers: Array.from(t.drivers.values()) }))
    .sort((a,b) => b.count - a.count || a.name.localeCompare(b.name));
}

// Return the top scorer of `key` from a list of aggregated drivers as
// { ...driver, val } — or null when nobody has a positive total.
function leaderOf(drivers, key) {
  let best = null;
  for (const d of drivers) {
    const v = d[key] || 0;
    if (v <= 0) continue;
    if (!best || v > best.val) best = { ...d, val: v };
  }
  return best;
}

/* ---------- render: top bar ---------- */
function renderTopbar() {
  const selectors = $('#topbar-selectors');
  const actions = $('#topbar-actions');

  // selectors
  const saves = Object.values(state.saves).sort((a,b) => b.updatedAt - a.updatedAt);
  let sel = '';
  if (saves.length) {
    sel += `
      <div class="selector">
        <span class="selector-label">SAVE FILE</span>
        <select id="save-select">
          <option value="">— Garage —</option>
          ${saves.map(s => `<option value="${s.id}" ${s.id === state.activeSaveId ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
        </select>
      </div>`;
    if (state.activeSaveId) {
      const seasons = Object.values(activeSave().seasons || {}).sort((a,b) => b.year - a.year);
      sel += `
        <div class="selector">
          <span class="selector-label">SEASON</span>
          <select id="season-select">
            <option value="">— Season Hub —</option>
            ${seasons.map(s => `<option value="${s.id}" ${s.id === state.activeSeasonId ? 'selected' : ''}>${esc(s.year)} · ${esc(s.name)}</option>`).join('')}
          </select>
        </div>`;
    }
  }
  selectors.innerHTML = sel;

  if ($('#save-select')) $('#save-select').onchange = (e) => {
    const v = e.target.value;
    state.activeSaveId = v || null;
    state.activeSeasonId = null;
    state.view = v ? 'home-save' : 'home';
    saveState(); renderAll();
  };
  if ($('#season-select')) $('#season-select').onchange = (e) => {
    const v = e.target.value;
    state.activeSeasonId = v || null;
    state.view = v ? 'dashboard' : 'home-save';
    saveState(); renderAll();
  };

  // actions
  let act = `<span id="presence-slot" class="presence-slot"></span>`;
  if (CLOUD.enabled && currentUser) act += `<span id="cloud-sync-slot"></span>`;
  act += `<button class="btn btn-ghost btn-sm" id="btn-export">⇣ EXPORT</button>
          <button class="btn btn-ghost btn-sm" id="btn-import">⇡ IMPORT</button>`;
  if (state.activeSeasonId) {
    act += `<button class="btn btn-ghost btn-sm" id="btn-export-csv" title="Export this season as a re-importable CSV with exact points">⇣ CSV</button>`;
  }
  if (CLOUD.enabled && currentUser && state.activeSaveId) {
    act += `<button class="btn btn-ghost btn-sm" id="btn-share" title="Invite a collaborator">✦ SHARE</button>`;
  }
  if (state.activeSaveId && !state.activeSeasonId) {
    act += `<button class="btn btn-primary btn-sm" id="btn-new-season">+ NEW SEASON</button>`;
  }
  if (!state.activeSaveId) {
    act += `<button class="btn btn-primary btn-sm" id="btn-new-save">+ NEW SAVE</button>`;
  }
  if (CLOUD.enabled && currentUser) {
    act += `<button class="btn btn-ghost btn-sm" id="btn-account" title="${esc(currentUser.email)}">${esc(currentUser.email.split('@')[0])} ▾</button>`;
  }
  if (!currentUser && isGuest()) {
    act += `<button class="btn btn-ghost btn-sm" id="btn-guest" title="Local-only guest mode — click to sign in instead">GUEST ▾</button>`;
  }
  actions.innerHTML = act;

  renderCloudSyncBadge();
  $('#btn-export') && ($('#btn-export').onclick = exportData);
  $('#btn-import') && ($('#btn-import').onclick = importData);
  $('#btn-export-csv') && ($('#btn-export-csv').onclick = () => exportSeasonCSV(state.activeSeasonId));
  $('#btn-new-save') && ($('#btn-new-save').onclick = openNewSaveModal);
  $('#btn-new-season') && ($('#btn-new-season').onclick = openNewSeasonModal);
  $('#btn-share') && ($('#btn-share').onclick = openShareModal);
  $('#btn-account') && ($('#btn-account').onclick = openAccountModal);
  $('#btn-guest') && ($('#btn-guest').onclick = () => {
    if (confirm('Leave guest mode and go to the sign-in screen? Your local data stays on this device.')) exitGuestMode();
  });
}

/* ---------- render: tabs ---------- */
function renderTabs() {
  const tabs = $('#tabs');
  if (!state.activeSeasonId) { tabs.innerHTML = ''; return; }
  const items = [
    { id: 'dashboard', label: 'Dashboard', n: '01' },
    { id: 'drivers',   label: 'Drivers',   n: '02' },
    { id: 'teams',     label: 'Constructors', n: '03' },
    { id: 'calendar',  label: 'Calendar',  n: '04' },
    { id: 'standings', label: 'Standings', n: '05' },
    { id: 'stats',     label: 'Stats',     n: '06' },
    { id: 'records',   label: 'Records',   n: '07' },
  ];
  tabs.innerHTML = items.map(t => `
    <button class="tab ${state.view === t.id ? 'active' : ''}" data-tab="${t.id}">
      <span class="tab-num">${t.n}</span>
      <span>${t.label}</span>
    </button>`).join('');
  $$('.tab', tabs).forEach(b => b.onclick = () => {
    state.view = b.dataset.tab;
    state.raceId = null;
    saveState(); renderAll();
  });
}

/* ---------- render: main ---------- */
function renderMain() {
  const root = $('#app');
  if (!state.activeSaveId) return root.innerHTML = '', root.appendChild(renderHome());
  if (!state.activeSeasonId) return root.innerHTML = '', root.appendChild(renderHomeSave());
  switch (state.view) {
    case 'dashboard': return root.innerHTML = '', root.appendChild(renderDashboard());
    case 'drivers':   return root.innerHTML = '', root.appendChild(renderDrivers());
    case 'teams':     return root.innerHTML = '', root.appendChild(renderTeams());
    case 'calendar':  return root.innerHTML = '', root.appendChild(renderCalendar());
    case 'standings': return root.innerHTML = '', root.appendChild(renderStandings());
    case 'stats':     return root.innerHTML = '', root.appendChild(renderStats());
    case 'records':   return root.innerHTML = '', root.appendChild(renderRecords());
    case 'race':      return root.innerHTML = '', root.appendChild(renderRace());
    default: state.view = 'dashboard'; return renderMain();
  }
}

/* ---------- views: HOME (no save selected) ---------- */
function renderHome() {
  const wrap = document.createElement('div');
  wrap.className = 'home';
  const saves = Object.values(state.saves).sort((a,b) => b.updatedAt - a.updatedAt);
  wrap.innerHTML = `
    <div class="home-hero">
      <div class="eyebrow">EST. LIGHTS-OUT · BUILD YOUR OWN MOTORSPORT UNIVERSE</div>
      <h1>The grid<span class="red">.</span><span class="italic">your way</span></h1>
      <p class="lede">Forge teams. Sign drivers. Hand-craft a calendar from Suzuka to São Paulo. Run an entire season — or a decade of them — and let P1 keep the records.</p>
      <div class="pillars">
        <div class="pillar"><div class="pillar-num">// 01</div><h3>Save Files</h3><p>Run multiple parallel universes. Each save holds an unlimited stack of seasons.</p></div>
        <div class="pillar"><div class="pillar-num">// 02</div><h3>Records Wall</h3><p>Every win, podium and championship aggregated across every save you've ever run.</p></div>
        <div class="pillar"><div class="pillar-num">// 03</div><h3>Real Points</h3><p>Modern F1 scoring. Sprint races. Pole position. Fastest lap bonus. The works.</p></div>
        <div class="pillar"><div class="pillar-num">// 04</div><h3>Telemetry UI</h3><p>Editorial-grade design. Pit-wall readouts. No spreadsheets.</p></div>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-primary" id="home-create">+ NEW SAVE FILE</button>
        ${saves.length ? '' : '<button class="btn btn-ghost" id="home-quickstart">QUICKSTART · DEMO 2026</button>'}
      </div>
    </div>
    <aside class="home-saves">
      <div class="home-saves-head">
        <h2>The Garage</h2>
        <span class="tag">${saves.length} SAVE${saves.length === 1 ? '' : 'S'}</span>
      </div>
      ${saves.length ? `
        <div class="save-list">
          ${saves.map(s => {
            const seasonCount = Object.keys(s.seasons || {}).length;
            const raceCount = Object.values(s.seasons || {}).reduce((acc, sn) => acc + (sn.races?.length || 0), 0);
            return `
            <div class="save-card" data-save="${s.id}">
              <div>
                <div class="save-card-id">// ${s.id.slice(0,4).toUpperCase()}</div>
              </div>
              <div>
                <div class="save-card-name">${esc(s.name)}</div>
                <div class="save-card-meta">CREATED ${fmtDate(s.createdAt)} · UPDATED ${fmtDate(s.updatedAt)}</div>
              </div>
              <div class="save-card-stats">
                <div class="save-stat"><span class="save-stat-num">${seasonCount}</span><span class="save-stat-lbl">SEASONS</span></div>
                <div class="save-stat"><span class="save-stat-num">${raceCount}</span><span class="save-stat-lbl">RACES</span></div>
              </div>
            </div>`;
          }).join('')}
        </div>` : `
        <div class="empty-state">
          <div class="empty-state-icon">∅</div>
          <p style="margin-top:8px">No save files yet. Create your first save to begin.</p>
        </div>`}
    </aside>`;

  setTimeout(() => {
    $('#home-create')?.addEventListener('click', openNewSaveModal);
    $('#home-quickstart')?.addEventListener('click', () => {
      createSave('My First Universe');
      createSeason({ year: new Date().getFullYear(), name: 'Inaugural Season', withPresetTeams: true, withPresetCalendar: true, withPresetDrivers: true });
      renderAll();
      toast('Demo save created — 10 teams, 20 drivers, 22 races', 'success');
    });
    $$('.save-card', wrap).forEach(c => c.onclick = () => {
      state.activeSaveId = c.dataset.save;
      state.activeSeasonId = null;
      state.view = 'home-save';
      saveState(); renderAll();
    });
  }, 0);
  return wrap;
}

/* ---------- view: HOME inside a save (season selector) ---------- */
function renderHomeSave() {
  const save = activeSave();
  const seasons = Object.values(save.seasons || {}).sort((a,b) => b.year - a.year);
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div class="f1-results-head" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px">
      <div class="f1-round-strip">
        <span class="f1-round-pill">SAVE</span>
        <span class="f1-round-meta">${esc(save.id.slice(0,6).toUpperCase())}</span>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-ghost" id="open-templates">★ TEMPLATES</button>
        <button class="btn btn-ghost" id="rename-save">RENAME</button>
        <button class="btn btn-danger" id="delete-save">DELETE SAVE</button>
        <button class="btn btn-primary" id="new-season">+ NEW SEASON</button>
      </div>
    </div>

    <h1 class="f1-page-title">${esc(save.name)}</h1>

    <div style="height:1px;background:var(--border);margin-bottom:24px"></div>

    ${seasons.length ? `
      <div class="grid-cards">
        ${seasons.map(s => {
          const completed = (s.races || []).filter(r => r.completed).length;
          const total = (s.races || []).length || 0;
          const pct = total ? Math.round(completed / total * 100) : 0;
          const champ = pct === 100 && total > 0 ? calcDriverStandings(s)[0] : null;
          const champName = champ ? driverName(s, champ.driverId) : null;
          const status = total === 0 ? 'EMPTY' : pct === 100 ? 'COMPLETE' : pct === 0 ? 'NOT STARTED' : 'IN PROGRESS';
          const statusColor = pct === 100 ? 'var(--gold)' : pct > 0 ? 'var(--sec-yellow)' : 'var(--text-muted)';
          return `
            <div class="card season-card" style="position:relative" data-season="${s.id}">
              <div class="eyebrow">${esc(s.year)} · <span style="color:${statusColor}">${status}</span></div>
              <h3 style="font-family:var(--f-display);font-weight:900;font-size:32px;letter-spacing:0.02em;text-transform:uppercase;line-height:0.95">${esc(s.name)}</h3>
              <div style="margin-top:16px;display:flex;gap:16px">
                <div><div style="font-family:var(--f-display);font-weight:800;font-size:24px">${s.drivers.length}</div><div style="font-family:var(--f-mono);font-size:9px;letter-spacing:0.2em;color:var(--text-muted)">DRIVERS</div></div>
                <div><div style="font-family:var(--f-display);font-weight:800;font-size:24px">${s.teams.length}</div><div style="font-family:var(--f-mono);font-size:9px;letter-spacing:0.2em;color:var(--text-muted)">TEAMS</div></div>
                <div><div style="font-family:var(--f-display);font-weight:800;font-size:24px">${completed}/${total}</div><div style="font-family:var(--f-mono);font-size:9px;letter-spacing:0.2em;color:var(--text-muted)">RACES</div></div>
              </div>
              <div style="margin-top:14px" class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
              ${champName ? `<div style="margin-top:14px;padding-top:14px;border-top:1px solid var(--border);font-family:var(--f-serif);font-style:italic;font-size:14px;color:var(--gold)">★ Champion: ${esc(champName)}</div>` : ''}
              <div style="margin-top:16px;display:flex;gap:8px">
                <button class="btn btn-primary" data-view-season="${s.id}" style="flex:1">▶ VIEW SEASON</button>
                <button class="btn btn-ghost" data-del-season="${s.id}" title="Delete season" style="width:38px;padding:0">✕</button>
              </div>
            </div>`;
        }).join('')}
      </div>` : `
      <div class="empty">
        <div class="empty-headline">NO SEASONS YET</div>
        <div class="empty-sub">Every great saga has a starting grid. Create the first season for ${esc(save.name)}.</div>
        <button class="btn btn-primary" id="empty-new-season">+ CREATE FIRST SEASON</button>
      </div>`}
  `;
  setTimeout(() => {
    $('#rename-save', wrap).onclick = () => openRenameSaveModal();
    $('#open-templates', wrap)?.addEventListener('click', openSeasonTemplatesModal);
    $('#delete-save', wrap).onclick = () => {
      confirmModal({
        title: 'Delete save?',
        message: `This will permanently delete <b>${esc(save.name)}</b> and all of its seasons. This cannot be undone.`,
        danger: true,
        onConfirm: () => { deleteSave(save.id); toast('Save deleted', 'warn'); renderAll(); }
      });
    };
    $('#new-season', wrap).onclick = openNewSeasonModal;
    $('#empty-new-season', wrap)?.addEventListener('click', openNewSeasonModal);
    $$('[data-view-season]', wrap).forEach(b => b.onclick = (e) => {
      e.stopPropagation();
      state.activeSeasonId = b.dataset.viewSeason;
      state.view = 'dashboard';
      saveState(); renderAll();
    });
    $$('[data-del-season]', wrap).forEach(b => b.onclick = (e) => {
      e.stopPropagation();
      const sid = b.dataset.delSeason;
      const sn = save.seasons[sid];
      confirmModal({
        title: 'Delete season?',
        message: `This will permanently delete <b>${esc(sn.year)} · ${esc(sn.name)}</b>.`,
        danger: true,
        onConfirm: () => { deleteSeason(sid); toast('Season deleted', 'warn'); renderAll(); }
      });
    });
  }, 0);
  return wrap;
}

/* ---------- view: DASHBOARD ---------- */
function renderDashboard() {
  const season = activeSeason();
  const wrap = document.createElement('div');
  const dStand = calcDriverStandings(season);
  const tStand = calcTeamStandings(season);
  const completed = season.races.filter(r => r.completed).length;
  const total = season.races.length;
  const pct = total ? Math.round(completed / total * 100) : 0;
  const next = season.races.find(r => !r.completed);
  const dLeader = dStand[0];
  const tLeader = tStand[0];

  wrap.innerHTML = `
    <div class="dash-hero">
      <div class="dash-hero-main">
        <div class="eyebrow">SEASON ${esc(season.year)} · IN PROGRESS</div>
        <div class="dash-hero-year">${esc(String(season.year))}<span class="slash">/</span></div>
        <div class="dash-hero-name">${esc(season.name)}</div>
        <div class="points-system-tag">PTS · ${esc(getPointsSystem(season.pointsSystemId).short)}</div>
        <div class="dash-hero-progress">
          <div class="progress-pct">${pct}<span class="small">%</span></div>
          <div style="flex:1">
            <div style="font-family:var(--f-mono);font-size:10px;letter-spacing:0.2em;color:var(--text-muted);text-transform:uppercase;margin-bottom:6px">${completed} OF ${total} ROUNDS COMPLETE</div>
            <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
          </div>
          <button class="btn btn-ghost btn-sm" id="dash-template">★ TEMPLATES</button>
          <button class="btn btn-ghost btn-sm" id="dash-settings">⚙ SETTINGS</button>
        </div>
      </div>
      <div class="dash-stats">
        <div class="dash-stat-card leader">
          <div class="dash-stat-context">DRIVERS' CHAMPIONSHIP LEADER</div>
          ${(() => {
            if (!dLeader) return `<div><div class="dash-stat-num">—</div><div class="dash-stat-name">No data yet</div></div>`;
            const drv = season.drivers.find(d => d.id === dLeader.driverId);
            const tc = drv ? teamColor(season, drv.teamId) : '#666';
            const portrait = drv?.photo
              ? `<div class="dash-leader-portrait" style="background-image:url('${esc(drv.photo)}');border-color:${tc}"></div>`
              : `<div class="dash-leader-portrait" style="border-color:${tc};color:${tc}"></div>`;
            return `<div class="dash-leader-row">
              ${portrait}
              <div>
                <div class="dash-stat-num">${dLeader.points}</div>
                <div class="dash-stat-name">${esc(driverName(season, dLeader.driverId))}</div>
              </div>
            </div>`;
          })()}
        </div>
        <div class="dash-stat-card leader">
          <div class="dash-stat-context">CONSTRUCTORS' LEADER</div>
          ${(() => {
            if (!tLeader) return `<div><div class="dash-stat-num">—</div><div class="dash-stat-name">No data yet</div></div>`;
            const t = season.teams.find(x => x.id === tLeader.teamId);
            const tc = t?.color || '#666';
            const mark = t?.logo
              ? `<div class="dash-leader-portrait" style="background-image:url('${esc(t.logo)}');border-color:${tc}"></div>`
              : `<div class="dash-leader-portrait" style="border-color:${tc};color:${tc}">${esc((t?.short || t?.name || '?').slice(0,3).toUpperCase())}</div>`;
            return `<div class="dash-leader-row">
              ${mark}
              <div>
                <div class="dash-stat-num">${tLeader.points}</div>
                <div class="dash-stat-name">${esc(teamName(season, tLeader.teamId))}</div>
              </div>
            </div>`;
          })()}
        </div>
      </div>
    </div>

    <div class="dash-grid">
      <div class="dash-block">
        <div class="dash-block-head">
          <div class="dash-block-title">Next on Grid</div>
          <a class="dash-block-link" data-goto="calendar">FULL CALENDAR →</a>
        </div>
        ${next ? `
          <div class="next-race-card" data-race="${next.id}" style="cursor:pointer">
            <div class="next-race-flag">▸ ROUND ${next.round} · ${esc(next.country)}</div>
            <div class="next-race-name">${esc(next.name)}</div>
            <div class="next-race-circuit">${esc(next.circuit || '—')}</div>
            <div class="next-race-meta">
              <div class="next-race-meta-item"><div class="lbl">FORMAT</div><div class="val">${next.sprint ? 'SPRINT' : 'STANDARD'}</div></div>
              <div class="next-race-meta-item"><div class="lbl">ENTRIES</div><div class="val">${season.drivers.length}</div></div>
            </div>
          </div>` : `
          <div class="empty-state"><div class="empty-state-icon">▣</div><p style="margin-top:8px">All races completed. Add another round, or open the next chapter.</p></div>`}
      </div>
      <div class="dash-block">
        <div class="dash-block-head">
          <div class="dash-block-title">Top Five — Drivers</div>
          <a class="dash-block-link" data-goto="standings">FULL TABLE →</a>
        </div>
        ${dStand.length ? `
          <table class="standings-table">
            <thead><tr><th></th><th></th><th>Driver</th><th class="num">PTS</th><th class="num">W</th></tr></thead>
            <tbody>
              ${dStand.slice(0,5).map((row, i) => {
                const drv = season.drivers.find(d => d.id === row.driverId);
                if (!drv) return '';
                const color = teamColor(season, drv.teamId);
                const team = season.teams.find(t => t.id === drv.teamId);
                const photo = drv.photo
                  ? `<div class="standings-portrait" style="--team-color:${color};background-image:url('${esc(drv.photo)}')"></div>`
                  : `<div class="standings-portrait" style="--team-color:${color}"></div>`;
                const teamMark = team?.logo
                  ? `<span class="team-logo small" style="background-image:url('${esc(team.logo)}');border-color:${color}"></span>`
                  : `<span class="team-dot" style="--team-color:${color}"></span>`;
                return `<tr class="standings-row p${i+1}">
                  <td class="pos-cell">${i+1}</td>
                  <td>${photo}</td>
                  <td>
                    <div class="driver-cell">
                      <span class="driver-cell-num" style="--driver-color:${color};color:${color}">${drv.number}</span>
                      <div>
                        <div class="driver-cell-name">${esc(drv.name)}</div>
                        <div class="driver-cell-team">${teamMark} ${esc(teamName(season, drv.teamId))}</div>
                      </div>
                    </div>
                  </td>
                  <td class="points-cell">${row.points}</td>
                  <td class="num">${row.wins}</td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>` : `<div class="empty-state"><p>No drivers yet. Head to the Drivers tab to add some.</p></div>`}
      </div>
    </div>

    <div class="dash-grid">
      <div class="dash-block">
        <div class="dash-block-head">
          <div class="dash-block-title">Latest Result</div>
        </div>
        ${(() => {
          const lastDone = [...season.races].reverse().find(r => r.completed);
          if (!lastDone) return `<div class="empty-state"><p>No races completed yet.</p></div>`;
          const podium = (lastDone.results || []).slice().sort((a,b) => (a.position||999) - (b.position||999)).slice(0,3);
          return `
            <div class="next-race-card">
              <div class="next-race-flag">✓ ROUND ${lastDone.round} · COMPLETED</div>
              <div class="next-race-name">${esc(lastDone.name)}</div>
              <div class="next-race-circuit">${esc(lastDone.circuit || '')}</div>
              <div class="podium" style="margin-top:20px">
                ${[1,0,2].map(idx => {
                  const r = podium[idx];
                  if (!r) return '<div></div>';
                  const drv = season.drivers.find(d => d.id === r.driverId);
                  if (!drv) return '<div></div>';
                  const color = teamColor(season, drv.teamId);
                  const portrait = drv.photo
                    ? `<div class="podium-portrait" style="color:${color};background-image:url('${esc(drv.photo)}')"></div>`
                    : `<div class="podium-portrait" style="color:${color}"></div>`;
                  return `<div class="podium-step p${r.position}">
                    ${portrait}
                    <div class="podium-pos">${r.position}</div>
                    <div class="podium-name">${esc(drv.name)}</div>
                    <div class="podium-team">${esc(teamShort(season, drv.teamId))}</div>
                  </div>`;
                }).join('')}
              </div>
            </div>`;
        })()}
      </div>
      <div class="dash-block">
        <div class="dash-block-head"><div class="dash-block-title">Top Five — Constructors</div><a class="dash-block-link" data-goto="standings">FULL TABLE →</a></div>
        ${tStand.length ? `
          <table class="standings-table">
            <thead><tr><th></th><th></th><th>Constructor</th><th class="num">PTS</th><th class="num">W</th></tr></thead>
            <tbody>
              ${tStand.slice(0,5).map((row, i) => {
                const t = season.teams.find(x => x.id === row.teamId); if (!t) return '';
                const teamMark = t.logo
                  ? `<div class="standings-portrait" style="--team-color:${t.color};background-image:url('${esc(t.logo)}')"></div>`
                  : `<div class="standings-portrait" style="--team-color:${t.color}">${esc((t.short || t.name).slice(0,3).toUpperCase())}</div>`;
                return `<tr class="standings-row p${i+1}">
                  <td class="pos-cell">${i+1}</td>
                  <td>${teamMark}</td>
                  <td><div class="driver-cell"><div><div class="driver-cell-name">${esc(t.name)}</div><div class="driver-cell-team">${esc(t.short || '')} · ${flagAndCode(t.country)}</div></div></div></td>
                  <td class="points-cell">${row.points}</td>
                  <td class="num">${row.wins}</td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>` : `<div class="empty-state"><p>No constructors yet.</p></div>`}
      </div>
    </div>
  `;

  setTimeout(() => {
    $$('[data-goto]', wrap).forEach(a => a.onclick = (e) => { e.preventDefault(); state.view = a.dataset.goto; renderAll(); });
    $$('[data-race]', wrap).forEach(a => a.onclick = () => { state.view = 'race'; state.raceId = a.dataset.race; renderAll(); });
    $('#dash-settings', wrap)?.addEventListener('click', openSeasonSettings);
    $('#dash-template', wrap)?.addEventListener('click', openSeasonTemplatesModal);
  }, 0);
  return wrap;
}

/* ---------- view: DRIVERS ---------- */
function renderDrivers() {
  const season = activeSeason();
  const wrap = document.createElement('div');
  const standings = calcDriverStandings(season);
  const ptsMap = Object.fromEntries(standings.map(s => [s.driverId, s]));

  wrap.innerHTML = `
    <div class="f1-results-head" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px">
      <div class="f1-round-strip">
        <span class="f1-round-pill">${esc(String(season.year))}</span>
        <span class="f1-round-meta">${season.drivers.length} ENTRIES</span>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-ghost" id="open-driver-classes">★ ROSTER BUNDLES</button>
        <button class="btn btn-ghost" id="search-presets">⌕ DRIVER PRESETS</button>
        <button class="btn btn-ghost" id="bulk-import-drivers">⇡ BULK IMPORT</button>
        <button class="btn btn-ghost" id="add-sample">+ ADD SAMPLE</button>
        <button class="btn btn-primary" id="add-driver">+ NEW DRIVER</button>
      </div>
    </div>

    <h1 class="f1-page-title">${esc(String(season.year))} <span style="font-weight:300;color:var(--text-dim)">DRIVERS</span></h1>
    ${season.drivers.length ? `
      <div class="grid-cards">
        ${season.drivers.slice().sort((a,b) => a.number - b.number).map(d => {
          const team = season.teams.find(t => t.id === d.teamId);
          const color = team?.color || '#666';
          const stats = ptsMap[d.id] || { points: 0, wins: 0, podiums: 0 };
          const { first, last } = splitName(d.name);
          const hasPhoto = !!d.photo;
          return `
            <div class="driver-card ${hasPhoto ? 'has-photo' : ''} ${d.dsq ? 'champ-dsq' : ''}" style="--team-color:${color}">
              <div class="driver-stripe"></div>
              <div class="driver-num">${d.number || '–'}</div>
              <div class="driver-card-body">
                <div class="driver-name"><span class="first">${esc(first || '')}</span>${esc(last)}</div>
                <div class="driver-team">${esc(team?.name || 'No team assigned')}</div>
                <div class="driver-stats-row">
                  <div class="driver-stat"><div class="driver-stat-num">${stats.points}</div><div class="driver-stat-lbl">PTS</div></div>
                  <div class="driver-stat"><div class="driver-stat-num">${stats.wins}</div><div class="driver-stat-lbl">WINS</div></div>
                  <div class="driver-stat"><div class="driver-stat-num">${stats.podiums}</div><div class="driver-stat-lbl">POD</div></div>
                  <div class="driver-stat"><div class="driver-stat-num">${stats.polePositions || 0}</div><div class="driver-stat-lbl">POLE</div></div>
                </div>
                <div class="driver-flag">${flagAndCode(d.country)}</div>
                ${lastEditedBadge(d)}
                <div class="driver-card-actions">
                  <button class="btn btn-sm btn-ghost btn-icon ${d.dsq ? 'active-dsq' : ''}" data-dsq-driver="${d.id}" title="${d.dsq ? 'Reinstate to championship' : 'Disqualify from championship'}">${d.dsq ? '✓' : '⊘'}</button>
                  <button class="btn btn-sm btn-ghost btn-icon" data-xfer-driver="${d.id}" title="Transfer to another season">⇄</button>
                  <button class="btn btn-sm btn-ghost btn-icon" data-edit-driver="${d.id}" title="Edit">✎</button>
                  <button class="btn btn-sm btn-danger btn-icon" data-del-driver="${d.id}" title="Delete">✕</button>
                </div>
                ${hasPhoto
                  ? `<div class="driver-photo" style="background-image:url('${esc(d.photo)}')"></div>`
                  : `<div class="driver-photo driver-photo-empty"></div>`}
              </div>
            </div>`;
        }).join('')}
      </div>
    ` : `
      <div class="empty">
        <div class="empty-headline">NO DRIVERS</div>
        <div class="empty-sub">An empty grid is no grid at all. Browse the preset library or sign your first custom driver.</div>
        <div style="display:flex;gap:8px;justify-content:center">
          <button class="btn btn-ghost" id="empty-search-presets">⌕ DRIVER PRESETS</button>
          <button class="btn btn-primary" id="empty-new-driver">+ ADD A DRIVER</button>
        </div>
      </div>`}
  `;
  setTimeout(() => {
    $('#add-driver', wrap)?.addEventListener('click', () => openDriverModal());
    $('#search-presets', wrap)?.addEventListener('click', openDriverPresetSearch);
    $('#open-driver-classes', wrap)?.addEventListener('click', () => openRosterClasses('driver'));
    $('#bulk-import-drivers', wrap)?.addEventListener('click', openBulkImportDrivers);
    $('#empty-search-presets', wrap)?.addEventListener('click', openDriverPresetSearch);
    $('#add-sample', wrap)?.addEventListener('click', () => {
      if (!season.teams.length) return toast('Create a team first', 'warn');
      const usedNums = new Set(season.drivers.map(d => d.number));
      let num = 2; while (usedNums.has(num)) num++;
      const i = season.drivers.length;
      const first = SAMPLE_FIRSTS[i % SAMPLE_FIRSTS.length];
      const last  = SAMPLE_LASTS[(i*3) % SAMPLE_LASTS.length];
      const team = season.teams[i % season.teams.length];
      addDriver({ name: `${first} ${last}`, number: num, country: SAMPLE_COUNTRIES[i % SAMPLE_COUNTRIES.length], teamId: team.id, photo: '' });
      renderMain();
      toast('Sample driver signed', 'success');
    });
    $('#empty-new-driver', wrap)?.addEventListener('click', () => openDriverModal());
    $$('[data-edit-driver]', wrap).forEach(b => b.onclick = () => openDriverModal(b.dataset.editDriver));
    $$('[data-xfer-driver]', wrap).forEach(b => b.onclick = () => openTransferDriverModal(b.dataset.xferDriver));
    $$('[data-dsq-driver]', wrap).forEach(b => b.onclick = () => {
      const drv = season.drivers.find(x => x.id === b.dataset.dsqDriver);
      const willDsq = !drv.dsq;
      confirmModal({
        title: willDsq ? 'Disqualify from championship?' : 'Reinstate to championship?',
        message: willDsq
          ? `<b>${esc(drv.name)}</b> will be excluded from championship standings. All their points will be voided. They'll still appear in race results.`
          : `<b>${esc(drv.name)}</b> will be reinstated and earn points again.`,
        danger: willDsq,
        onConfirm: () => { toggleDriverDsq(drv.id); toast(willDsq ? 'Excluded from championship' : 'Reinstated', willDsq ? 'warn' : 'success'); renderMain(); }
      });
    });
    $$('[data-del-driver]', wrap).forEach(b => b.onclick = () => {
      const d = season.drivers.find(x => x.id === b.dataset.delDriver);
      confirmModal({
        title: 'Release driver?',
        message: `Permanently remove <b>${esc(d.name)}</b> from the season? Their results will be wiped.`,
        danger: true,
        onConfirm: () => { deleteDriver(d.id); toast('Driver released', 'warn'); renderMain(); }
      });
    });
  }, 0);
  return wrap;
}

function openDriverModal(driverId) {
  const season = activeSeason();
  const editing = driverId ? season.drivers.find(d => d.id === driverId) : null;
  let photoValue = editing?.photo || '';
  const matchedPreset = editing ? matchDriverPresetForName(editing.name) : null;
  const presetPhotos = matchedPreset ? presetPhotosList(matchedPreset) : [];
  const hasPresetMatch = !!matchedPreset;
  const hasMultiPreset = presetPhotos.length > 1;
  modal({
    title: editing ? `Edit Driver` : `<span class="accent">Sign</span> a Driver`,
    body: `
      <div class="field">
        <label>Photo${hasPresetMatch ? ` <span style="font-weight:400;color:var(--text-muted);font-family:var(--f-body);text-transform:none;letter-spacing:0">— matched to <b>${esc(matchedPreset.name)}</b> preset (${presetPhotos.length} ${presetPhotos.length === 1 ? 'photo' : 'photos'})</span>` : ''}</label>
        <div id="d-photo-mount"></div>
        ${hasPresetMatch ? `
          <div style="display:flex;gap:6px;margin-top:10px;flex-wrap:wrap">
            ${presetPhotos.length ? `<button type="button" class="btn btn-ghost btn-sm" id="d-browse-preset-photos" style="flex:1;min-width:140px">📸 ${hasMultiPreset ? `PICK FROM ${presetPhotos.length} PRESET PHOTOS` : 'USE PRESET PHOTO'}</button>` : ''}
            <button type="button" class="btn btn-ghost btn-sm" id="d-sync-preset" style="flex:1;min-width:140px;border-color:var(--sec-cyan);color:var(--sec-cyan)">⟳ SYNC FROM PRESET</button>
          </div>
        ` : ''}
      </div>
      <div class="field">
        <label>Full Name</label>
        <input type="text" id="d-name" placeholder="e.g. Marco Alvarez" value="${esc(editing?.name || '')}">
      </div>
      <div class="field-row field-row-3">
        <div class="field"><label>Race Number</label><input type="number" id="d-num" min="0" max="999" value="${editing?.number ?? ''}"></div>
        <div class="field">
          <label>Country (3 letters)</label>
          <div class="country-input">
            <span class="country-flag-preview" id="d-ctry-flag">${flag(editing?.country || '')}</span>
            <input type="text" id="d-ctry" maxlength="3" placeholder="GBR" value="${esc(editing?.country || '')}" style="text-transform:uppercase">
          </div>
        </div>
        <div class="field">
          <label>Team</label>
          <select id="d-team">
            <option value="">— None —</option>
            ${season.teams.map(t => `<option value="${t.id}" ${editing?.teamId === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}
          </select>
        </div>
      </div>`,
    footer: `<button class="btn btn-ghost" data-act="cancel">Cancel</button><button class="btn btn-primary" data-act="ok">${editing ? 'Save' : 'Sign'}</button>`,
    onMount: (root, close) => {
      const placeholder = '';
      const photoWidget = mountPhotoUpload($('#d-photo-mount', root), {
        initial: photoValue,
        shape: 'circle',
        placeholder,
        onChange: (v) => { photoValue = v; }
      });
      const browseBtn = $('#d-browse-preset-photos', root);
      if (browseBtn) {
        browseBtn.onclick = () => {
          const latest = matchDriverPresetForName(editing?.name || $('#d-name', root)?.value || '');
          const latestPhotos = latest ? presetPhotosList(latest) : presetPhotos;
          if (latestPhotos.length <= 1) {
            photoValue = latestPhotos[0]?.url || '';
            photoWidget.setValue(photoValue);
            toast('Applied preset photo', 'success');
          } else {
            pickPresetPhoto(latest || matchedPreset, (url) => {
              photoValue = url || '';
              photoWidget.setValue(photoValue);
            });
          }
        };
      }
      const syncBtn = $('#d-sync-preset', root);
      if (syncBtn) {
        syncBtn.onclick = () => {
          const latest = matchDriverPresetForName(editing?.name || $('#d-name', root)?.value || '');
          if (!latest) return toast('No preset match', 'warn');
          const fields = [];
          if (latest.country) {
            $('#d-ctry', root).value = latest.country;
            $('#d-ctry-flag', root).textContent = flag(latest.country);
            fields.push('country');
          }
          if (latest.number) {
            $('#d-num', root).value = latest.number;
            fields.push('number');
          }
          const defaultPhoto = defaultPresetPhoto(latest);
          if (defaultPhoto) {
            photoValue = defaultPhoto;
            photoWidget.setValue(photoValue);
            fields.push('photo');
          }
          toast(`Synced ${fields.join(', ') || 'nothing — preset is empty'} from preset`, 'success');
        };
      }
      // Live country flag preview
      const ctryInput = $('#d-ctry', root);
      const flagEl = $('#d-ctry-flag', root);
      ctryInput.addEventListener('input', () => {
        flagEl.textContent = flag(ctryInput.value.trim().toUpperCase());
      });
      $('[data-act="cancel"]', root).onclick = close;
      $('[data-act="ok"]', root).onclick = () => {
        const name = $('#d-name', root).value.trim();
        if (!name) return toast('Driver name required', 'error');
        const number = $('#d-num', root).value;
        const country = $('#d-ctry', root).value;
        const teamId = $('#d-team', root).value || null;
        if (editing) updateDriver(editing.id, { name, number, country, teamId, photo: photoValue });
        else addDriver({ name, number, country, teamId, photo: photoValue });
        close(); renderMain(); toast(editing ? 'Driver updated' : 'Driver signed', 'success');
      };
    }
  });
}

/* ---------- view: TEAMS ---------- */
function renderTeams() {
  const season = activeSeason();
  const wrap = document.createElement('div');
  const dStand = calcDriverStandings(season);
  const ptsMap = Object.fromEntries(dStand.map(x => [x.driverId, x.points]));

  wrap.innerHTML = `
    <div class="f1-results-head" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px">
      <div class="f1-round-strip">
        <span class="f1-round-pill">${esc(String(season.year))}</span>
        <span class="f1-round-meta">${season.teams.length} TEAMS</span>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-ghost" id="open-team-classes">★ ROSTER BUNDLES</button>
        <button class="btn btn-ghost" id="search-team-presets">⌕ TEAM PRESETS</button>
        <button class="btn btn-primary" id="add-team">+ NEW CONSTRUCTOR</button>
      </div>
    </div>

    <h1 class="f1-page-title">${esc(String(season.year))} <span style="font-weight:300;color:var(--text-dim)">CONSTRUCTORS</span></h1>
    ${season.teams.length ? `
      <div class="grid-cards">
        ${season.teams.map(t => {
          const drivers = season.drivers.filter(d => d.teamId === t.id).sort((a,b) => a.number - b.number);
          const teamTotal = drivers.reduce((s, d) => s + (ptsMap[d.id] || 0), 0);
          const logoBlock = t.logo
            ? `<div class="team-card-logo" style="background-image:url('${esc(t.logo)}')"></div>`
            : `<div class="team-card-logo team-card-logo-fallback" style="border-color:${t.color};color:${t.color}">${esc((t.short || t.name || '?').slice(0,3).toUpperCase())}</div>`;
          return `
            <div class="team-card ${t.dsq ? 'champ-dsq' : ''}" style="--team-color:${t.color}">
              <div class="team-card-head">
                ${logoBlock}
                <div class="team-card-identity">
                  <h3 class="team-card-name">${esc(t.name)}</h3>
                  <div class="team-card-meta">
                    ${t.short ? `<span class="team-card-short">${esc(t.short)}</span>` : ''}
                    ${t.country ? `<span class="team-card-country">${flagImg(t.country, 16)}<span>${esc(t.country)}</span></span>` : ''}
                    ${t.dsq ? `<span class="team-card-dsq-tag">DSQ</span>` : ''}
                  </div>
                </div>
                <div class="team-card-total">
                  <span class="team-card-total-val">${teamTotal}</span>
                  <span class="team-card-total-lbl">PTS</span>
                </div>
              </div>
              ${drivers.length ? `
                <div class="team-drivers-list">
                  ${drivers.map(d => {
                    const portrait = d.photo
                      ? `<div class="team-driver-portrait" style="background-image:url('${esc(d.photo)}')"></div>`
                      : `<div class="team-driver-portrait team-driver-portrait-empty"></div>`;
                    return `<div class="team-driver-row">
                        <span class="team-driver-num">${d.number}</span>
                        ${portrait}
                        <div class="team-driver-info">
                          <span class="team-driver-name">${esc(d.name)}</span>
                          ${d.country ? `<span class="team-driver-flag">${flagImg(d.country, 14)}</span>` : ''}
                        </div>
                        <span class="team-driver-pts">${ptsMap[d.id] || 0}<span class="team-driver-pts-lbl"> PTS</span></span>
                      </div>`;
                  }).join('')}
                </div>` : `<div class="team-card-empty-roster">No drivers signed</div>`}
              ${lastEditedBadge(t)}
              <div class="team-card-actions">
                <button class="team-action-btn dsq ${t.dsq ? 'active' : ''}" data-dsq-team="${t.id}" title="${t.dsq ? 'Reinstate to championship' : 'Disqualify from championship'}">
                  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><line x1="5.5" y1="18.5" x2="18.5" y2="5.5"/></svg>
                  <span>${t.dsq ? 'REINSTATE' : 'DSQ'}</span>
                </button>
                <button class="team-action-btn edit" data-edit-team="${t.id}" title="Edit team">
                  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                  <span>EDIT</span>
                </button>
                <button class="team-action-btn delete" data-del-team="${t.id}" title="Delete team">
                  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>
                </button>
              </div>
            </div>`;
        }).join('')}
      </div>` : `
      <div class="empty">
        <div class="empty-headline">NO CONSTRUCTORS</div>
        <div class="empty-sub">Build your paddock from the ground up — or seed it with the standard ten.</div>
        <div style="display:flex;gap:8px;justify-content:center">
          <button class="btn btn-ghost" id="seed-teams">SEED 10 STANDARD TEAMS</button>
          <button class="btn btn-primary" id="empty-new-team">+ NEW CONSTRUCTOR</button>
        </div>
      </div>`}
  `;
  setTimeout(() => {
    $('#add-team', wrap)?.addEventListener('click', () => openTeamModal());
    $('#search-team-presets', wrap)?.addEventListener('click', openTeamPresetSearch);
    $('#open-team-classes', wrap)?.addEventListener('click', () => openRosterClasses('team'));
    $('#empty-new-team', wrap)?.addEventListener('click', () => openTeamModal());
    $('#seed-teams', wrap)?.addEventListener('click', () => {
      PRESET_TEAMS.forEach(t => addTeam({ name: t.name, short: t.short, color: t.color, country: t.country }));
      renderMain(); toast('Standard ten teams seeded', 'success');
    });
    $$('[data-edit-team]', wrap).forEach(b => b.onclick = () => openTeamModal(b.dataset.editTeam));
    $$('[data-dsq-team]', wrap).forEach(b => b.onclick = () => {
      const t = season.teams.find(x => x.id === b.dataset.dsqTeam);
      const willDsq = !t.dsq;
      confirmModal({
        title: willDsq ? 'Disqualify constructor from championship?' : 'Reinstate constructor?',
        message: willDsq
          ? `<b>${esc(t.name)}</b> will be excluded from championship standings — and so will their drivers. Race results stay in the books, but no points score.`
          : `<b>${esc(t.name)}</b> will be reinstated.`,
        danger: willDsq,
        onConfirm: () => { toggleTeamDsq(t.id); toast(willDsq ? 'Excluded from championship' : 'Reinstated', willDsq ? 'warn' : 'success'); renderMain(); }
      });
    });
    $$('[data-del-team]', wrap).forEach(b => b.onclick = () => {
      const t = season.teams.find(x => x.id === b.dataset.delTeam);
      confirmModal({
        title: 'Disband constructor?',
        message: `Permanently delete <b>${esc(t.name)}</b>? Drivers will become free agents.`,
        danger: true,
        onConfirm: () => { deleteTeam(t.id); toast('Team disbanded', 'warn'); renderMain(); }
      });
    });
  }, 0);
  return wrap;
}

function openTeamModal(teamId) {
  const season = activeSeason();
  const editing = teamId ? season.teams.find(t => t.id === teamId) : null;
  let logoValue = editing?.logo || '';
  modal({
    title: editing ? 'Edit Constructor' : `<span class="accent">New</span> Constructor`,
    body: `
      <div class="field">
        <label>Team Logo</label>
        <div id="t-logo-mount"></div>
      </div>
      <div class="field"><label>Team Name</label><input type="text" id="t-name" placeholder="e.g. Crimson Velocity" value="${esc(editing?.name || '')}"></div>
      <div class="field-row field-row-3">
        <div class="field"><label>Short (3-4 letters)</label><input type="text" id="t-short" maxlength="4" value="${esc(editing?.short || '')}" style="text-transform:uppercase"></div>
        <div class="field">
          <label>Country</label>
          <div class="country-input">
            <span class="country-flag-preview" id="t-ctry-flag">${flag(editing?.country || '')}</span>
            <input type="text" id="t-ctry" maxlength="3" placeholder="GBR" value="${esc(editing?.country || '')}" style="text-transform:uppercase">
          </div>
        </div>
        <div class="field"><label>Livery</label><input type="color" id="t-color" value="${editing?.color || '#dc2626'}"></div>
      </div>`,
    footer: `<button class="btn btn-ghost" data-act="cancel">Cancel</button><button class="btn btn-primary" data-act="ok">${editing ? 'Save' : 'Create'}</button>`,
    onMount: (root, close) => {
      const placeholder = editing?.short || '?';
      mountPhotoUpload($('#t-logo-mount', root), {
        initial: logoValue,
        shape: 'square',
        placeholder,
        onChange: (v) => { logoValue = v; }
      });
      // Live country flag preview
      const ctryInput = $('#t-ctry', root);
      const flagEl = $('#t-ctry-flag', root);
      ctryInput.addEventListener('input', () => {
        flagEl.textContent = flag(ctryInput.value.trim().toUpperCase());
      });
      $('[data-act="cancel"]', root).onclick = close;
      $('[data-act="ok"]', root).onclick = () => {
        const name = $('#t-name', root).value.trim();
        if (!name) return toast('Team name required', 'error');
        const short = $('#t-short', root).value;
        const country = $('#t-ctry', root).value;
        const color = $('#t-color', root).value;
        if (editing) updateTeam(editing.id, { name, short, country, color, logo: logoValue });
        else addTeam({ name, short, country, color, logo: logoValue });
        close(); renderMain(); toast(editing ? 'Team updated' : 'Team created', 'success');
      };
    }
  });
}

/* ---------- view: CALENDAR ---------- */
/* Calendar / Results — styled to match F1.com's results page:
   year tab → filter tabs (Races/Drivers/Teams) → clean borderless table */
let _calFilter = 'races'; // 'races' | 'drivers' | 'teams'

function renderCalendar() {
  const season = activeSeason();
  const wrap = document.createElement('div');
  const races = season.races.slice().sort((a,b) => a.round - b.round);
  const completedCount = races.filter(r => r.completed).length;

  // Last completed race for the R-XX label at top
  const lastCompleted = races.filter(r => r.completed).slice(-1)[0];

  // Build the inner content based on the active filter pill
  let inner = '';
  if (_calFilter === 'races') {
    const nextPendingId = races.find(r => !r.completed)?.id || null;
    inner = races.length ? `
      <div class="race-card-grid">
        ${races.map(r => {
          const winner = r.completed && r.results?.length
            ? r.results.find(x => x.position === 1)
            : null;
          const winnerDrv = winner ? season.drivers.find(d => d.id === winner.driverId) : null;
          const winnerTeam = winnerDrv ? season.teams.find(t => t.id === winnerDrv.teamId) : null;
          const teamColor = winnerTeam?.color || 'var(--red)';
          const accent = winnerTeam?.color || (r.completed ? 'var(--sec-green)' : (r.id === nextPendingId ? 'var(--red)' : 'var(--text-muted)'));
          const laps = winner ? (r.totalLaps || '—') : '—';
          // Pole + fastest-lap holders alongside the winner
          const poleDrv = r.completed && r.poleDriverId ? season.drivers.find(d => d.id === r.poleDriverId) : null;
          const flDrv = r.completed && r.fastestLapDriverId ? season.drivers.find(d => d.id === r.fastestLapDriverId) : null;
          const drvTeamColor = (drv) => season.teams.find(t => t.id === drv?.teamId)?.color || 'var(--border-hi)';
          const extraBlock = (poleDrv || flDrv) ? `
            <div class="race-card-extra">
              ${poleDrv ? `<div class="race-card-extra-item pole" style="--team-color:${drvTeamColor(poleDrv)}">
                <span class="race-card-extra-lbl">Pole</span>
                <span class="race-card-extra-name">${esc(splitName(poleDrv.name).last || poleDrv.name)}</span>
              </div>` : ''}
              ${flDrv ? `<div class="race-card-extra-item fl" style="--team-color:${drvTeamColor(flDrv)}">
                <span class="race-card-extra-lbl">Fastest Lap</span>
                <span class="race-card-extra-name">${esc(splitName(flDrv.name).last || flDrv.name)}</span>
              </div>` : ''}
            </div>` : '';
          const statusTag = r.completed
            ? '<span class="race-card-status-tag completed">DONE</span>'
            : (r.id === nextPendingId
                ? '<span class="race-card-status-tag next">NEXT</span>'
                : '<span class="race-card-status-tag upcoming">UPCOMING</span>');
          const winnerPhoto = winnerDrv
            ? (winnerDrv.photo
                ? `<div class="race-card-winner-photo" style="background-image:url('${esc(winnerDrv.photo)}')"></div>`
                : `<div class="race-card-winner-photo"></div>`)
            : '';
          const winnerBlock = r.completed && winnerDrv ? `
            <div class="race-card-winner" style="--team-color:${teamColor}">
              ${winnerPhoto}
              <div class="race-card-winner-info">
                <div class="race-card-winner-lbl">Winner · P1</div>
                <div class="race-card-winner-name">${esc(winnerDrv.name)}</div>
                <div class="race-card-winner-team">${esc(winnerTeam?.name || '')}</div>
              </div>
            </div>` : `
            <div class="race-card-pending-info">awaiting lights-out</div>`;
          const pm = racePointsMultiplier(r);
          const pmBadge = pm !== 1 ? `<span class="race-card-mult-badge ${pm === 2 ? 'dbl' : 'half'}">${pm === 2 ? '2×' : '½'}</span>` : '';
          const pmToggle = `
            <div class="race-card-mult" title="Championship points awarded for this round">
              <span class="race-card-mult-lbl">PTS</span>
              <button class="race-card-mult-btn ${pm === 1 ? 'active' : ''}" data-mult="${r.id}|1">1×</button>
              <button class="race-card-mult-btn ${pm === 0.5 ? 'active' : ''}" data-mult="${r.id}|0.5">½</button>
              <button class="race-card-mult-btn ${pm === 2 ? 'active' : ''}" data-mult="${r.id}|2">2×</button>
            </div>`;
          return `
            <div class="race-card ${r.completed ? 'completed' : 'pending'}" data-race="${r.id}" style="--accent-color:${accent}">
              <div class="race-card-head">
                <div class="race-card-round-stack">
                  <span class="race-card-round-lbl">ROUND</span>
                  <span class="race-card-round">${String(r.round).padStart(2, '0')}</span>
                </div>
                <div class="race-card-head-right">
                  ${r.sprint ? '<span class="race-card-sprint-badge">SPR</span>' : ''}
                  ${pmBadge}
                  ${statusTag}
                  <div class="race-card-flag">${raceFlagHTML(r, 26)}</div>
                </div>
              </div>
              <div class="race-card-body">
                <h3 class="race-card-name">${esc(shortGrandPrixName(r))}</h3>
                ${r.circuit ? `<div class="race-card-circuit">${esc(r.circuit)}</div>` : ''}
                ${r.completed && laps !== '—' ? `
                <div class="race-card-meta-row">
                  <div class="race-card-meta-item">
                    <span class="race-card-meta-lbl">Laps</span>
                    <span class="race-card-meta-val">${laps}</span>
                  </div>
                </div>` : ''}
                ${winnerBlock}
                ${extraBlock}
              </div>
              ${pmToggle}
              <div class="race-card-actions">
                <button class="btn btn-sm btn-ghost" data-edit-race="${r.id}" title="Edit info">✎ EDIT</button>
                <button class="btn btn-sm btn-danger btn-icon" data-del-race="${r.id}" title="Remove">✕</button>
              </div>
            </div>`;
        }).join('')}
      </div>` : `
      <div class="empty">
        <div class="empty-headline">NO ROUNDS</div>
        <div class="empty-sub">A season is just a list of weekends. Add your first one — or load a classic calendar.</div>
        <div style="display:flex;gap:8px;justify-content:center">
          <button class="btn btn-ghost" id="empty-seed-cal">LOAD CLASSIC CALENDAR</button>
          <button class="btn btn-primary" id="empty-new-race">+ NEW ROUND</button>
        </div>
      </div>`;
  } else if (_calFilter === 'drivers') {
    const stand = calcDriverStandings(season);
    if (!stand.length) {
      inner = `<div class="empty"><div class="empty-headline">NO DRIVERS</div><div class="empty-sub">Sign drivers and run a round to populate the standings.</div></div>`;
    } else {
      // Per-race results matrix — drivers as rows, races as columns, flag in column header.
      // Cell decoration mirrors broadcast-style standings sheets:
      //   • P1 → gold weight
      //   • P2/P3 → bronze/podium tone
      //   • P4–P10 → white (in points)
      //   • P11+ → muted grey (outside points)
      //   • DNF/DSQ → red
      //   • DNS → muted, italic
      //   • Pole position → small superscript "P" in blue
      //   • Fastest lap → purple underline under the position number
      //   • Sprint result (if race had a sprint) → tiny superscript with the sprint finish
      const orderedRaces = season.races.slice().sort((a, b) => a.round - b.round);

      const cellFor = (drv, race) => {
        const r = (race.results || []).find(x => x.driverId === drv.id);
        // Sprint context for this race — superscript shown next to the race result
        let sprintBadge = '';
        if (race.sprint) {
          const sr = (race.sprintResults || []).find(x => x.driverId === drv.id);
          if (sr) {
            if (sr.dns) sprintBadge = `<sup class="mx-sprint dns">DNS</sup>`;
            else if (sr.dsq) sprintBadge = `<sup class="mx-sprint dsq">DSQ</sup>`;
            else if (sr.dnf) sprintBadge = `<sup class="mx-sprint dnf">DNF</sup>`;
            else if (sr.position) {
              // sprint result number — coloured by position (gold/silver/bronze/blue)
              let scls = 'spr-out';
              if (sr.position === 1) scls = 'spr-gold';
              else if (sr.position === 2) scls = 'spr-silver';
              else if (sr.position === 3) scls = 'spr-bronze';
              else if (sr.position <= 8) scls = 'spr-pts';
              sprintBadge = `<sup class="mx-sprint ${scls}">${sr.position}</sup>`;
            }
          }
        }

        if (!r) return { html: '<span class="mx-cell mx-empty">—</span>' + sprintBadge };
        if (r.dns) return { html: `<span class="mx-cell mx-dns">DNS</span>${sprintBadge}` };
        if (r.dsq) return { html: `<span class="mx-cell mx-dsq">DSQ</span>${sprintBadge}` };
        if (r.dnf) return { html: `<span class="mx-cell mx-dnf">RET</span>${sprintBadge}` };
        if (!r.position) return { html: '<span class="mx-cell mx-empty">—</span>' + sprintBadge };

        let cls = 'mx-out';
        if (r.position === 1) cls = 'mx-gold';
        else if (r.position === 2) cls = 'mx-silver';
        else if (r.position === 3) cls = 'mx-bronze';
        else if (r.position <= 10) cls = 'mx-white';

        const isPole = race.poleDriverId === drv.id;
        const isFL = race.fastestLapDriverId === drv.id;
        const flAttr = isFL ? ' data-fl="1"' : '';
        const poleSup = isPole ? '<sup class="mx-pole">P</sup>' : '';
        return { html: `<span class="mx-cell ${cls}"${flAttr}>${r.position}${poleSup}</span>${sprintBadge}` };
      };

      inner = `
        <div class="f1-matrix-shell">
          <div class="f1-matrix-scroll">
            <table class="f1-matrix">
              <thead>
                <tr>
                  <th class="f1-matrix-rank">#</th>
                  <th class="f1-matrix-driver">DRIVER</th>
                  <th class="f1-matrix-team">TEAM</th>
                  <th class="f1-matrix-pts">PTS</th>
                  ${orderedRaces.map(r => `
                    <th class="f1-matrix-round" title="${esc(r.name)}">
                      <div class="f1-matrix-flag">${raceFlagHTML(r, 22)}</div>
                      <div class="f1-matrix-round-code">${esc(r.country || '???')}</div>
                    </th>
                  `).join('')}
                </tr>
              </thead>
              <tbody>
                ${stand.map((row, i) => {
                  const drv = season.drivers.find(d => d.id === row.driverId); if (!drv) return '';
                  const team = season.teams.find(t => t.id === drv.teamId);
                  const tc = team?.color || '#6b7280';
                  const portrait = drv.photo
                    ? `<div class="f1-portrait small" style="background-image:url('${esc(drv.photo)}');border-color:${tc}"></div>`
                    : `<div class="f1-portrait small" style="border-color:${tc};color:${tc}"></div>`;
                  const teamMark = team?.logo
                    ? `<div class="team-logo small" style="background-image:url('${esc(team.logo)}');border-color:${tc}"></div>`
                    : `<span class="team-dot" style="--team-color:${tc}"></span>`;
                  const rankCls = i === 0 ? 'crown' : i === 1 ? 'gold' : i === 2 ? 'bronze' : '';
                  const rankCell = i === 0
                    ? '<span class="f1-matrix-rank-cell crown" aria-label="Championship leader"></span>'
                    : `<span class="f1-matrix-rank-cell ${rankCls}">${i + 1}</span>`;
                  const { first, last } = splitName(drv.name);
                  return `
                    <tr class="f1-matrix-row ${i === 0 ? 'p1' : ''}" data-driver="${drv.id}" style="--team-color:${tc}">
                      <td class="f1-matrix-rank">${rankCell}</td>
                      <td class="f1-matrix-driver">
                        <div class="f1-matrix-driver-cell">
                          ${portrait}
                          <div>
                            <div class="f1-matrix-driver-name" style="color:${tc}">
                              <span class="first">${esc(first || '')}</span>
                              <span>${esc(last)}</span>
                            </div>
                            ${row.championshipDsq ? '<div class="f1-matrix-driver-meta"><span class="f1-tag dsq">CHAMP DSQ</span></div>' : ''}
                          </div>
                        </div>
                      </td>
                      <td class="f1-matrix-team">${teamMark} <span>${esc(team?.name || 'No team')}</span></td>
                      <td class="f1-matrix-pts">${row.points}</td>
                      ${orderedRaces.map(r => {
                        const c = cellFor(drv, r);
                        return `<td class="f1-matrix-cell">${c.html}</td>`;
                      }).join('')}
                    </tr>`;
                }).join('')}
              </tbody>
            </table>
          </div>
          <div class="f1-matrix-legend">
            <span><b class="mx-gold">1</b> Win</span>
            <span><b class="mx-silver">2</b> 2nd</span>
            <span><b class="mx-bronze">3</b> 3rd</span>
            <span><b class="mx-white">5</b> Points</span>
            <span><b class="mx-out">14</b> Outside points</span>
            <span><b class="mx-dnf">RET</b> Retired</span>
            <span><b style="color:var(--gold);text-decoration:underline;text-decoration-color:#c084fc;text-decoration-thickness:2px">1</b> Fastest lap</span>
            <span><b style="color:var(--text)">1<sup class="mx-pole" style="position:static">P</sup></b> Pole</span>
            <span><b style="color:var(--text)">3<sup class="mx-sprint spr-pts" style="position:static">2</sup></b> Sprint result</span>
          </div>
        </div>`;
    }
  } else { // teams
    const stand = calcTeamStandings(season);
    inner = stand.length ? `
      <div class="team-standings-shell">
        <table class="team-standings-table">
          <thead>
            <tr>
              <th class="ts-col-pos">#</th>
              <th class="ts-col-team">Constructor</th>
              <th class="ts-col-ctry">Nationality</th>
              <th class="ts-col-drvs">Line-up</th>
              <th class="ts-col-pts">Pts</th>
            </tr>
          </thead>
          <tbody>
            ${stand.map((row, i) => {
              const team = season.teams.find(t => t.id === row.teamId); if (!team) return '';
              const drivers = season.drivers.filter(d => d.teamId === team.id).sort((a, b) => a.number - b.number);
              const tc = team.color || '#6b7280';
              const logoBlock = team.logo
                ? `<div class="ts-team-logo" style="background-image:url('${esc(team.logo)}');border-color:${tc}"></div>`
                : `<div class="ts-team-logo ts-team-logo-fallback" style="border-color:${tc};color:${tc}">${esc((team.short || team.name || '?').slice(0,3).toUpperCase())}</div>`;
              const rankCls = i === 0 ? 'crown' : i === 1 ? 'silver' : i === 2 ? 'bronze' : '';
              const rankCell = i === 0
                ? '<span class="ts-rank-badge crown" aria-label="Constructors leader"></span>'
                : `<span class="ts-rank-badge ${rankCls}">${i + 1}</span>`;
              const driversBlock = drivers.length ? `
                <div class="ts-driver-stack">
                  ${drivers.map(d => {
                    const photoStyle = d.photo ? `background-image:url('${esc(d.photo)}')` : '';
                    return `<div class="ts-driver-chip" title="${esc(d.name)} · #${d.number || '–'}" style="--team-color:${tc}">
                      <div class="ts-driver-photo" style="${photoStyle}"></div>
                      <div class="ts-driver-meta">
                        <span class="ts-driver-num" style="color:${tc}">${d.number || '–'}</span>
                        <span class="ts-driver-last">${esc(splitName(d.name).last)}</span>
                      </div>
                    </div>`;
                  }).join('')}
                </div>` : '<span class="ts-drvs-empty">No drivers signed</span>';
              return `
                <tr class="team-standings-row ${row.championshipDsq ? 'is-dsq' : ''}" data-team="${team.id}" style="--team-color:${tc}">
                  <td class="ts-pos">${rankCell}</td>
                  <td class="ts-team">
                    <div class="ts-team-cell">
                      ${logoBlock}
                      <div class="ts-team-info">
                        <div class="ts-team-name">${esc(team.name)}${row.championshipDsq ? '<span class="ts-team-dsq-tag">DSQ</span>' : ''}</div>
                        ${team.short ? `<div class="ts-team-short" style="color:${tc}">${esc(team.short)}</div>` : ''}
                      </div>
                    </div>
                  </td>
                  <td class="ts-ctry">
                    ${team.country
                      ? `<span class="ts-ctry-cell">${flagImg(team.country, 22)}<span class="ts-ctry-code">${esc(team.country)}</span></span>`
                      : '<span class="ts-ctry-empty">—</span>'}
                  </td>
                  <td class="ts-drvs">${driversBlock}</td>
                  <td class="ts-pts">${row.points}</td>
                </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>` : `<div class="empty"><div class="empty-headline">NO TEAMS</div><div class="empty-sub">Add constructors via the team preset library or "+ NEW CONSTRUCTOR".</div></div>`;
  }

  wrap.innerHTML = `
    <div class="f1-results-head">
      <div class="f1-round-strip">
        ${lastCompleted
          ? `<span class="f1-round-pill">R${String(lastCompleted.round).padStart(2,'0')}</span>
             <span class="f1-round-meta">${raceFlagHTML(lastCompleted, 14)} ${esc(shortGrandPrixName(lastCompleted))}</span>`
          : `<span class="f1-round-pill upcoming">R${String((races.find(r => !r.completed)?.round) || 1).padStart(2,'0')}</span>
             <span class="f1-round-meta">NEXT ROUND</span>`}
      </div>
    </div>

    <h1 class="f1-page-title">${esc(String(season.year))} <span style="font-weight:300;color:var(--text-dim)">RACE RESULTS</span></h1>

    <div class="f1-filter-strip">
      <button class="f1-filter ${_calFilter === 'races' ? 'active' : ''}" data-filter="races">Races</button>
      <button class="f1-filter ${_calFilter === 'drivers' ? 'active' : ''}" data-filter="drivers">Drivers</button>
      <button class="f1-filter ${_calFilter === 'teams' ? 'active' : ''}" data-filter="teams">Teams</button>
      <div style="flex:1"></div>
      <span class="f1-progress-meta">${completedCount}/${races.length} RUN</span>
      ${!races.length ? '<button class="btn btn-ghost" id="seed-cal" style="margin-left:8px">LOAD CLASSIC CALENDAR</button>' : ''}
      <button class="btn btn-ghost" id="open-cal-presets" style="margin-left:8px">★ CALENDAR PRESETS</button>
      <button class="btn btn-ghost" id="search-track-presets" style="margin-left:8px">⌕ TRACK PRESETS</button>
      <button class="btn btn-primary" id="add-race" style="margin-left:8px">+ NEW ROUND</button>
    </div>

    ${inner}
  `;

  setTimeout(() => {
    $$('.f1-filter', wrap).forEach(b => b.onclick = () => {
      _calFilter = b.dataset.filter;
      renderMain();
    });
    $('#add-race', wrap)?.addEventListener('click', () => openRaceModal());
    $('#empty-new-race', wrap)?.addEventListener('click', () => openRaceModal());
    const seed = () => {
      PRESET_CALENDAR.forEach(r => addRace({ name: r.name, circuit: r.circuit, country: r.country, sprint: !!r.sprint, date: '' }));
      renderMain(); toast('Classic calendar loaded', 'success');
    };
    $('#seed-cal', wrap)?.addEventListener('click', seed);
    $('#empty-seed-cal', wrap)?.addEventListener('click', seed);
    $('#search-track-presets', wrap)?.addEventListener('click', openTrackPresetSearch);
    $('#open-cal-presets', wrap)?.addEventListener('click', openCalendarPresets);
    $$('[data-race]', wrap).forEach(row => row.onclick = (e) => {
      if (e.target.closest('[data-edit-race]') || e.target.closest('[data-del-race]') || e.target.closest('[data-mult]')) return;
      state.view = 'race'; state.raceId = row.dataset.race; renderAll();
    });
    $$('[data-mult]', wrap).forEach(b => b.onclick = (e) => {
      e.stopPropagation();
      const [raceId, val] = b.dataset.mult.split('|');
      setRacePointsMultiplier(raceId, val);
      renderMain();
    });
    $$('[data-edit-race]', wrap).forEach(b => b.onclick = (e) => { e.stopPropagation(); openRaceModal(b.dataset.editRace); });
    $$('[data-del-race]', wrap).forEach(b => b.onclick = (e) => {
      e.stopPropagation();
      const r = season.races.find(x => x.id === b.dataset.delRace);
      confirmModal({
        title: 'Remove round?',
        message: `Permanently remove <b>${esc(r.name)}</b> from the calendar? Results will be wiped.`,
        danger: true,
        onConfirm: () => { deleteRace(r.id); toast('Round removed', 'warn'); renderMain(); }
      });
    });
  }, 0);
  return wrap;
}

function openRaceModal(raceId) {
  const season = activeSeason();
  const editing = raceId ? season.races.find(r => r.id === raceId) : null;
  let flagImage = editing?.flagImage || '';

  modal({
    title: editing ? 'Edit Round' : `<span class="accent">New</span> Round`,
    body: `
      <div class="field"><label>Race Name</label><input type="text" id="r-name" placeholder="e.g. British Grand Prix" value="${esc(editing?.name || '')}"></div>
      <div class="field-row">
        <div class="field"><label>Circuit</label><input type="text" id="r-circ" placeholder="e.g. Silverstone" value="${esc(editing?.circuit || '')}"></div>
        <div class="field" style="max-width:160px"><label>Country code</label><input type="text" id="r-ctry" placeholder="GBR" maxlength="3" value="${esc(editing?.country || '')}" style="text-transform:uppercase"></div>
      </div>

      <div class="field">
        <label>Flag</label>
        <div id="r-flag-mount"></div>
        <span class="field-help">Auto-uses the country code emoji unless you upload a custom flag image (useful for fictional countries / made-up tracks).</span>
      </div>

      <div class="field">
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
          <input type="checkbox" id="r-sprint" ${editing?.sprint ? 'checked' : ''} style="width:18px;height:18px;accent-color:var(--red)">
          <span>Sprint format weekend</span>
        </label>
      </div>`,
    footer: `<button class="btn btn-ghost" data-act="cancel">Cancel</button><button class="btn btn-primary" data-act="ok">${editing ? 'Save' : 'Add Round'}</button>`,
    onMount: (root, close) => {
      // Live flag preview that updates as the country code is typed
      const renderFlagWidget = () => {
        const code = ($('#r-ctry', root)?.value || '').toUpperCase();
        const el = $('#r-flag-mount', root);
        const previewBlock = flagImage
          ? `<div class="track-flag-preview" style="background-image:url('${esc(flagImage)}')"></div>`
          : `<div class="track-flag-preview emoji">${flag(code)}</div>`;
        el.innerHTML = `
          <div class="track-flag-row">
            ${previewBlock}
            <div style="display:flex;flex-direction:column;gap:6px;flex:1">
              <label class="btn btn-ghost" style="cursor:pointer;text-align:center">
                <input type="file" accept="image/*" style="display:none">
                ${flagImage ? '↻ REPLACE FLAG IMAGE' : '↥ UPLOAD CUSTOM FLAG'}
              </label>
              ${flagImage ? '<button class="btn btn-ghost" data-clear style="color:var(--red)">× USE EMOJI INSTEAD</button>' : ''}
            </div>
          </div>`;
        el.querySelector('input[type="file"]').onchange = async (e) => {
          const f = e.target.files[0]; if (!f) return;
          try {
            const url = await fileToDataURL(f, 200);
            flagImage = url;
            renderFlagWidget();
          } catch (err) { toast('Could not load image', 'error'); }
        };
        if (el.querySelector('[data-clear]')) {
          el.querySelector('[data-clear]').onclick = () => { flagImage = ''; renderFlagWidget(); };
        }
      };
      renderFlagWidget();
      $('#r-ctry', root).oninput = () => renderFlagWidget();

      $('[data-act="cancel"]', root).onclick = close;
      $('[data-act="ok"]', root).onclick = () => {
        const name = $('#r-name', root).value.trim();
        if (!name) return toast('Race name required', 'error');
        const circuit = $('#r-circ', root).value.trim();
        const country = $('#r-ctry', root).value.trim().toUpperCase().slice(0, 3);
        const sprint = $('#r-sprint', root).checked;
        if (editing) updateRace(editing.id, { name, circuit, country, sprint, flagImage });
        else addRace({ name, circuit, country, sprint, flagImage });
        close(); renderMain(); toast(editing ? 'Round updated' : 'Round added', 'success');
      };
    }
  });
}

/* ---------- view: SINGLE RACE ---------- */
function renderRace() {
  const season = activeSeason();
  const race = season.races.find(r => r.id === state.raceId);
  if (!race) { state.view = 'calendar'; return renderCalendar(); }
  const wrap = document.createElement('div');

  const poleDrv = race.poleDriverId ? season.drivers.find(d => d.id === race.poleDriverId) : null;
  const flDrv = race.fastestLapDriverId ? season.drivers.find(d => d.id === race.fastestLapDriverId) : null;
  const heroFlagUrl = race.flagImage || flagSvgUrl(race.country);

  wrap.innerHTML = `
    <button class="race-detail-back" id="race-back">
      <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
      BACK TO CALENDAR
    </button>

    <div class="race-hero ${race.completed ? 'is-completed' : 'is-upcoming'}">
      ${heroFlagUrl ? `<div class="race-hero-bg" style="background-image:url('${esc(heroFlagUrl)}')"></div>` : ''}
      <div class="race-hero-overlay"></div>
      <div class="race-hero-content">
        <div class="race-hero-top">
          <div class="race-hero-round">
            <span class="race-hero-round-lbl">Round</span>
            <span class="race-hero-round-num">${String(race.round).padStart(2, '0')}</span>
          </div>
          <div class="race-hero-flag">${raceFlagHTML(race, 40)}</div>
        </div>
        <div class="race-hero-main">
          <div class="race-hero-status">
            <span class="race-hero-status-dot"></span>
            ${race.completed ? 'RACE COMPLETE' : 'AWAITING LIGHTS-OUT'}
            ${race.sprint ? '<span class="race-hero-sprint-tag">SPRINT</span>' : ''}
          </div>
          <h1 class="race-hero-name">${esc(race.name)}</h1>
          ${race.circuit ? `<div class="race-hero-circuit">${esc(race.circuit)}</div>` : ''}
          ${race.country ? `<div class="race-hero-country">${esc(race.country)}</div>` : ''}
        </div>
        <div class="race-hero-actions">
          ${lastEditedBadge(race)}
          <button class="btn btn-ghost" id="race-edit">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:6px;vertical-align:-2px"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            EDIT INFO
          </button>
          ${race.completed ? (
            _raceEditingResults === race.id
              ? `<button class="btn btn-ghost" id="race-cancel-edit">
                  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:6px;vertical-align:-2px"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
                  CANCEL EDIT
                </button>`
              : `<button class="btn btn-ghost" id="race-edit-results" style="border-color:var(--sec-cyan);color:var(--sec-cyan)">
                  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:6px;vertical-align:-2px"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                  EDIT RESULTS
                </button>`
          ) : ''}
          ${race.completed ? `<button class="btn btn-danger" id="race-reset">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:6px;vertical-align:-2px"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
            RESET RESULTS
          </button>` : ''}
        </div>
      </div>
    </div>

    <div class="race-stats-grid">
      <div class="race-stat ${race.sprint ? 'is-sprint' : ''}">
        <span class="race-stat-icon">${race.sprint ? '⚡' : '◐'}</span>
        <span class="race-stat-lbl">Format</span>
        <span class="race-stat-val">${race.sprint ? 'Sprint Weekend' : 'Standard'}</span>
      </div>
      <div class="race-stat">
        <span class="race-stat-icon">▦</span>
        <span class="race-stat-lbl">Entries</span>
        <span class="race-stat-val">${season.drivers.length}</span>
      </div>
      <div class="race-stat ${poleDrv ? 'has-pole' : ''}">
        <span class="race-stat-icon">P</span>
        <span class="race-stat-lbl">Pole Position</span>
        <span class="race-stat-val">${poleDrv ? esc(poleDrv.name) : '—'}</span>
      </div>
      <div class="race-stat ${flDrv ? 'has-fl' : ''}">
        <span class="race-stat-icon">⚡</span>
        <span class="race-stat-lbl">Fastest Lap</span>
        <span class="race-stat-val">${flDrv ? esc(flDrv.name) : '—'}</span>
      </div>
    </div>

    ${buildRaceTimelineHTML(race, season)}

    <div id="race-content"></div>
  `;

  setTimeout(() => {
    $('#race-back', wrap).onclick = () => {
      _raceEditingResults = null;
      state.view = 'calendar'; state.raceId = null; renderAll();
    };
    $('#race-edit', wrap).onclick = () => openRaceModal(race.id);
    $('#race-edit-results', wrap)?.addEventListener('click', () => {
      _raceEditingResults = race.id;
      _raceEditorTab = 'race';
      renderMain();
      toast('Editing results — adjust positions and save', 'success');
    });
    $('#race-cancel-edit', wrap)?.addEventListener('click', () => {
      _raceEditingResults = null;
      renderMain();
    });
    $('#race-reset', wrap)?.addEventListener('click', () => {
      confirmModal({
        title: 'Reset results?',
        message: 'Wipe all positions and stats for this race? Use <b>EDIT RESULTS</b> instead if you just want to tweak a position.',
        danger: true,
        onConfirm: () => {
          _raceEditingResults = null;
          updateRace(race.id, { results: [], sprintResults: [], fastestLapDriverId: null, poleDriverId: null, completed: false });
          toast('Results reset', 'warn'); renderMain();
        }
      });
    });

    const forceEdit = race.completed && _raceEditingResults === race.id;
    if (race.completed && !forceEdit) renderRaceReadout($('#race-content', wrap), race);
    else renderRaceEditor($('#race-content', wrap), race);
  }, 0);
  return wrap;
}

// Race editor session tab state ('quali' | 'sprint' | 'race')
let _raceEditorTab = 'race';
let _raceEditingResults = null;
const _quickEntry = { gp: true, sprint: true, quali: true };

/* The abbreviation used to match a driver in quick entry / paste import.
   Season drivers don't reliably carry `abbr` (cloud sync omits the field), so we
   fall back to the abbreviation set on the matching driver preset — i.e. the
   custom code the user configured in the preset menu. */
function driverMatchAbbr(d) {
  const own = (d.abbr || '').trim().toUpperCase();
  if (own) return own;
  const preset = matchDriverPresetForName(d.name);
  return (preset && preset.abbr ? String(preset.abbr) : '').trim().toUpperCase();
}

function resolveDriverShort(text, drivers, excludeIds = []) {
  if (!text) return { match: null };
  const t = String(text).trim().toUpperCase();
  if (!t) return { match: null };
  const pool = drivers.filter(d => !excludeIds.includes(d.id));

  if (/^\d+$/.test(t)) {
    const num = parseInt(t, 10);
    const numMatch = pool.find(d => d.number === num);
    if (numMatch) return { match: numMatch };
  }

  // User-assigned abbreviation takes priority — it's the explicit code the user
  // set to disambiguate drivers (e.g. VER resolves to Verstappen even when other
  // surnames also start with "VER").
  const abbrHits = pool.filter(d => driverMatchAbbr(d) === t);
  if (abbrHits.length === 1) return { match: abbrHits[0] };
  if (abbrHits.length > 1) return { ambiguous: abbrHits };

  if (/^[A-Z]+$/.test(t)) {
    const prefixHits = pool.filter(d => {
      const last = (d.name || '').split(/\s+/).pop().toUpperCase();
      return last.startsWith(t);
    });
    if (prefixHits.length === 1) return { match: prefixHits[0] };
    if (prefixHits.length > 1) {
      const exactLast = prefixHits.filter(d => {
        const last = (d.name || '').split(/\s+/).pop().toUpperCase();
        return last === t;
      });
      if (exactLast.length === 1) return { match: exactLast[0] };
      return { ambiguous: prefixHits };
    }
  }

  const subHits = pool.filter(d => (d.name || '').toUpperCase().includes(t));
  if (subHits.length === 1) return { match: subHits[0] };
  if (subHits.length > 1) return { ambiguous: subHits };

  return { match: null };
}

function buildQuickEntryHTML(workingArr, kind, drivers, season) {
  const MAX = Math.min(26, drivers.length);
  const posDriver = new Map();
  workingArr.forEach(w => {
    if (w.position && !w.dnf && !w.dsq && !w.dns) {
      posDriver.set(Number(w.position), w.driverId);
    }
  });
  let rows = '';
  for (let pos = 1; pos <= MAX; pos++) {
    const driverId = posDriver.get(pos);
    const drv = driverId ? drivers.find(d => d.id === driverId) : null;
    const team = drv ? season.teams.find(t => t.id === drv.teamId) : null;
    const color = team?.color || '#6b7280';
    const photo = drv && drv.photo
      ? `<div class="qe-chip-photo" style="background-image:url('${esc(drv.photo)}');border-color:${color}"></div>`
      : `<div class="qe-chip-photo" style="border-color:${color}"></div>`;
    const tierClass = pos === 1 ? 'p1' : pos === 2 ? 'p2' : pos === 3 ? 'p3' : '';
    rows += `
      <div class="qe-row ${drv ? 'filled' : ''} ${tierClass}" data-pos="${pos}" style="--team-color:${color}">
        <span class="qe-pos">P${pos}</span>
        ${drv ? `
          <div class="qe-chip">
            ${photo}
            <span class="qe-chip-num" style="color:${color}">#${drv.number || '–'}</span>
            <div class="qe-chip-text">
              <div class="qe-chip-name">${esc(drv.name)}</div>
              <div class="qe-chip-team">${esc(team?.name || 'No team')}</div>
            </div>
            <button class="qe-clear" data-pos="${pos}" title="Clear slot" aria-label="Clear">
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>
            </button>
          </div>
        ` : `
          <input class="qe-input" type="text" data-pos="${pos}" data-kind="${kind}" placeholder="Type code or # (e.g. VER, 44)" autocomplete="off" autocapitalize="characters" spellcheck="false">
          <span class="qe-hint"></span>
        `}
      </div>`;
  }
  return `<div class="quick-entry" data-kind="${kind}">${rows}</div>
    <div class="quick-entry-help">
      <span><b>3-letter code</b> (VER, HAM) · <b>last name</b> (lec…) · <b>race number</b> (1, 44) — auto-advances on unique match</span>
    </div>`;
}

function renderRaceEditor(container, race) {
  const season = activeSeason();
  // Smart default: if qualifying hasn't been done, start there. If sprint
  // exists and isn't done, go there. Otherwise the race tab.
  if (!race.poleDriverId && _raceEditorTab === 'race') _raceEditorTab = 'quali';
  if (race.poleDriverId && race.sprint && !race.sprintResults?.length && _raceEditorTab === 'race') _raceEditorTab = 'sprint';
  if (!race.sprint && _raceEditorTab === 'sprint') _raceEditorTab = 'race';

  if (!season.drivers.length) {
    container.innerHTML = `<div class="empty"><div class="empty-headline">NO DRIVERS</div><div class="empty-sub">You need at least a few drivers signed before scoring this race.</div></div>`;
    return;
  }  // race & qualifying support up to 26 slots regardless of grid count
  const MAX_POS = 26;

  // Build local working state, seeded from existing partial results
  const initial = season.drivers.map(d => {
    const ex = (race.results || []).find(x => x.driverId === d.id);
    return {
      driverId: d.id,
      position: ex?.position ?? '',
      dnf: !!ex?.dnf,
      dsq: !!ex?.dsq,
      dns: !!ex?.dns,
    };
  });
  let pole = race.poleDriverId || null;
  let fl   = race.fastestLapDriverId || null;
  let working = initial;

  // Sprint state
  let sprintWorking = race.sprint
    ? season.drivers.map(d => {
        const ex = (race.sprintResults || []).find(x => x.driverId === d.id);
        return {
          driverId: d.id,
          position: ex?.position ?? '',
          dnf: !!ex?.dnf,
          dsq: !!ex?.dsq,
          dns: !!ex?.dns,
        };
      })
    : null;

  // Qualifying state — supports up to 26 grid slots
  let qualiWorking = season.drivers.map(d => {
    const ex = (race.qualifyingResults || []).find(x => x.driverId === d.id);
    return {
      driverId: d.id,
      position: ex?.position ?? '',
      time: ex?.time || '',
    };
  });

  function rowHTML(working, key) {
    return working.map(r => {
      const drv = season.drivers.find(d => d.id === r.driverId);
      const team = season.teams.find(t => t.id === drv.teamId);
      const color = team?.color || '#666';
      const champDsq = drv.dsq || (team && team.dsq);
      const portrait = drv.photo
        ? `<div class="result-row-portrait" style="--driver-color:${color};background-image:url('${esc(drv.photo)}')"></div>`
        : `<div class="result-row-portrait" style="--driver-color:${color}"></div>`;
      return `
        <div class="result-row ${champDsq ? 'champ-dsq' : ''}" data-driver="${r.driverId}" style="grid-template-columns: 60px 44px 1fr 70px 70px 60px 60px 60px">
          <input class="result-pos-input" data-key="${key}-pos" type="number" min="1" max="${MAX_POS}" value="${r.position}" placeholder="—" ${champDsq ? 'disabled' : ''}>
          ${portrait}
          <div class="result-driver">
            <span class="driver-cell-num" style="--driver-color:${color};color:${color};font-family:var(--f-display);font-weight:700;font-size:14px;width:28px">${drv.number}</span>
            <div>
              <div class="driver-cell-name">${esc(drv.name)}${champDsq ? ' <span class="tag" style="color:var(--red);border-color:var(--red);font-size:8px">CHAMPIONSHIP DSQ</span>' : ''}</div>
              <div class="driver-cell-team">${esc(team?.name || 'No team')}</div>
            </div>
          </div>
          ${key === 'gp' ? `
            <button class="result-toggle pole ${pole === r.driverId ? 'on' : ''}" data-pole="${r.driverId}">POLE</button>
            <button class="result-toggle fl ${fl === r.driverId ? 'on' : ''}" data-fl="${r.driverId}">FL</button>
          ` : '<div></div><div></div>'}
          <button class="result-toggle dnf ${r.dnf ? 'on' : ''}" data-status="dnf" data-driver-id="${r.driverId}">DNF</button>
          <button class="result-toggle dsq ${r.dsq ? 'on' : ''}" data-status="dsq" data-driver-id="${r.driverId}" title="Disqualified — race finish stripped, no points">DSQ</button>
          <button class="result-toggle dns ${r.dns ? 'on' : ''}" data-status="dns" data-driver-id="${r.driverId}" title="Did not start — no race start counted">DNS</button>
        </div>`;
    }).join('');
  }

  function qualiRowHTML() {
    return qualiWorking.map(r => {
      const drv = season.drivers.find(d => d.id === r.driverId);
      const team = season.teams.find(t => t.id === drv.teamId);
      const color = team?.color || '#666';
      const champDsq = drv.dsq || (team && team.dsq);
      const portrait = drv.photo
        ? `<div class="quali-row-portrait" style="--driver-color:${color};background-image:url('${esc(drv.photo)}')"></div>`
        : `<div class="quali-row-portrait" style="--driver-color:${color}"></div>`;
      return `
        <div class="quali-row ${champDsq ? 'champ-dsq' : ''}" data-driver="${r.driverId}" style="grid-template-columns: 60px 44px 1fr 90px">
          <input class="result-pos-input" data-key="quali-pos" type="number" min="1" max="${MAX_POS}" value="${r.position}" placeholder="—" ${champDsq ? 'disabled' : ''}>
          ${portrait}
          <div class="result-driver">
            <span class="driver-cell-num" style="color:${color};font-family:var(--f-display);font-weight:700;font-size:14px;width:28px">${drv.number}</span>
            <div>
              <div class="driver-cell-name">${esc(drv.name)}</div>
              <div class="driver-cell-team">${esc(team?.name || 'No team')}</div>
            </div>
          </div>
          <div class="quali-time">
            <input data-key="quali-time" type="text" placeholder="1:23.456" value="${esc(r.time)}" ${champDsq ? 'disabled' : ''}>
          </div>
        </div>`;
    }).join('');
  }

  container.innerHTML = `
    <div class="race-session-tabs">
      <button class="race-session-tab ${_raceEditorTab === 'quali' ? 'active' : ''}" data-rstab="quali">
        <span class="race-session-tab-icon">⏱</span>
        <span class="race-session-tab-label">Qualifying</span>
        <span class="race-session-tab-status ${race.poleDriverId ? 'done' : ''}">${race.poleDriverId ? '✓ DONE' : 'SETUP'}</span>
      </button>
      ${race.sprint ? `
      <button class="race-session-tab ${_raceEditorTab === 'sprint' ? 'active' : ''}" data-rstab="sprint">
        <span class="race-session-tab-icon">🏁</span>
        <span class="race-session-tab-label">Sprint</span>
        <span class="race-session-tab-status ${race.sprintResults?.length ? 'done' : ''}">${race.sprintResults?.length ? '✓ DONE' : 'SETUP'}</span>
      </button>` : ''}
      <button class="race-session-tab ${_raceEditorTab === 'race' ? 'active' : ''}" data-rstab="race">
        <span class="race-session-tab-icon">🏆</span>
        <span class="race-session-tab-label">Race</span>
        <span class="race-session-tab-status ${race.completed ? 'done' : ''}">${race.completed ? '✓ DONE' : 'SETUP'}</span>
      </button>
    </div>

    <div class="race-session-panel ${_raceEditorTab === 'quali' ? '' : 'hidden'}" id="panel-quali">
      <div class="dash-block-head">
        <div class="dash-block-title">Qualifying · Saturday</div>
        <div style="display:flex;align-items:center;gap:8px">
          <div class="entry-mode-toggle" data-target="quali">
            <button class="entry-mode-btn ${_quickEntry.quali ? '' : 'active'}" data-mode="detailed">DETAILED</button>
            <button class="entry-mode-btn ${_quickEntry.quali ? 'active' : ''}" data-mode="quick">⚡ QUICK ENTRY</button>
          </div>
          <span class="tag" style="color:var(--sec-purple);border-color:var(--sec-purple)">QUALI</span>
        </div>
      </div>
      <div class="results-editor">
        <div class="results-editor-head ${_quickEntry.quali ? 'hidden' : ''}" style="grid-template-columns: 60px 44px 1fr 90px">
          <div>POS</div><div></div><div>DRIVER</div><div>BEST TIME</div>
        </div>
        <div id="quali-rows">${_quickEntry.quali ? buildQuickEntryHTML(qualiWorking, 'quali', season.drivers, season) : qualiRowHTML()}</div>
        <div class="results-editor-foot">
          <span class="results-help">${_quickEntry.quali
            ? 'Quick mode: type 3-letter codes (VER, HAM) or race numbers (1, 44) to set grid order. Lap times entered in detailed mode.'
            : `Up to ${MAX_POS} slots. Saves independently.`}</span>
          <div style="display:flex;gap:8px">
            <button class="btn btn-ghost" id="quali-import">↧ IMPORT FROM PASTE</button>
            <button class="btn btn-ghost" id="quali-pole-from-p1">↘ APPLY P1 AS RACE POLE</button>
            <button class="btn btn-primary" id="save-quali">✓ SAVE QUALIFYING</button>
          </div>
        </div>
      </div>
    </div>

    ${race.sprint ? `
    <div class="race-session-panel ${_raceEditorTab === 'sprint' ? '' : 'hidden'}" id="panel-sprint">
      <div class="dash-block-head">
        <div class="dash-block-title">Sprint Race · Saturday</div>
        <div style="display:flex;align-items:center;gap:8px">
          <div class="entry-mode-toggle" data-target="sprint">
            <button class="entry-mode-btn ${_quickEntry.sprint ? '' : 'active'}" data-mode="detailed">DETAILED</button>
            <button class="entry-mode-btn ${_quickEntry.sprint ? 'active' : ''}" data-mode="quick">⚡ QUICK ENTRY</button>
          </div>
          <span class="tag" style="color:var(--sec-yellow);border-color:var(--sec-yellow)">SPRINT</span>
        </div>
      </div>
      <div class="results-editor">
        <div class="results-editor-head ${_quickEntry.sprint ? 'hidden' : ''}" style="grid-template-columns: 60px 44px 1fr 70px 70px 60px 60px 60px">
          <div>POS</div><div></div><div>DRIVER</div><div></div><div></div><div>DNF</div><div>DSQ</div><div>DNS</div>
        </div>
        <div id="sprint-rows">${_quickEntry.sprint ? buildQuickEntryHTML(sprintWorking, 'sprint', season.drivers, season) : rowHTML(sprintWorking, 'sprint')}</div>
        <div class="results-editor-foot">
          <span class="results-help">${_quickEntry.sprint
            ? 'Quick mode: type 3-letter codes (VER, HAM) or race numbers. DNF / DSQ / DNS set in detailed mode.'
            : 'Sprint saves independently of the main race.'}</span>
          <div style="display:flex;gap:8px">
            <button class="btn btn-ghost" id="sprint-import">↧ IMPORT FROM PASTE</button>
            <button class="btn btn-primary" id="save-sprint">✓ SAVE SPRINT</button>
          </div>
        </div>
      </div>
    </div>
    ` : ''}

    <div class="race-session-panel ${_raceEditorTab === 'race' ? '' : 'hidden'}" id="panel-race">
      <div class="dash-block-head">
        <div class="dash-block-title">Grand Prix · Sunday</div>
        <div style="display:flex;align-items:center;gap:8px">
          <div class="entry-mode-toggle" data-target="gp">
            <button class="entry-mode-btn ${_quickEntry.gp ? '' : 'active'}" data-mode="detailed">DETAILED</button>
            <button class="entry-mode-btn ${_quickEntry.gp ? 'active' : ''}" data-mode="quick">⚡ QUICK ENTRY</button>
          </div>
          <span class="tag red">RACE</span>
        </div>
      </div>
      <div class="results-editor">
        <div class="results-editor-head ${_quickEntry.gp ? 'hidden' : ''}" style="grid-template-columns: 60px 44px 1fr 70px 70px 60px 60px 60px">
          <div>POS</div><div></div><div>DRIVER</div><div>POLE</div><div>FL</div><div>DNF</div><div>DSQ</div><div>DNS</div>
        </div>
        <div id="gp-rows">${_quickEntry.gp ? buildQuickEntryHTML(working, 'gp', season.drivers, season) : rowHTML(working, 'gp')}</div>
        <div class="results-editor-foot">
          <span class="results-help">${_quickEntry.gp
            ? 'Quick mode: type 3-letter codes (VER, HAM) or race numbers (1, 44). Pole / FL / DNF set in detailed mode.'
            : `Positions 1–${MAX_POS}. DNF = retired, DSQ = disqualified, DNS = did not start. POLE & FL must be unique.`}</span>
          <div style="display:flex;gap:8px">
            <button class="btn btn-ghost" id="race-import">↧ IMPORT FROM PASTE</button>
            <button class="btn btn-ghost" id="auto-fill">AUTO-FILL FROM DRIVER ORDER</button>
            <button class="btn btn-primary" id="save-results">✓ SAVE & MARK COMPLETE</button>
          </div>
        </div>
      </div>
    </div>
  `;

  // event handlers
  function bind() {
    // qualifying position inputs
    $$('[data-key="quali-pos"]', container).forEach(input => {
      input.oninput = () => {
        const row = input.closest('.quali-row');
        const did = row.dataset.driver;
        const target = qualiWorking.find(x => x.driverId === did);
        target.position = input.value === '' ? '' : Math.max(1, Math.min(MAX_POS, parseInt(input.value, 10) || ''));
      };
    });
    $$('[data-key="quali-time"]', container).forEach(input => {
      input.oninput = () => {
        const row = input.closest('.quali-row');
        const did = row.dataset.driver;
        const target = qualiWorking.find(x => x.driverId === did);
        target.time = input.value;
      };
    });
    $$('[data-key="gp-pos"]', container).forEach(input => {
      input.oninput = () => {
        const row = input.closest('.result-row');
        const did = row.dataset.driver;
        const target = working.find(x => x.driverId === did);
        target.position = input.value === '' ? '' : Math.max(1, Math.min(MAX_POS, parseInt(input.value, 10) || ''));
        if (target.position !== '') { target.dnf = false; target.dsq = false; target.dns = false; }
      };
    });
    if (sprintWorking) {
      $$('[data-key="sprint-pos"]', container).forEach(input => {
        input.oninput = () => {
          const row = input.closest('.result-row');
          const did = row.dataset.driver;
          const target = sprintWorking.find(x => x.driverId === did);
          target.position = input.value === '' ? '' : Math.max(1, Math.min(MAX_POS, parseInt(input.value, 10) || ''));
          if (target.position !== '') { target.dnf = false; target.dsq = false; target.dns = false; }
        };
      });
    }
    $$('[data-pole]', container).forEach(b => b.onclick = () => {
      const did = b.dataset.pole;
      pole = pole === did ? null : did;
      $$('[data-pole]', container).forEach(x => x.classList.toggle('on', x.dataset.pole === pole));
    });
    $$('[data-fl]', container).forEach(b => b.onclick = () => {
      const did = b.dataset.fl;
      fl = fl === did ? null : did;
      $$('[data-fl]', container).forEach(x => x.classList.toggle('on', x.dataset.fl === fl));
    });
    // status toggles (mutually exclusive: dnf/dsq/dns)
    $$('[data-status]', container).forEach(b => b.onclick = () => {
      const did = b.dataset.driverId;
      const status = b.dataset.status;
      const row = b.closest('.result-row');
      const isSprint = row.parentElement.id === 'sprint-rows';
      const arr = isSprint ? sprintWorking : working;
      const target = arr.find(x => x.driverId === did);
      // toggle this status, unset the others
      const wasOn = target[status];
      target.dnf = false; target.dsq = false; target.dns = false;
      target[status] = !wasOn;
      if (target[status]) {
        target.position = '';
        const input = row.querySelector('.result-pos-input');
        if (input) input.value = '';
      }
      // visually update all 3 buttons in the row
      ['dnf','dsq','dns'].forEach(s => {
        const btn = row.querySelector(`[data-status="${s}"]`);
        if (btn) btn.classList.toggle('on', target[s]);
      });
    });

    bindQuickEntry('gp', working);
    if (sprintWorking) bindQuickEntry('sprint', sprintWorking);
    bindQuickEntry('quali', qualiWorking);

    $$('.entry-mode-toggle', container).forEach(toggle => {
      const target = toggle.dataset.target;
      $$('.entry-mode-btn', toggle).forEach(btn => {
        btn.onclick = () => {
          _quickEntry[target] = btn.dataset.mode === 'quick';
          refreshPanel(target);
        };
      });
    });
  }

  function refreshPanel(kind) {
    const rowsContainer = kind === 'gp' ? $('#gp-rows', container)
                        : kind === 'sprint' ? $('#sprint-rows', container)
                        : kind === 'quali' ? $('#quali-rows', container)
                        : null;
    if (!rowsContainer) return;
    const arr = kind === 'gp' ? working : kind === 'sprint' ? sprintWorking : qualiWorking;
    if (_quickEntry[kind]) {
      rowsContainer.innerHTML = buildQuickEntryHTML(arr, kind, season.drivers, season);
    } else {
      rowsContainer.innerHTML = kind === 'quali' ? qualiRowHTML() : rowHTML(arr, kind);
    }
    const panelId = kind === 'gp' ? 'race' : kind;
    const panel = $(`#panel-${panelId}`, container);
    if (panel) {
      const head = panel.querySelector('.results-editor-head');
      if (head) head.classList.toggle('hidden', !!_quickEntry[kind]);
      const help = panel.querySelector('.results-help');
      if (help) {
        if (_quickEntry[kind]) {
          help.textContent = kind === 'gp'
            ? 'Quick mode: type 3-letter codes (VER, HAM) or race numbers (1, 44). Pole / FL / DNF set in detailed mode.'
            : kind === 'sprint'
              ? 'Quick mode: type 3-letter codes (VER, HAM) or race numbers. DNF / DSQ / DNS set in detailed mode.'
              : 'Quick mode: type 3-letter codes (VER, HAM) or race numbers (1, 44) to set grid order. Lap times entered in detailed mode.';
        } else {
          help.textContent = kind === 'gp'
            ? `Positions 1–${MAX_POS}. DNF = retired, DSQ = disqualified, DNS = did not start. POLE & FL must be unique.`
            : kind === 'sprint'
              ? 'Sprint saves independently of the main race.'
              : `Up to ${MAX_POS} slots. Saves independently.`;
        }
      }
      const toggle = panel.querySelector('.entry-mode-toggle');
      if (toggle) {
        $$('.entry-mode-btn', toggle).forEach(b => b.classList.toggle('active',
          (b.dataset.mode === 'quick') === !!_quickEntry[kind]));
      }
    }
    bind();
  }

  function bindQuickEntry(kind, workingArr) {
    const inputs = $$(`.quick-entry[data-kind="${kind}"] .qe-input`, container);
    const allDrivers = season.drivers;

    const focusNextEmpty = (afterPos) => {
      const all = $$(`.quick-entry[data-kind="${kind}"] .qe-input`, container);
      for (const inp of all) {
        if (Number(inp.dataset.pos) > afterPos) { inp.focus(); inp.select(); return; }
      }
    };

    const assignDriver = (pos, driverId) => {
      workingArr.forEach(w => {
        if (Number(w.position) === pos) { w.position = ''; }
      });
      const target = workingArr.find(w => w.driverId === driverId);
      if (!target) return;
      target.position = pos;
      target.dnf = false; target.dsq = false; target.dns = false;
    };

    inputs.forEach(input => {
      input.oninput = () => {
        const text = input.value;
        const hint = input.nextElementSibling;
        const excludeIds = workingArr.filter(w => w.position).map(w => w.driverId);
        const r = resolveDriverShort(text, allDrivers, excludeIds);
        if (!hint) return;
        if (r.match) {
          hint.textContent = `→ ${r.match.name}`;
          hint.className = 'qe-hint hint-ok';
          if (/^[A-Za-z]{3}$/.test(text.trim())) {
            const pos = Number(input.dataset.pos);
            assignDriver(pos, r.match.id);
            refreshPanel(kind);
            setTimeout(() => focusNextEmpty(pos), 0);
          }
        } else if (r.ambiguous) {
          hint.textContent = `${r.ambiguous.length} matches — keep typing`;
          hint.className = 'qe-hint hint-amb';
        } else if (text.trim()) {
          hint.textContent = 'No match';
          hint.className = 'qe-hint hint-err';
        } else {
          hint.textContent = '';
          hint.className = 'qe-hint';
        }
      };

      input.onkeydown = (e) => {
        if (e.key === 'Enter' || e.key === 'Tab') {
          const text = input.value;
          if (!text.trim()) return;
          e.preventDefault();
          const excludeIds = workingArr.filter(w => w.position).map(w => w.driverId);
          const r = resolveDriverShort(text, allDrivers, excludeIds);
          if (r.match) {
            const pos = Number(input.dataset.pos);
            assignDriver(pos, r.match.id);
            refreshPanel(kind);
            setTimeout(() => focusNextEmpty(pos), 0);
          } else if (r.ambiguous) {
            toast(`Ambiguous — ${r.ambiguous.length} matches: ${r.ambiguous.slice(0, 3).map(d => d.name).join(', ')}${r.ambiguous.length > 3 ? '…' : ''}`, 'warn');
          } else {
            toast('No matching driver — try last name or race number', 'error');
          }
        } else if (e.key === 'Backspace' && !input.value) {
          const pos = Number(input.dataset.pos);
          const prev = workingArr.find(w => Number(w.position) === pos - 1);
          if (prev) {
            prev.position = '';
            refreshPanel(kind);
            setTimeout(() => {
              const prevInp = $(`.quick-entry[data-kind="${kind}"] .qe-input[data-pos="${pos - 1}"]`, container);
              if (prevInp) { prevInp.focus(); prevInp.select(); }
            }, 0);
          }
        }
      };
    });

    $$(`.quick-entry[data-kind="${kind}"] .qe-clear`, container).forEach(btn => {
      btn.onclick = () => {
        const pos = Number(btn.dataset.pos);
        const target = workingArr.find(w => Number(w.position) === pos);
        if (target) { target.position = ''; target.dnf = false; target.dsq = false; target.dns = false; }
        refreshPanel(kind);
        setTimeout(() => {
          const inp = $(`.quick-entry[data-kind="${kind}"] .qe-input[data-pos="${pos}"]`, container);
          if (inp) inp.focus();
        }, 0);
      };
    });
  }

  bind();

  // Session tabs (Qualifying / Sprint / Race) — switch which panel is visible
  $$('[data-rstab]', container).forEach(btn => {
    btn.onclick = () => {
      _raceEditorTab = btn.dataset.rstab;
      // Update active styles
      $$('[data-rstab]', container).forEach(b => b.classList.toggle('active', b.dataset.rstab === _raceEditorTab));
      // Show/hide panels
      $$('.race-session-panel', container).forEach(p => p.classList.add('hidden'));
      $(`#panel-${_raceEditorTab}`, container)?.classList.remove('hidden');
    };
  });

  // Quali → Pole helper
  $('#quali-pole-from-p1', container).onclick = () => {
    const p1 = qualiWorking.find(r => Number(r.position) === 1);
    if (!p1) return toast('Set a P1 in qualifying first', 'warn');
    pole = p1.driverId;
    $$('[data-pole]', container).forEach(x => x.classList.toggle('on', x.dataset.pole === pole));
    toast('Pole assigned from qualifying P1', 'success');
  };

  $('#auto-fill', container).onclick = () => {
    let pos = 1;
    working.forEach(r => {
      const drv = season.drivers.find(d => d.id === r.driverId);
      const team = season.teams.find(t => t.id === drv.teamId);
      if (drv.dsq || (team && team.dsq)) { r.position = ''; r.dnf = false; r.dsq = false; r.dns = false; return; }
      if (r.dnf || r.dsq || r.dns) return;
      if (r.position === '') r.position = pos;
      pos = Math.max(pos, (Number(r.position) || 0)) + 1;
    });
    if (sprintWorking) {
      let sp = 1;
      sprintWorking.forEach(r => {
        const drv = season.drivers.find(d => d.id === r.driverId);
        const team = season.teams.find(t => t.id === drv.teamId);
        if (drv.dsq || (team && team.dsq)) { r.position = ''; return; }
        if (r.dnf || r.dsq || r.dns) return;
        if (r.position === '') r.position = sp;
        sp = Math.max(sp, (Number(r.position) || 0)) + 1;
      });
    }
    $('#gp-rows', container).innerHTML = rowHTML(working, 'gp');
    if (sprintWorking) $('#sprint-rows', container).innerHTML = rowHTML(sprintWorking, 'sprint');
    bind();
    toast('Filled from default order', 'success');
  };

  // SAVE QUALIFYING (independent)
  $('#save-quali', container).onclick = () => {
    const positions = qualiWorking.filter(r => r.position).map(r => Number(r.position));
    const dups = positions.filter((p, i) => positions.indexOf(p) !== i);
    if (dups.length) return toast('Duplicate quali positions: ' + [...new Set(dups)].join(', '), 'error');
    const qualiResults = qualiWorking
      .filter(r => r.position || r.time)
      .map(r => ({ driverId: r.driverId, position: r.position ? Number(r.position) : null, time: r.time || '' }));
    // P1 in qualifying automatically takes pole for the race.
    const p1 = qualiWorking.find(r => Number(r.position) === 1);
    const update = { qualifyingResults: qualiResults };
    if (p1) {
      pole = p1.driverId;
      update.poleDriverId = pole;
      $$('[data-pole]', container).forEach(x => x.classList.toggle('on', x.dataset.pole === pole));
    }
    updateRace(race.id, update);
    toast(p1 ? `Qualifying saved · pole to P1` : `Qualifying saved · ${qualiResults.length} entries`, 'success');
    saveState();
  };

  // SAVE SPRINT (independent — only when race has sprint flag)
  $('#save-sprint', container)?.addEventListener('click', () => {
    if (!sprintWorking) return;
    const positions = sprintWorking.filter(r => r.position && !r.dnf && !r.dsq && !r.dns).map(r => r.position);
    const dups = positions.filter((p, i) => positions.indexOf(p) !== i);
    if (dups.length) return toast('Duplicate sprint positions: ' + [...new Set(dups)].join(', '), 'error');
    const sprintResults = sprintWorking.map(r => ({
      driverId: r.driverId,
      position: (r.dnf || r.dsq || r.dns) ? null : (r.position || null),
      dnf: !!r.dnf, dsq: !!r.dsq, dns: !!r.dns,
    }));
    updateRace(race.id, { sprintResults });
    toast(`Sprint saved · ${positions.length} finishers`, 'success');
    saveState();
  });

  // SAVE RACE (the main save that marks the race as completed)
  $('#save-results', container).onclick = () => {
    const positions = working.filter(r => r.position && !r.dnf && !r.dsq && !r.dns).map(r => r.position);
    const dups = positions.filter((p, i) => positions.indexOf(p) !== i);
    if (dups.length) return toast('Duplicate positions: ' + [...new Set(dups)].join(', '), 'error');
    if (positions.length === 0) return toast('At least one finisher required', 'error');
    const cleaned = working.map(r => ({
      driverId: r.driverId,
      position: (r.dnf || r.dsq || r.dns) ? null : (r.position || null),
      dnf: !!r.dnf, dsq: !!r.dsq, dns: !!r.dns,
    }));
    const wasEditing = _raceEditingResults === race.id;
    updateRace(race.id, {
      results: cleaned,
      completed: true,
      fastestLapDriverId: fl,
      poleDriverId: pole,
    });
    _raceEditingResults = null;
    toast(wasEditing ? 'Race results updated' : 'Race results saved & marked complete', 'success');
    renderMain();
  };

  // IMPORT handlers
  $('#quali-import', container).onclick = () => openImportModal('qualifying', race, (parsed) => {
    parsed.forEach(p => {
      const target = qualiWorking.find(x => x.driverId === p.driverId);
      if (target) { target.position = p.position; if (p.time) target.time = p.time; }
    });
    $('#quali-rows', container).innerHTML = qualiRowHTML();
    bind();
    toast(`Filled ${parsed.length} quali rows — review then SAVE QUALIFYING`, 'success');
  });
  $('#sprint-import', container)?.addEventListener('click', () => openImportModal('sprint', race, (parsed) => {
    parsed.forEach(p => {
      const target = sprintWorking.find(x => x.driverId === p.driverId);
      if (target) {
        target.position = p.position;
        target.dnf = !!p.dnf; target.dsq = !!p.dsq; target.dns = !!p.dns;
      }
    });
    $('#sprint-rows', container).innerHTML = rowHTML(sprintWorking, 'sprint');
    bind();
    toast(`Filled ${parsed.length} sprint rows — review then SAVE SPRINT`, 'success');
  }));
  $('#race-import', container).onclick = () => openImportModal('race', race, (parsed) => {
    parsed.forEach(p => {
      const target = working.find(x => x.driverId === p.driverId);
      if (target) {
        target.position = p.position;
        target.dnf = !!p.dnf; target.dsq = !!p.dsq; target.dns = !!p.dns;
      }
    });
    $('#gp-rows', container).innerHTML = rowHTML(working, 'gp');
    bind();
    toast(`Filled ${parsed.length} race rows — review then SAVE & MARK COMPLETE`, 'success');
  });
}

let _raceReadoutTab = 'race';

function renderRaceReadout(container, race) {
  const season = activeSeason();
  const ps = getPointsSystem(season.pointsSystemId || DEFAULT_POINTS_SYSTEM_ID);

  const hasQuali  = (race.qualifyingResults || []).some(q => q && (q.position || q.time)) || !!race.poleDriverId;
  const hasSprint = !!race.sprint && (race.sprintResults || []).some(s => s && (s.position || s.dnf || s.dsq || s.dns));

  let tab = _raceReadoutTab;
  if (tab === 'sprint' && !hasSprint) tab = 'race';
  if (tab === 'quali'  && !hasQuali)  tab = 'race';

  const tabsHTML = `
    <div class="race-session-tabs" id="readout-tabs">
      <button class="race-session-tab ${tab === 'race' ? 'active' : ''}" data-rotab="race">
        <span class="race-session-tab-icon">🏆</span>
        <span class="race-session-tab-label">Race</span>
        <span class="race-session-tab-status done">✓ FINAL</span>
      </button>
      ${hasSprint ? `<button class="race-session-tab ${tab === 'sprint' ? 'active' : ''}" data-rotab="sprint">
        <span class="race-session-tab-icon">⚡</span>
        <span class="race-session-tab-label">Sprint</span>
        <span class="race-session-tab-status done">✓ DONE</span>
      </button>` : ''}
      ${hasQuali ? `<button class="race-session-tab ${tab === 'quali' ? 'active' : ''}" data-rotab="quali">
        <span class="race-session-tab-icon">⏱</span>
        <span class="race-session-tab-label">Qualifying</span>
        <span class="race-session-tab-status done">✓ DONE</span>
      </button>` : ''}
    </div>`;

  let panel = '';
  if (tab === 'race')       panel = buildRaceReadoutPanel(race, season, ps);
  else if (tab === 'sprint') panel = buildSprintReadoutPanel(race, season, ps);
  else                       panel = buildQualiReadoutPanel(race, season);

  container.innerHTML = tabsHTML + panel;

  $$('#readout-tabs .race-session-tab', container).forEach(btn => {
    btn.onclick = () => {
      _raceReadoutTab = btn.dataset.rotab;
      renderRaceReadout(container, race);
    };
  });
}

function buildRaceReadoutPanel(race, season, ps) {
  const sorted = (race.results || []).slice().sort((a,b) => {
    if (a.dns && !b.dns) return 1;
    if (b.dns && !a.dns) return -1;
    if (a.dsq && !b.dsq) return 1;
    if (b.dsq && !a.dsq) return -1;
    if (a.dnf && !b.dnf) return 1;
    if (b.dnf && !a.dnf) return -1;
    return (a.position || 999) - (b.position || 999);
  });
  const podium = sorted.filter(r => !r.dnf && !r.dsq && !r.dns).slice(0, 3);
  return `
    <div class="podium" style="max-width:620px;margin-bottom:32px">
      ${[1,0,2].map(idx => {
        const r = podium[idx];
        if (!r) return '<div></div>';
        const drv = season.drivers.find(d => d.id === r.driverId);
        if (!drv) return '<div></div>';
        const color = teamColor(season, drv.teamId);
        const portrait = drv.photo
          ? `<div class="podium-portrait" style="color:${color};background-image:url('${esc(drv.photo)}')"></div>`
          : `<div class="podium-portrait" style="color:${color}"></div>`;
        return `<div class="podium-step p${r.position}">
          ${portrait}
          <div class="podium-pos">${r.position}</div>
          <div class="podium-name">${esc(drv.name)}</div>
          <div class="podium-team">${esc(teamName(season, drv.teamId))}</div>
        </div>`;
      }).join('')}
    </div>

    <div class="results-editor">
      <div class="results-editor-head" style="grid-template-columns: 60px 44px 1fr 80px 80px 80px">
        <div>POS</div><div></div><div>DRIVER</div><div>PTS</div><div>STATUS</div><div>NOTES</div>
      </div>
      ${sorted.map(r => {
        const drv = season.drivers.find(d => d.id === r.driverId); if (!drv) return '';
        const color = teamColor(season, drv.teamId);
        let pts = 0;
        if (!r.dnf && !r.dsq && !r.dns && r.position && r.position <= ps.points.length) pts += ps.points[r.position-1];
        if (race.fastestLapDriverId === drv.id && !r.dnf && !r.dsq && !r.dns && r.position && ps.flBonus) {
          if (!ps.flRequiresTop10 || r.position <= 10) pts += ps.flBonus;
        }
        const isPole = race.poleDriverId === drv.id;
        const isFL = race.fastestLapDriverId === drv.id;
        const portrait = drv.photo
          ? `<div class="standings-portrait" style="--team-color:${color};background-image:url('${esc(drv.photo)}')"></div>`
          : `<div class="standings-portrait" style="--team-color:${color}"></div>`;
        let statusLabel = 'CLASSIFIED';
        if (r.dns) statusLabel = '<span style="color:var(--text-muted)">DNS</span>';
        else if (r.dsq) statusLabel = '<span style="color:var(--red)">DSQ</span>';
        else if (r.dnf) statusLabel = '<span style="color:var(--red)">DNF</span>';
        const isStatus = r.dns || r.dsq || r.dnf;
        const posDisplay = r.dns ? 'DNS' : r.dsq ? 'DSQ' : r.dnf ? 'DNF' : r.position;
        const posSize = isStatus ? '13px' : '22px';
        const posColor = isStatus
          ? (r.dns ? 'var(--text-muted)' : 'var(--red)')
          : (r.position === 1 ? 'var(--gold)' : r.position === 2 ? 'var(--silver)' : r.position === 3 ? 'var(--bronze)' : 'var(--text)');
        return `<div class="result-row" style="grid-template-columns: 60px 44px 1fr 80px 80px 80px;--team-color:${color}">
          <div style="font-family:var(--f-display);font-weight:800;font-size:${posSize};letter-spacing:0.05em;color:${posColor}">${posDisplay}</div>
          <div>${portrait}</div>
          <div class="result-driver">
            <span class="driver-cell-num" style="color:${color};font-family:var(--f-display);font-weight:700;width:28px">${drv.number}</span>
            <div><div class="driver-cell-name">${esc(drv.name)}</div><div class="driver-cell-team">${flagImg(drv.country, 14)} ${esc(teamName(season, drv.teamId))}</div></div>
          </div>
          <div style="font-family:var(--f-display);font-weight:800;font-size:18px;color:${pts ? color : 'var(--text-dim)'}">${pts || '—'}</div>
          <div style="font-family:var(--f-mono);font-size:11px;letter-spacing:0.1em">${statusLabel}</div>
          <div style="display:flex;gap:4px;flex-wrap:wrap">${isPole ? '<span class="tag" style="color:var(--sec-blue);border-color:var(--sec-blue);background:rgba(96,165,250,0.08)">POLE</span>' : ''}${isFL ? '<span class="tag" style="color:var(--sec-purple);border-color:var(--sec-purple);background:rgba(167,139,250,0.08)">FL</span>' : ''}</div>
        </div>`;
      }).join('')}
    </div>
  `;
}

function buildSprintReadoutPanel(race, season, ps) {
  const sorted = (race.sprintResults || []).slice().sort((a,b) => {
    if (a.dns && !b.dns) return 1;
    if (b.dns && !a.dns) return -1;
    if (a.dsq && !b.dsq) return 1;
    if (b.dsq && !a.dsq) return -1;
    if (a.dnf && !b.dnf) return 1;
    if (b.dnf && !a.dnf) return -1;
    return (a.position || 999) - (b.position || 999);
  });
  const podium = sorted.filter(r => !r.dnf && !r.dsq && !r.dns && r.position).slice(0, 3);
  const sprintPoints = ps.sprintPoints || [];
  return `
    <div class="readout-header-row">
      <span class="readout-section-tag sprint">SPRINT RACE</span>
      <span class="readout-section-sub">Top ${sprintPoints.length} score sprint points</span>
    </div>
    ${podium.length ? `
      <div class="podium" style="max-width:620px;margin-bottom:32px">
        ${[1,0,2].map(idx => {
          const r = podium[idx];
          if (!r) return '<div></div>';
          const drv = season.drivers.find(d => d.id === r.driverId);
          if (!drv) return '<div></div>';
          const color = teamColor(season, drv.teamId);
          const portrait = drv.photo
            ? `<div class="podium-portrait" style="color:${color};background-image:url('${esc(drv.photo)}')"></div>`
            : `<div class="podium-portrait" style="color:${color}"></div>`;
          return `<div class="podium-step p${r.position}">
            ${portrait}
            <div class="podium-pos">${r.position}</div>
            <div class="podium-name">${esc(drv.name)}</div>
            <div class="podium-team">${esc(teamName(season, drv.teamId))}</div>
          </div>`;
        }).join('')}
      </div>` : ''}

    <div class="results-editor">
      <div class="results-editor-head" style="grid-template-columns: 60px 44px 1fr 80px 80px">
        <div>POS</div><div></div><div>DRIVER</div><div>PTS</div><div>STATUS</div>
      </div>
      ${sorted.map(r => {
        const drv = season.drivers.find(d => d.id === r.driverId); if (!drv) return '';
        const color = teamColor(season, drv.teamId);
        let pts = 0;
        if (!r.dnf && !r.dsq && !r.dns && r.position && r.position <= sprintPoints.length) pts = sprintPoints[r.position - 1];
        const portrait = drv.photo
          ? `<div class="standings-portrait" style="--team-color:${color};background-image:url('${esc(drv.photo)}')"></div>`
          : `<div class="standings-portrait" style="--team-color:${color}"></div>`;
        let statusLabel = 'CLASSIFIED';
        if (r.dns) statusLabel = '<span style="color:var(--text-muted)">DNS</span>';
        else if (r.dsq) statusLabel = '<span style="color:var(--red)">DSQ</span>';
        else if (r.dnf) statusLabel = '<span style="color:var(--red)">DNF</span>';
        const isStatus = r.dns || r.dsq || r.dnf;
        const posDisplay = r.dns ? 'DNS' : r.dsq ? 'DSQ' : r.dnf ? 'DNF' : (r.position || '–');
        const posSize = isStatus ? '13px' : '22px';
        const posColor = isStatus
          ? (r.dns ? 'var(--text-muted)' : 'var(--red)')
          : (r.position === 1 ? 'var(--gold)' : r.position === 2 ? 'var(--silver)' : r.position === 3 ? 'var(--bronze)' : 'var(--text)');
        return `<div class="result-row" style="grid-template-columns: 60px 44px 1fr 80px 80px;--team-color:${color}">
          <div style="font-family:var(--f-display);font-weight:800;font-size:${posSize};letter-spacing:0.05em;color:${posColor}">${posDisplay}</div>
          <div>${portrait}</div>
          <div class="result-driver">
            <span class="driver-cell-num" style="color:${color};font-family:var(--f-display);font-weight:700;width:28px">${drv.number}</span>
            <div><div class="driver-cell-name">${esc(drv.name)}</div><div class="driver-cell-team">${flagImg(drv.country, 14)} ${esc(teamName(season, drv.teamId))}</div></div>
          </div>
          <div style="font-family:var(--f-display);font-weight:800;font-size:18px;color:${pts ? color : 'var(--text-dim)'}">${pts || '—'}</div>
          <div style="font-family:var(--f-mono);font-size:11px;letter-spacing:0.1em">${statusLabel}</div>
        </div>`;
      }).join('')}
    </div>
  `;
}

function buildQualiReadoutPanel(race, season) {
  const qualis = (race.qualifyingResults || []).slice().filter(q => q && (q.position || q.time));
  qualis.sort((a, b) => (a.position || 999) - (b.position || 999));
  const poleId = race.poleDriverId || qualis.find(q => q.position === 1)?.driverId;
  const poleDrv = poleId ? season.drivers.find(d => d.id === poleId) : null;
  const poleColor = poleDrv ? teamColor(season, poleDrv.teamId) : 'var(--sec-blue)';
  return `
    ${poleDrv ? `
      <div class="quali-pole-banner" style="--team-color:${poleColor}">
        ${poleDrv.photo
          ? `<div class="quali-pole-photo" style="background-image:url('${esc(poleDrv.photo)}')"></div>`
          : `<div class="quali-pole-photo"></div>`}
        <div class="quali-pole-info">
          <div class="quali-pole-lbl">Pole Position</div>
          <div class="quali-pole-name">${esc(poleDrv.name)}</div>
          <div class="quali-pole-team">${esc(teamName(season, poleDrv.teamId))} · #${poleDrv.number}</div>
        </div>
        ${qualis.find(q => q.driverId === poleDrv.id)?.time ? `
          <div class="quali-pole-time">
            <span class="quali-pole-time-lbl">Best Lap</span>
            <span class="quali-pole-time-val">${esc(qualis.find(q => q.driverId === poleDrv.id).time)}</span>
          </div>` : ''}
      </div>` : ''}

    ${qualis.length ? `
      <div class="results-editor">
        <div class="results-editor-head" style="grid-template-columns: 60px 44px 1fr 1fr">
          <div>POS</div><div></div><div>DRIVER</div><div>BEST LAP</div>
        </div>
        ${qualis.map(q => {
          const drv = season.drivers.find(d => d.id === q.driverId); if (!drv) return '';
          const color = teamColor(season, drv.teamId);
          const portrait = drv.photo
            ? `<div class="standings-portrait" style="--team-color:${color};background-image:url('${esc(drv.photo)}')"></div>`
            : `<div class="standings-portrait" style="--team-color:${color}"></div>`;
          const posColor = q.position === 1 ? 'var(--gold)'
                         : q.position === 2 ? 'var(--silver)'
                         : q.position === 3 ? 'var(--bronze)'
                         : 'var(--text)';
          return `<div class="result-row" style="grid-template-columns: 60px 44px 1fr 1fr;--team-color:${color}">
            <div style="font-family:var(--f-display);font-weight:800;font-size:22px;letter-spacing:0.05em;color:${posColor}">${q.position || '–'}</div>
            <div>${portrait}</div>
            <div class="result-driver">
              <span class="driver-cell-num" style="color:${color};font-family:var(--f-display);font-weight:700;width:28px">${drv.number}</span>
              <div><div class="driver-cell-name">${esc(drv.name)}</div><div class="driver-cell-team">${flagImg(drv.country, 14)} ${esc(teamName(season, drv.teamId))}</div></div>
            </div>
            <div style="font-family:var(--f-mono);font-weight:600;font-size:13px;color:${q.time ? 'var(--text)' : 'var(--text-dim)'}">${esc(q.time || '—')}</div>
          </div>`;
        }).join('')}
      </div>` : `<div class="empty"><div class="empty-headline">QUALIFYING NOT RECORDED</div><div class="empty-sub">Only pole position was set. Use EDIT RESULTS to fill in lap times.</div></div>`}
  `;
}

/* ---------- view: STANDINGS ---------- */
function renderStandings() {
  const season = activeSeason();
  const wrap = document.createElement('div');
  const dStand = calcDriverStandings(season);
  const tStand = calcTeamStandings(season);
  const leaderPts = dStand[0]?.points || 0;
  const tLeaderPts = tStand[0]?.points || 0;

  wrap.innerHTML = `
    <div class="f1-results-head">
      <div class="f1-round-strip">
        <span class="f1-round-pill">${esc(String(season.year))}</span>
        <span class="f1-round-meta">CHAMPIONSHIP TABLE</span>
      </div>
      <button class="btn btn-ghost btn-sm" id="open-predictions">⚡ PREDICT CHAMPION</button>
    </div>

    <h1 class="f1-page-title">${esc(String(season.year))} <span style="font-weight:300;color:var(--text-dim)">STANDINGS</span></h1>

    <div class="f1-filter-strip">
      <button class="f1-filter ${standingsTab === 'drivers' ? 'active' : ''}" data-stab="drivers">Drivers</button>
      <button class="f1-filter ${standingsTab === 'teams' ? 'active' : ''}" data-stab="teams">Constructors</button>
    </div>

    <div id="stand-table"></div>
  `;

  function renderTable() {
    const root = $('#stand-table', wrap);
    if (standingsTab === 'drivers') {
      root.innerHTML = dStand.length ? `
        <div class="f1-table-shell">
        <table class="standings-table">
          <thead><tr><th></th><th>DRIVER</th><th>TEAM</th><th class="num">PTS</th><th class="num">GAP</th><th class="num">W</th><th class="num">POD</th><th class="num">POLE</th><th class="num">FL</th><th class="num">DNF</th></tr></thead>
          <tbody>
            ${dStand.map((row, i) => {
              const drv = season.drivers.find(d => d.id === row.driverId); if (!drv) return '';
              const color = teamColor(season, drv.teamId);
              const photo = drv.photo
                ? `<div class="standings-portrait" style="--team-color:${color};background-image:url('${esc(drv.photo)}')"></div>`
                : `<div class="standings-portrait" style="--team-color:${color}"></div>`;
              const team = season.teams.find(t => t.id === drv.teamId);
              // Team column shows the constructor logo large, with no name.
              const teamMark = team
                ? (team.logo
                    ? `<div class="standings-team-logo" style="background-image:url('${esc(team.logo)}');--team-color:${color}" title="${esc(team.name)}"></div>`
                    : `<div class="standings-team-logo no-img" style="--team-color:${color}" title="${esc(team.name)}">${esc(team.short || team.name.slice(0,3).toUpperCase())}</div>`)
                : `<span class="team-dot" style="--team-color:${color}"></span>`;
              const { first, last } = splitName(drv.name);
              return `<tr class="standings-row p${i+1}" style="--team-color:${color}">
                <td class="pos-cell">${i+1}</td>
                <td><div class="driver-cell">
                  ${photo}
                  <span class="driver-cell-num" style="--team-color:${color}">${drv.number || '–'}</span>
                  <div class="driver-cell-name-wrap">
                    <div class="driver-cell-name">
                      ${first ? `<span class="first">${esc(first)}</span>` : ''}
                      <span>${esc(last)}</span>
                      ${row.championshipDsq ? '<span class="tag" style="color:var(--red);border-color:var(--red);font-size:8px;padding:2px 5px">DSQ</span>' : ''}
                    </div>
                    <div class="driver-cell-team">${flag(drv.country)} ${esc(drv.country || '')}</div>
                  </div>
                </div></td>
                <td class="team-logo-cell">${teamMark}</td>
                <td class="points-cell">${row.points}</td>
                <td class="gap-cell">${i === 0 ? '—' : '−' + (leaderPts - row.points)}</td>
                <td class="num ${row.wins ? '' : 'zero'}">${row.wins}</td>
                <td class="num ${row.podiums ? '' : 'zero'}">${row.podiums}</td>
                <td class="num ${row.polePositions ? '' : 'zero'}">${row.polePositions}</td>
                <td class="num ${row.fastestLaps ? '' : 'zero'}">${row.fastestLaps}</td>
                <td class="num ${row.dnfs ? '' : 'zero'}">${row.dnfs}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table></div>` : `<div class="empty-state"><p>No drivers yet.</p></div>`;
    } else {
      root.innerHTML = tStand.length ? `
        <div class="f1-table-shell">
        <table class="standings-table constructors-table">
          <thead><tr><th></th><th>CONSTRUCTOR</th><th class="num">PTS</th><th class="num">GAP</th><th class="num">W</th><th class="num">POD</th><th class="num">POLE</th><th class="num">FL</th></tr></thead>
          <tbody>
            ${tStand.map((row, i) => {
              const t = season.teams.find(x => x.id === row.teamId); if (!t) return '';
              const teamMark = t.logo
                ? `<div class="team-logo" style="background-image:url('${esc(t.logo)}');--team-color:${t.color}"></div>`
                : `<div class="team-logo" style="--team-color:${t.color}">${esc(t.short || t.name.slice(0,3).toUpperCase())}</div>`;
              return `<tr class="standings-row p${i+1}" style="--team-color:${t.color}">
                <td class="pos-cell">${i+1}</td>
                <td><div class="driver-cell">
                  ${teamMark}
                  <div class="driver-cell-name-wrap">
                    <div class="driver-cell-name"><span>${esc(t.name)}</span></div>
                    <div class="driver-cell-team">${esc(t.short || '')} · ${flagAndCode(t.country)}</div>
                  </div>
                </div></td>
                <td class="points-cell">${row.points}</td>
                <td class="gap-cell">${i === 0 ? '—' : '−' + (tLeaderPts - row.points)}</td>
                <td class="num ${row.wins ? '' : 'zero'}">${row.wins}</td>
                <td class="num ${row.podiums ? '' : 'zero'}">${row.podiums}</td>
                <td class="num ${row.polePositions ? '' : 'zero'}">${row.polePositions}</td>
                <td class="num ${row.fastestLaps ? '' : 'zero'}">${row.fastestLaps}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table></div>` : `<div class="empty-state"><p>No constructors yet.</p></div>`;
    }
  }
  setTimeout(() => {
    renderTable();
    $$('[data-stab]', wrap).forEach(b => b.onclick = () => {
      standingsTab = b.dataset.stab;
      $$('.f1-filter', wrap).forEach(x => x.classList.toggle('active', x.dataset.stab === standingsTab));
      renderTable();
    });
    $('#open-predictions', wrap)?.addEventListener('click', openPredictionsModal);
  }, 0);
  return wrap;
}

/* ---------- view: STATS ---------- */
let _statsSortKey = 'points';
let _statsSortDir = 'desc';
let _statsView = 'overview'; // 'overview' | 'charts'
let _chartsDriverId = null;  // driver focused in the charts view

function calcPerDriverSeasonStats(season) {
  const ps = getPointsSystem(season.pointsSystemId || DEFAULT_POINTS_SYSTEM_ID);
  const standings = calcDriverStandings(season);
  const teamStandings = calcTeamStandings(season);
  const teamPosMap = Object.fromEntries(teamStandings.map((t,i) => [t.teamId, i+1]));

  return standings.map(s => {
    const drv = season.drivers.find(d => d.id === s.driverId);
    const team = season.teams.find(t => t.id === drv?.teamId);
    const raceResults = season.races.map(race => {
      const r = (race.results || []).find(x => x.driverId === s.driverId);
      const sr = race.sprint ? (race.sprintResults || []).find(x => x.driverId === s.driverId) : null;
      const qr = (race.qualifyingResults || []).find(x => x.driverId === s.driverId);
      return {
        race,
        result: r,
        sprintResult: sr,
        qualifying: qr,
        wasPole: race.poleDriverId === s.driverId,
        wasFL: race.fastestLapDriverId === s.driverId,
      };
    });

    const finishes = raceResults
      .map(x => x.result)
      .filter(r => r && r.position && !r.dnf && !r.dsq && !r.dns)
      .map(r => r.position);
    const bestFinish = finishes.length ? Math.min(...finishes) : null;
    const avgFinish  = finishes.length ? (finishes.reduce((a,b) => a + b, 0) / finishes.length) : null;
    const top10s = finishes.filter(p => p <= 10).length;

    const gridPositions = raceResults
      .map(x => x.qualifying?.position)
      .filter(p => p && p > 0);
    const bestGrid = gridPositions.length ? Math.min(...gridPositions) : null;
    const avgGrid  = gridPositions.length ? (gridPositions.reduce((a,b) => a + b, 0) / gridPositions.length) : null;

    // gained positions per race: avg(grid - finish), where both exist for the same race
    const paired = raceResults
      .filter(x => x.qualifying?.position && x.result?.position && !x.result.dnf && !x.result.dsq && !x.result.dns)
      .map(x => x.qualifying.position - x.result.position);
    const avgGained = paired.length ? (paired.reduce((a,b) => a + b, 0) / paired.length) : null;

    const completedRaces = season.races.filter(r => r.completed).length;
    const avgPoints = completedRaces ? (s.points / completedRaces) : 0;

    return {
      ...s,
      driver: drv,
      team,
      teamColor: team?.color || '#666',
      raceResults,
      bestFinish,
      avgFinish,
      bestGrid,
      avgGrid,
      avgGained,
      top10s,
      avgPoints,
      finishRate: s.races ? Math.round(((s.races - s.dnfs - s.dsqs) / s.races) * 100) : 0,
      teamPos: team ? teamPosMap[team.id] : null,
    };
  });
}

/* Stat-leader cards shown at top of Stats page. Each uses leader's team colour as accent. */
const STAT_LEADER_CATS = [
  { id: 'wins',         label: 'Most Race Wins',          icon: '🏆', unit: 'Wins',         read: s => s.wins },
  { id: 'podiums',      label: 'Most Podium Finishes',    icon: '🥇', unit: 'Podiums',      read: s => s.podiums },
  { id: 'top10s',       label: 'Most Top 10 Finishes',    icon: '☰',  unit: 'Top 10s',      read: s => s.top10s },
  { id: 'sprintWins',   label: 'Most Sprint Race Wins',   icon: '🏁', unit: 'Sprint Wins',  read: s => s.sprintWins },
  { id: 'poles',        label: 'Most Pole Positions',     icon: '⚑',  unit: 'Poles',        read: s => s.polePositions },
  { id: 'fastestLaps',  label: 'Most Fastest Laps',       icon: '⏱',  unit: 'Fastest Laps', read: s => s.fastestLaps },
  { id: 'avgGained',    label: 'Most Gained Position per Race', icon: '↗', unit: 'Positions', read: s => s.avgGained, decimals: 2 },
  { id: 'avgPoints',    label: 'Highest Average Points',  icon: '★',  unit: 'Points',       read: s => s.avgPoints, decimals: 2 },
  { id: 'avgFinish',    label: 'Best Average Finish Position', icon: '✓', unit: '', read: s => s.avgFinish, decimals: 2, lower: true },
  { id: 'avgGrid',      label: 'Best Average Grid Position',   icon: '⊞', unit: '', read: s => s.avgGrid,   decimals: 2, lower: true },
  { id: 'dnfs',         label: 'Most DNF',                icon: '⚠',  unit: 'DNFs',         read: s => s.dnfs },
  { id: 'starts',       label: 'Most Race Starts',        icon: '◉',  unit: 'Starts',       read: s => s.races },
];

function fmtStatVal(v, cat) {
  if (v == null || (typeof v === 'number' && isNaN(v))) return '—';
  if (cat.decimals && typeof v === 'number') return v.toFixed(cat.decimals);
  return v;
}

function renderStats() {
  const season = activeSeason();
  const wrap = document.createElement('div');
  const stats = calcPerDriverSeasonStats(season);

  // Build leader card data
  const leaderCards = STAT_LEADER_CATS.map(cat => {
    const filtered = stats.filter(s => {
      const v = cat.read(s);
      if (v == null || (typeof v === 'number' && isNaN(v))) return false;
      if (cat.lower) return true; // any non-null counts for "lower is better"
      return v > 0;
    });
    const sorted = filtered.slice().sort((a, b) => {
      const av = cat.read(a) || 0;
      const bv = cat.read(b) || 0;
      return cat.lower ? av - bv : bv - av;
    });
    const leader = sorted[0];
    const rank = leader ? (sorted.findIndex(x => x.driverId === leader.driverId) + 1) : null;
    return { cat, leader, rank };
  });

  // Sortable table below
  const sortedTable = stats.slice().sort((a, b) => {
    const av = a[_statsSortKey] ?? 0;
    const bv = b[_statsSortKey] ?? 0;
    return _statsSortDir === 'desc' ? bv - av : av - bv;
  });
  const tableCols = [
    { key: 'points',    label: 'PTS' },
    { key: 'wins',      label: 'W' },
    { key: 'podiums',   label: 'POD' },
    { key: 'top10s',    label: 'T10' },
    { key: 'polePositions', label: 'POLE' },
    { key: 'fastestLaps', label: 'FL' },
    { key: 'sprintWins', label: 'SP·W' },
    { key: 'races',     label: 'STARTS' },
    { key: 'dnfs',      label: 'DNF' },
    { key: 'dsqs',      label: 'DSQ' },
    { key: 'avgFinish', label: 'AVG·F' },
    { key: 'avgGrid',   label: 'AVG·G' },
  ];

  const renderLeaderCard = ({ cat, leader, rank }) => {
    if (!leader) {
      return `
        <div class="stat-leader-card stat-leader-card-empty" style="--accent-color:#3a3f4a">
          <div class="stat-leader-bar"></div>
          <div class="stat-leader-head">
            <span class="stat-leader-icon">${cat.icon}</span>
            <span class="stat-leader-title">${esc(cat.label)}</span>
          </div>
          <div class="stat-leader-empty-state">
            <div class="stat-leader-empty-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            </div>
            <div class="stat-leader-empty-msg">Awaiting data</div>
            <div class="stat-leader-empty-sub">No driver qualifies for this category yet — record some race results to populate it.</div>
          </div>
        </div>`;
    }
    const drv = leader.driver;
    const team = leader.team;
    const accent = leader.teamColor || '#e10600';
    const { first, last } = splitName(drv.name);
    const photo = drv.photo
      ? `<div class="stat-leader-portrait" style="background-image:url('${esc(drv.photo)}')"></div>`
      : `<div class="stat-leader-portrait"></div>`;
    const teamMark = team
      ? (team.logo
        ? `<div class="stat-leader-team-mark" style="background-image:url('${esc(team.logo)}')"></div>`
        : `<div class="stat-leader-team-mark">${esc(team.short || '?')}</div>`)
      : '';
    const val = cat.read(leader);
    return `
      <div class="stat-leader-card" data-cat="${cat.id}" style="--accent-color:${accent}">
        <div class="stat-leader-bar"></div>
        <div class="stat-leader-head">
          <span class="stat-leader-icon">${cat.icon}</span>
          <span class="stat-leader-title">${esc(cat.label)}</span>
        </div>
        <div class="stat-leader-body">
          <div style="position:relative">
            ${photo}
            ${teamMark}
          </div>
          <div>
            <div class="stat-leader-name">${esc(first || '')}<span class="last">${esc(last)}</span></div>
            <div class="stat-leader-team">${esc(team?.name || 'No team')}</div>
            ${drv.country ? `<div class="stat-leader-country">${flagImg(drv.country, 18)}<span>${esc(drv.country)}</span></div>` : ''}
          </div>
        </div>
        <div class="stat-leader-bignum">
          <span class="stat-leader-bignum-num">${fmtStatVal(val, cat)}</span>
          <span class="stat-leader-bignum-unit">${esc(cat.unit)}</span>
        </div>
        <div class="stat-leader-foot">
          <span>POS: <b>${rank}</b></span>
          <span>RACES: <b>${leader.races}</b></span>
        </div>
      </div>`;
  };

  wrap.innerHTML = `
    <div class="f1-results-head" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px">
      <div class="f1-round-strip">
        <span class="f1-round-pill">${esc(String(season.year))}</span>
        <span class="f1-round-meta">${esc(season.name)}</span>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-ghost" id="open-cmp">⊕ COMPARE ACROSS SEASONS</button>
        <button class="btn btn-primary" id="open-h2h">⇄ HEAD-TO-HEAD COMPARISON</button>
      </div>
    </div>

    <h1 class="f1-page-title">${esc(String(season.year))} <span style="font-weight:300;color:var(--text-dim)">DRIVER STATISTICS</span></h1>

    <div class="f1-filter-strip">
      <button class="f1-filter ${_statsView === 'overview' ? 'active' : ''}" data-statview="overview">Overview</button>
      <button class="f1-filter ${_statsView === 'charts' ? 'active' : ''}" data-statview="charts">Charts</button>
    </div>

    <div id="stats-shell"></div>
  `;

  const renderShell = () => {
    const shell = $('#stats-shell', wrap);
    if (_statsView === 'charts') {
      shell.innerHTML = '';
      shell.appendChild(renderStatsCharts(season, stats));
      return;
    }

    shell.innerHTML = stats.length ? `
      <div class="stat-leader-grid">
        ${leaderCards.map(renderLeaderCard).join('')}
      </div>

      <div class="dash-block-head" style="margin-top:36px">
        <div class="dash-block-title">Full Driver Table</div>
        <span class="tag">${stats.length} ENTRIES</span>
      </div>
      <div class="standings-table" style="overflow-x:auto">
        <table class="season-stats-table">
          <thead>
            <tr>
              <th style="width:30px">#</th>
              <th style="width:60px"></th>
              <th>DRIVER</th>
              <th>TEAM</th>
              ${tableCols.map(c => `<th class="ssh" data-sort="${c.key}" style="cursor:pointer;text-align:right">${c.label}${_statsSortKey === c.key ? (_statsSortDir === 'desc' ? ' ↓' : ' ↑') : ''}</th>`).join('')}
            </tr>
          </thead>
          <tbody>
            ${sortedTable.map((s, i) => {
              const drv = s.driver; if (!drv) return '';
              const photoStat = drv.photo
                ? `<div class="h2h-portrait" style="--team-color:${s.teamColor};background-image:url('${esc(drv.photo)}');width:36px;height:36px"></div>`
                : `<div class="h2h-portrait" style="--team-color:${s.teamColor};width:36px;height:36px;font-size:11px"></div>`;
              return `<tr data-driver="${drv.id}">
                <td style="font-family:var(--f-display);font-weight:800;color:var(--text-dim)">${i+1}</td>
                <td>${photoStat}</td>
                <td><div class="season-stats-driver">${esc(drv.name)}${drv.dsq ? ' <span class="tag" style="color:var(--red);border-color:var(--red);font-size:8px">DSQ</span>' : ''}</div><div style="font-family:var(--f-mono);font-size:10px;color:var(--text-muted)">${flag(drv.country)} #${drv.number}</div></td>
                <td><span class="team-dot" style="--team-color:${s.teamColor}"></span> ${esc(s.team?.name || 'No team')}</td>
                ${tableCols.map(c => {
                  let val = s[c.key];
                  if (c.key === 'avgFinish' || c.key === 'avgGrid') val = val == null ? '—' : val.toFixed(2);
                  const isZero = val == null || val === 0 || val === '—';
                  const cls = isZero && c.key !== 'avgFinish' && c.key !== 'avgGrid' ? 'season-stats-num zero' : 'season-stats-num';
                  return `<td><div class="${cls}" style="text-align:right">${val == null ? '—' : val}</div></td>`;
                }).join('')}
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    ` : `<div class="empty"><div class="empty-headline">NO DRIVERS</div><div class="empty-sub">Sign drivers and run races to populate stats.</div></div>`;

    // Wire up sortable columns + driver row clicks (only relevant in overview view)
    $$('.ssh', shell).forEach(th => th.onclick = () => {
      const k = th.dataset.sort;
      if (_statsSortKey === k) _statsSortDir = _statsSortDir === 'desc' ? 'asc' : 'desc';
      else { _statsSortKey = k; _statsSortDir = 'desc'; }
      renderMain();
    });
    $$('tr[data-driver]', shell).forEach(tr => tr.onclick = () => openDriverSeasonDetail(tr.dataset.driver));
  };
  setTimeout(() => {
    renderShell();
    $$('[data-statview]', wrap).forEach(b => b.onclick = () => {
      _statsView = b.dataset.statview;
      $$('[data-statview]', wrap).forEach(x => x.classList.toggle('active', x.dataset.statview === _statsView));
      renderShell();
    });
    $$('.stat-leader-card[data-cat]', wrap).forEach(card => card.onclick = () => {
      const lc = leaderCards.find(x => x.cat.id === card.dataset.cat);
      if (lc?.leader) openDriverSeasonDetail(lc.leader.driverId);
    });
    $('#open-h2h', wrap)?.addEventListener('click', openHeadToHead);
    $('#open-cmp', wrap)?.addEventListener('click', openDriverComparison);
  }, 0);
  return wrap;
}

/* =====================================================
   STATS · CHARTS VIEW
   Pure inline SVG (no external libs):
   - Last-5 finishes mini-card per driver
   - Cumulative points across all rounds (line chart)
   - Race finishes per round per driver (line chart)
   - Driver finish-distribution bars (P1/P2-3/T10/Other/DNF/DSQ/DNS)
   ===================================================== */
function renderStatsCharts(season, stats) {
  const wrap = document.createElement('div');

  if (!stats.length) {
    wrap.innerHTML = `<div class="empty"><div class="empty-headline">NO DRIVERS</div><div class="empty-sub">Sign drivers and run races to populate charts.</div></div>`;
    return wrap;
  }
  if (!season.races.length) {
    wrap.innerHTML = `<div class="empty"><div class="empty-headline">NO RACES</div><div class="empty-sub">Add rounds and save results to populate charts.</div></div>`;
    return wrap;
  }

  // Pick a focused driver — default to championship leader, or whoever was last picked
  const focusDriver = stats.find(s => s.driverId === _chartsDriverId) || stats[0];

  // Build cumulative points by round for every driver
  const races = season.races.slice().sort((a, b) => a.round - b.round);
  const ps = getPointsSystem(season.pointsSystemId || DEFAULT_POINTS_SYSTEM_ID);

  const pointsPerRound = stats.map(s => {
    const drv = s.driver;
    let cum = 0;
    const points = races.map(race => {
      // Race points
      const r = (race.results || []).find(x => x.driverId === drv.id);
      let p = 0;
      if (r && r.position && !r.dnf && !r.dsq && !r.dns) {
        if (r.position <= ps.points.length) p += ps.points[r.position - 1];
        if (race.fastestLapDriverId === drv.id && ps.flBonus) {
          if (!ps.flRequiresTop10 || r.position <= 10) p += ps.flBonus;
        }
      }
      // Sprint points
      if (race.sprint) {
        const sr = (race.sprintResults || []).find(x => x.driverId === drv.id);
        if (sr && sr.position && !sr.dnf && !sr.dsq && !sr.dns && ps.sprintPoints) {
          if (sr.position <= ps.sprintPoints.length) p += ps.sprintPoints[sr.position - 1];
        }
      }
      // Pole bonus
      if (season.polePointEnabled && race.poleDriverId === drv.id && Number(season.polePointValue) > 0) {
        cum += Number(season.polePointValue);
      }
      cum += p;
      return cum;
    });
    return { driver: drv, teamColor: s.teamColor, totals: points, finalPts: cum };
  });

  // Top-N driver lines on the cumulative-points chart (cap at 10 to keep chart readable)
  const topDriversForLine = pointsPerRound.slice().sort((a, b) => b.finalPts - a.finalPts).slice(0, 10);

  // Build the cumulative-points line chart SVG
  const W = 900, H = 360, M = { t: 20, r: 200, b: 40, l: 40 };
  const innerW = W - M.l - M.r;
  const innerH = H - M.t - M.b;
  const maxY = Math.max(1, ...topDriversForLine.flatMap(d => d.totals));
  const niceMaxY = Math.ceil(maxY / 25) * 25;
  const xStep = races.length > 1 ? innerW / (races.length - 1) : innerW;
  const xCoord = (i) => M.l + i * xStep;
  const yCoord = (v) => M.t + innerH - (v / niceMaxY) * innerH;

  // Build the cumulative-points chart paths
  const pointsLineSVG = `
    <svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" class="chart-svg" preserveAspectRatio="xMidYMid meet">
      <!-- grid lines -->
      ${[0, 0.25, 0.5, 0.75, 1].map(p => {
        const y = M.t + innerH - p * innerH;
        const v = Math.round(p * niceMaxY);
        return `<line x1="${M.l}" y1="${y}" x2="${M.l + innerW}" y2="${y}" stroke="#2a2a38" stroke-width="1"/>
                <text x="${M.l - 8}" y="${y + 4}" fill="#5e5e69" font-family="JetBrains Mono, monospace" font-size="10" text-anchor="end">${v}</text>`;
      }).join('')}
      <!-- x-axis: round numbers -->
      ${races.map((r, i) => {
        if (races.length > 14 && i % 2 !== 0 && i !== races.length - 1) return '';
        return `<text x="${xCoord(i)}" y="${H - M.b + 20}" fill="#5e5e69" font-family="JetBrains Mono, monospace" font-size="9" text-anchor="middle">R${r.round}</text>`;
      }).join('')}
      <!-- driver lines -->
      ${topDriversForLine.map(d => {
        const path = d.totals.map((v, i) => `${i === 0 ? 'M' : 'L'}${xCoord(i)},${yCoord(v)}`).join(' ');
        return `<path d="${path}" fill="none" stroke="${d.teamColor}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" opacity="0.95"/>`;
      }).join('')}
      <!-- end-of-line driver labels -->
      ${topDriversForLine.map(d => {
        const lastIdx = d.totals.length - 1;
        const y = yCoord(d.totals[lastIdx]);
        const initials = driverInitials(d.driver.name);
        return `<g>
          <circle cx="${xCoord(lastIdx)}" cy="${y}" r="3.5" fill="${d.teamColor}"/>
          <text x="${xCoord(lastIdx) + 8}" y="${y + 4}" fill="${d.teamColor}" font-family="Titillium Web" font-weight="700" font-size="11">${esc(initials)} · ${d.finalPts}</text>
        </g>`;
      }).join('')}
    </svg>`;

  // Build last-5 finish mini-cards for every driver
  const last5HTML = stats.map(s => {
    const drv = s.driver;
    const completed = races.filter(r => r.completed);
    const last5 = completed.slice(-5).map(race => {
      const r = (race.results || []).find(x => x.driverId === drv.id);
      if (!r) return { race, status: '—', cls: 'empty' };
      if (r.dns) return { race, status: 'DNS', cls: 'dns' };
      if (r.dsq) return { race, status: 'DSQ', cls: 'dsq' };
      if (r.dnf) return { race, status: 'DNF', cls: 'dnf' };
      const cls = r.position === 1 ? 'gold' : r.position <= 3 ? r.position === 2 ? 'silver' : 'bronze' : r.position <= 10 ? 'pts' : 'plain';
      return { race, status: 'P' + r.position, cls };
    });
    while (last5.length < 5) last5.unshift({ race: null, status: '—', cls: 'empty' });
    const portrait = drv.photo
      ? `<div class="last5-portrait" style="background-image:url('${esc(drv.photo)}');border-color:${s.teamColor}"></div>`
      : `<div class="last5-portrait" style="border-color:${s.teamColor};color:${s.teamColor}"></div>`;
    return `<div class="last5-card" style="--accent:${s.teamColor}">
      ${portrait}
      <div class="last5-body">
        <div class="last5-name">${esc(drv.name)}</div>
        <div class="last5-team">${esc(s.team?.name || 'No team')}</div>
        <div class="last5-cells">
          ${last5.map(c => `<div class="last5-cell ${c.cls}" title="${c.race ? esc(c.race.name) : 'No race yet'}">${c.status}</div>`).join('')}
        </div>
      </div>
    </div>`;
  }).join('');

  // Driver-focused per-round finish-position chart (lower = better; flip Y)
  const focusRaces = races.filter(r => r.completed);
  let focusedFinishSVG = '';
  if (focusRaces.length && focusDriver) {
    const W2 = 900, H2 = 280, M2 = { t: 24, r: 30, b: 40, l: 50 };
    const iW = W2 - M2.l - M2.r;
    const iH = H2 - M2.t - M2.b;
    const N = Math.max(1, season.drivers.length);
    const xStep2 = focusRaces.length > 1 ? iW / (focusRaces.length - 1) : iW;
    const xc = (i) => M2.l + i * xStep2;
    const yc = (pos) => M2.t + ((pos - 1) / Math.max(1, N - 1)) * iH; // 1 at top, last at bottom

    const pts = focusRaces.map((race, i) => {
      const r = (race.results || []).find(x => x.driverId === focusDriver.driver.id);
      if (!r || r.dns || r.dsq || r.dnf || !r.position) return { race, x: xc(i), y: null, status: r?.dns ? 'DNS' : r?.dsq ? 'DSQ' : r?.dnf ? 'DNF' : '—' };
      return { race, x: xc(i), y: yc(r.position), pos: r.position, status: 'P' + r.position };
    });

    // Build line connecting valid points only
    let path = '';
    pts.forEach((p, i) => {
      if (p.y == null) return;
      path += (path ? ' L' : 'M') + `${p.x},${p.y}`;
    });

    focusedFinishSVG = `
      <svg viewBox="0 0 ${W2} ${H2}" xmlns="http://www.w3.org/2000/svg" class="chart-svg" preserveAspectRatio="xMidYMid meet">
        <!-- y-axis grid: P1, podium, T10, last -->
        ${[1, 3, 10, N].filter(v => v <= N).map(v => `
          <line x1="${M2.l}" y1="${yc(v)}" x2="${M2.l + iW}" y2="${yc(v)}" stroke="#2a2a38" stroke-width="1" stroke-dasharray="${v === 1 ? '0' : '3 3'}"/>
          <text x="${M2.l - 8}" y="${yc(v) + 4}" fill="#5e5e69" font-family="JetBrains Mono, monospace" font-size="10" text-anchor="end">P${v}</text>
        `).join('')}
        <!-- x-axis -->
        ${focusRaces.map((r, i) => `<text x="${xc(i)}" y="${H2 - M2.b + 20}" fill="#5e5e69" font-family="JetBrains Mono, monospace" font-size="9" text-anchor="middle">R${r.round}</text>`).join('')}
        <!-- main line -->
        <path d="${path}" fill="none" stroke="${focusDriver.teamColor}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
        <!-- dots -->
        ${pts.map(p => p.y != null
          ? `<g><circle cx="${p.x}" cy="${p.y}" r="5" fill="${focusDriver.teamColor}" stroke="#0f0f17" stroke-width="2"/><title>${esc(p.race.name)} · ${p.status}</title></g>`
          : `<g><circle cx="${p.x}" cy="${M2.t + iH + 6}" r="3" fill="#e10600"/><text x="${p.x}" y="${M2.t + iH + 24}" fill="#e10600" font-family="JetBrains Mono, monospace" font-size="8" text-anchor="middle">${p.status}</text><title>${esc(p.race.name)} · ${p.status}</title></g>`
        ).join('')}
      </svg>`;
  }

  // Driver finish-distribution stacked bars (one bar per driver, segments coloured)
  const distBars = stats.map(s => {
    const drv = s.driver;
    const races = season.races;
    const buckets = { wins: 0, podiums: 0, top10: 0, other: 0, dnf: 0, dsq: 0, dns: 0 };
    races.forEach(race => {
      const r = (race.results || []).find(x => x.driverId === drv.id);
      if (!r) return;
      if (r.dns) buckets.dns++;
      else if (r.dsq) buckets.dsq++;
      else if (r.dnf) buckets.dnf++;
      else if (r.position === 1) buckets.wins++;
      else if (r.position <= 3) buckets.podiums++;
      else if (r.position <= 10) buckets.top10++;
      else if (r.position) buckets.other++;
    });
    const total = Object.values(buckets).reduce((a, b) => a + b, 0);
    if (!total) return '';
    const seg = (n, cls, label) => n ? `<div class="dist-seg ${cls}" style="flex:${n}" title="${label}: ${n}"></div>` : '';
    return `<div class="dist-row">
      <div class="dist-name">${esc(drv.name)}</div>
      <div class="dist-bar">
        ${seg(buckets.wins, 'wins', 'Wins')}
        ${seg(buckets.podiums, 'podiums', 'Podiums (P2-3)')}
        ${seg(buckets.top10, 'top10', 'Top 10')}
        ${seg(buckets.other, 'other', 'Outside top 10')}
        ${seg(buckets.dnf, 'dnf', 'DNF')}
        ${seg(buckets.dsq, 'dsq', 'DSQ')}
        ${seg(buckets.dns, 'dns', 'DNS')}
      </div>
      <div class="dist-total">${total}</div>
    </div>`;
  }).filter(Boolean).join('');

  wrap.innerHTML = `
    <div class="charts-section">
      <div class="charts-section-head">
        <div class="dash-block-title">Cumulative Championship Points</div>
        <span class="charts-help">Top 10 drivers by final standing · team livery colours</span>
      </div>
      <div class="f1-table-shell" style="padding:18px 22px">
        ${pointsLineSVG}
      </div>
    </div>

    <div class="charts-section" style="margin-top:32px">
      <div class="charts-section-head">
        <div class="dash-block-title">Last 5 Finishes — Every Driver</div>
        <span class="charts-help">Newest race rightmost · ◯ no race yet</span>
      </div>
      <div class="last5-grid">${last5HTML}</div>
    </div>

    <div class="charts-section" style="margin-top:32px">
      <div class="charts-section-head">
        <div class="dash-block-title">Race-by-Race Finish Position · ${esc(focusDriver.driver.name)}</div>
        <select id="charts-driver-pick" class="charts-driver-select">
          ${stats.map(s => `<option value="${s.driverId}" ${s.driverId === focusDriver.driverId ? 'selected' : ''}>#${s.driver.number} · ${esc(s.driver.name)}</option>`).join('')}
        </select>
      </div>
      <div class="f1-table-shell" style="padding:18px 22px">
        ${focusedFinishSVG || '<div class="empty"><div class="empty-headline">NO COMPLETED RACES</div></div>'}
      </div>
    </div>

    <div class="charts-section" style="margin-top:32px">
      <div class="charts-section-head">
        <div class="dash-block-title">Finish Distribution</div>
        <div class="dist-legend">
          <span><i class="dist-swatch wins"></i> Win</span>
          <span><i class="dist-swatch podiums"></i> Podium</span>
          <span><i class="dist-swatch top10"></i> Top 10</span>
          <span><i class="dist-swatch other"></i> Other</span>
          <span><i class="dist-swatch dnf"></i> DNF</span>
          <span><i class="dist-swatch dsq"></i> DSQ</span>
          <span><i class="dist-swatch dns"></i> DNS</span>
        </div>
      </div>
      <div class="f1-table-shell" style="padding:22px 26px">
        <div class="dist-list">${distBars || '<div class="empty"><div class="empty-headline">NO RESULTS</div></div>'}</div>
      </div>
    </div>
  `;

  setTimeout(() => {
    $('#charts-driver-pick', wrap)?.addEventListener('change', (e) => {
      _chartsDriverId = e.target.value;
      // re-render only the charts shell, not the whole stats page
      const shell = document.getElementById('stats-shell');
      if (shell) {
        shell.innerHTML = '';
        shell.appendChild(renderStatsCharts(activeSeason(), stats));
      }
    });
  }, 0);

  return wrap;
}


function openDriverSeasonDetail(driverId) {
  const season = activeSeason();
  const drv = season.drivers.find(d => d.id === driverId); if (!drv) return;
  const allStats = calcPerDriverSeasonStats(season);
  const s = allStats.find(x => x.driverId === driverId); if (!s) return;
  const team = s.team;
  const teamColor = s.teamColor;

  const photoHTML = drv.photo
    ? `<div class="h2h-portrait" style="--team-color:${teamColor};background-image:url('${esc(drv.photo)}')"></div>`
    : `<div class="h2h-portrait" style="--team-color:${teamColor}"></div>`;

  modal({
    title: `${esc(drv.name)} <span class="accent">· ${season.year}</span>`,
    size: 'wide',
    body: `
      <div style="padding:18px 22px;display:flex;align-items:center;gap:16px;border-bottom:1px solid var(--border)">
        ${photoHTML}
        <div style="flex:1">
          <div class="h2h-driver-name">${esc(drv.name)} ${flag(drv.country)}</div>
          <div class="h2h-driver-team">${esc(team?.name || 'No team')} · #${drv.number}</div>
        </div>
        <div style="display:grid;grid-template-columns:repeat(4,auto);gap:18px;text-align:center">
          <div><div style="font-family:var(--f-display);font-weight:900;font-size:28px">${s.points}</div><div style="font-family:var(--f-mono);font-size:9px;letter-spacing:0.18em;color:var(--text-muted)">POINTS</div></div>
          <div><div style="font-family:var(--f-display);font-weight:900;font-size:28px">${s.wins}</div><div style="font-family:var(--f-mono);font-size:9px;letter-spacing:0.18em;color:var(--text-muted)">WINS</div></div>
          <div><div style="font-family:var(--f-display);font-weight:900;font-size:28px">${s.podiums}</div><div style="font-family:var(--f-mono);font-size:9px;letter-spacing:0.18em;color:var(--text-muted)">PODIUMS</div></div>
          <div><div style="font-family:var(--f-display);font-weight:900;font-size:28px;color:${s.bestFinish === 1 ? 'var(--gold)' : 'var(--text)'}">${s.bestFinish || '—'}</div><div style="font-family:var(--f-mono);font-size:9px;letter-spacing:0.18em;color:var(--text-muted)">BEST</div></div>
        </div>
      </div>
      <div style="padding:18px 22px">
        <div style="font-family:var(--f-mono);font-size:10px;letter-spacing:0.2em;color:var(--text-dim);text-transform:uppercase;margin-bottom:12px">RACE-BY-RACE · ◐ POLE · ● FASTEST LAP</div>
        <div class="race-by-race">
          ${s.raceResults.map(rr => {
            const pos = rr.result?.position;
            const r = rr.race;
            let cell = '—';
            let cellClass = '';
            if (rr.result) {
              if (rr.result.dns) { cell = 'DNS'; cellClass = 'dns'; }
              else if (rr.result.dsq) { cell = 'DSQ'; cellClass = 'dsq'; }
              else if (rr.result.dnf) { cell = 'DNF'; cellClass = 'dnf'; }
              else if (pos) {
                cell = pos;
                if (pos === 1) cellClass = 'gold';
                else if (pos === 2) cellClass = 'silver';
                else if (pos === 3) cellClass = 'bronze';
              }
            }
            const flags = (rr.wasPole ? ' has-pole' : '') + (rr.wasFL ? ' has-fl' : '');
            return `<div class="race-cell${flags}" title="${esc(r.name)}${pos ? ` · P${pos}` : ''}">
              <div class="race-cell-round">R${r.round}</div>
              <div class="race-cell-pos ${cellClass}">${cell}</div>
            </div>`;
          }).join('')}
        </div>
      </div>`,
    footer: `<button class="btn btn-ghost" data-act="cancel">Close</button>`,
    onMount: (root, close) => { $('[data-act="cancel"]', root).onclick = close; }
  });
}

/* head-to-head: pick two drivers from the season, see side-by-side */
let _h2hLeft = null;
let _h2hRight = null;

function openHeadToHead() {
  const season = activeSeason();
  if (season.drivers.length < 2) return toast('Need at least two drivers signed', 'warn');
  const stats = calcPerDriverSeasonStats(season);
  // initialise to top two
  if (!_h2hLeft || !season.drivers.find(d => d.id === _h2hLeft))   _h2hLeft  = stats[0]?.driverId;
  if (!_h2hRight || !season.drivers.find(d => d.id === _h2hRight) || _h2hRight === _h2hLeft) _h2hRight = stats[1]?.driverId;

  modal({
    title: `Head-to-<span class="accent">Head</span>`,
    size: 'wide',
    body: `<div id="h2h-shell"></div>`,
    footer: `<span style="font-family:var(--f-mono);font-size:10px;color:var(--text-muted);letter-spacing:0.1em;margin-right:auto">${season.year} · ${esc(season.name)}</span><button class="btn btn-ghost" data-act="cancel">Close</button>`,
    onMount: (root, close) => {
      $('[data-act="cancel"]', root).onclick = close;
      const shell = $('#h2h-shell', root);
      const renderShell = () => {
        const left  = stats.find(s => s.driverId === _h2hLeft);
        const right = stats.find(s => s.driverId === _h2hRight);
        if (!left || !right) return;
        const head = (s, side) => {
          const photo = s.driver.photo
            ? `<div class="h2h-portrait" style="--team-color:${s.teamColor};background-image:url('${esc(s.driver.photo)}')"></div>`
            : `<div class="h2h-portrait" style="--team-color:${s.teamColor}"></div>`;
          return `<div class="h2h-driver-head ${side}">
            ${photo}
            <div>
              <div class="h2h-driver-name">${esc(s.driver.name)} ${flag(s.driver.country)}</div>
              <div class="h2h-driver-team">${esc(s.team?.name || 'No team')} · #${s.driver.number}</div>
            </div>
          </div>`;
        };
        // pairwise comparison: who finished ahead of whom in each race
        let leftAhead = 0, rightAhead = 0;
        season.races.forEach(race => {
          if (!race.completed) return;
          const lr = (race.results || []).find(r => r.driverId === left.driverId);
          const rr = (race.results || []).find(r => r.driverId === right.driverId);
          if (!lr || !rr) return;
          const lValid = lr.position && !lr.dnf && !lr.dsq && !lr.dns;
          const rValid = rr.position && !rr.dnf && !rr.dsq && !rr.dns;
          if (lValid && rValid) {
            if (lr.position < rr.position) leftAhead++;
            else if (rr.position < lr.position) rightAhead++;
          } else if (lValid) leftAhead++;
          else if (rValid) rightAhead++;
        });
        // qualifying head-to-head
        let lQuali = 0, rQuali = 0;
        season.races.forEach(race => {
          const lq = (race.qualifyingResults || []).find(r => r.driverId === left.driverId);
          const rq = (race.qualifyingResults || []).find(r => r.driverId === right.driverId);
          if (!lq || !rq || !lq.position || !rq.position) return;
          if (lq.position < rq.position) lQuali++;
          else if (rq.position < lq.position) rQuali++;
        });

        const rows = [
          { label: 'Points',         lv: left.points,     rv: right.points },
          { label: 'Wins',           lv: left.wins,       rv: right.wins },
          { label: 'Podiums',        lv: left.podiums,    rv: right.podiums },
          { label: 'Pole Positions', lv: left.polePositions, rv: right.polePositions },
          { label: 'Fastest Laps',   lv: left.fastestLaps,   rv: right.fastestLaps },
          { label: 'Sprint Wins',    lv: left.sprintWins, rv: right.sprintWins },
          { label: 'Race Starts',    lv: left.races,      rv: right.races },
          { label: 'DNFs',           lv: left.dnfs,       rv: right.dnfs },
          { label: 'DSQs',           lv: left.dsqs,       rv: right.dsqs },
          { label: 'Best Finish',    lv: left.bestFinish || '—', rv: right.bestFinish || '—', lower: true },
          { label: 'Finish Rate %',  lv: left.finishRate, rv: right.finishRate },
          { label: 'Race H2H · finished ahead', lv: leftAhead, rv: rightAhead, highlight: true },
          { label: 'Quali H2H · qualified ahead', lv: lQuali, rv: rQuali, highlight: true },
        ];

        shell.innerHTML = `
          <div class="h2h-pickers">
            <select id="h2h-left">
              ${stats.map(s => `<option value="${s.driverId}" ${s.driverId === _h2hLeft ? 'selected' : ''}>#${s.driver.number} · ${esc(s.driver.name)}${s.team ? ' (' + esc(s.team.short) + ')' : ''}</option>`).join('')}
            </select>
            <div class="h2h-vs">VS</div>
            <select id="h2h-right">
              ${stats.map(s => `<option value="${s.driverId}" ${s.driverId === _h2hRight ? 'selected' : ''}>#${s.driver.number} · ${esc(s.driver.name)}${s.team ? ' (' + esc(s.team.short) + ')' : ''}</option>`).join('')}
            </select>
          </div>

          <div class="h2h-headline">
            ${head(left, 'left')}
            <div class="h2h-mid">${left.points >= right.points ? '↤ POINTS LEADER' : 'POINTS LEADER ↦'}</div>
            ${head(right, 'right')}
          </div>

          <div class="h2h-stats">
            ${rows.map(row => {
              const lNum = typeof row.lv === 'number' ? row.lv : 0;
              const rNum = typeof row.rv === 'number' ? row.rv : 0;
              const lWins = row.lower ? lNum < rNum && lNum !== 0 : lNum > rNum;
              const rWins = row.lower ? rNum < lNum && rNum !== 0 : rNum > lNum;
              const max = Math.max(Math.abs(lNum), Math.abs(rNum), 1);
              const lPct = lNum ? Math.round((Math.abs(lNum) / max) * 100) : 0;
              const rPct = rNum ? Math.round((Math.abs(rNum) / max) * 100) : 0;
              return `<div class="h2h-row">
                <div class="h2h-bar left">
                  <div class="h2h-bar-fill" style="width:${lPct}%${lWins ? '' : ';opacity:0.55'}"></div>
                  <div class="h2h-bar-val">${row.lv}</div>
                </div>
                <div class="h2h-label">${esc(row.label)}</div>
                <div class="h2h-bar right">
                  <div class="h2h-bar-fill right" style="width:${rPct}%${rWins ? '' : ';opacity:0.55'}"></div>
                  <div class="h2h-bar-val">${row.rv}</div>
                </div>
              </div>`;
            }).join('')}
          </div>`;

        $('#h2h-left', shell).onchange  = (e) => { _h2hLeft  = e.target.value; renderShell(); };
        $('#h2h-right', shell).onchange = (e) => { _h2hRight = e.target.value; renderShell(); };
      };
      renderShell();
    }
  });
}

/* ---------- view: RECORDS ---------- */
const RECORD_CATEGORIES = [
  { id: 'driver_wins',         label: 'Most Race Wins',         scope: 'drivers', key: 'wins',          unit: 'WINS' },
  { id: 'driver_champs',       label: "Drivers' Championships", scope: 'drivers', key: 'championships', unit: 'TITLES' },
  { id: 'team_wins',           label: 'Most Race Wins · Teams', scope: 'teams',   key: 'wins',          unit: 'WINS' },
  { id: 'team_champs',         label: "Constructors' Titles",   scope: 'teams',   key: 'championships', unit: 'TITLES' },
  { id: 'driver_poles',        label: 'Most Pole Positions',    scope: 'drivers', key: 'poles',         unit: 'POLES' },
  { id: 'driver_season_wins',  label: 'Most Wins in a Season',  scope: 'drivers', key: 'bestSeasonWins',  unit: 'WINS' },
  { id: 'driver_season_poles', label: 'Most Poles in a Season', scope: 'drivers', key: 'bestSeasonPoles', unit: 'POLES' },
  { id: 'driver_fl',           label: 'Most Fastest Laps',      scope: 'drivers', key: 'fastestLaps',   unit: 'FLs' },
  { id: 'driver_dnfs',         label: 'Most DNFs',              scope: 'drivers', key: 'dnfs',          unit: 'DNFs' },
  { id: 'driver_points',       label: 'Most Career Points',     scope: 'drivers', key: 'points',        unit: 'PTS' },
  { id: 'driver_sprint_wins',  label: 'Most Sprint Wins',       scope: 'drivers', key: 'sprintWins',    unit: 'WINS' },
  { id: 'driver_starts',       label: 'Most Race Starts',       scope: 'drivers', key: 'starts',        unit: 'STARTS' },
];

function renderRecords() {
  const recs = calcAllTimeRecords();
  const trackRecs = calcTrackRecords();
  const wrap = document.createElement('div');

  const bodyHTML = (tab) => tab === 'tracks'
    ? renderTrackRecordsHTML(trackRecs)
    : recordBookGridHTML(recs);

  const titleHTML = (tab) => tab === 'tracks'
    ? `TRACK <span style="font-weight:300;color:var(--text-dim)">RECORDS</span>`
    : `RECORD <span style="font-weight:300;color:var(--text-dim)">BOOK</span>`;

  wrap.innerHTML = `
    <div class="f1-results-head">
      <div class="f1-round-strip">
        <span class="f1-round-pill">ALL TIME</span>
        <span class="f1-round-meta">ALL SAVES · ALL SEASONS</span>
      </div>
    </div>

    <h1 class="f1-page-title" id="records-title">${titleHTML(recordsTab)}</h1>

    <div class="f1-filter-strip">
      <button class="f1-filter ${recordsTab === 'book' ? 'active' : ''}" data-rtab="book">Career Records</button>
      <button class="f1-filter ${recordsTab === 'tracks' ? 'active' : ''}" data-rtab="tracks">Track Records</button>
    </div>

    <div id="records-body">${bodyHTML(recordsTab)}</div>
  `;

  const wireBody = () => {
    const bodyEl = $('#records-body', wrap);
    $$('[data-cat]', bodyEl).forEach(tile => tile.onclick = () => openRecordDetail(tile.dataset.cat, recs));
    $$('[data-track]', bodyEl).forEach(tile => tile.onclick = () => openTrackRecordDetail(tile.dataset.track, trackRecs));
  };

  setTimeout(() => {
    wireBody();
    $$('[data-rtab]', wrap).forEach(b => b.onclick = () => {
      recordsTab = b.dataset.rtab;
      $$('[data-rtab]', wrap).forEach(x => x.classList.toggle('active', x === b));
      $('#records-title', wrap).innerHTML = titleHTML(recordsTab);
      $('#records-body', wrap).innerHTML = bodyHTML(recordsTab);
      wireBody();
    });
  }, 0);
  return wrap;
}

// The career "Record Book" grid (drivers + teams across all seasons).
function recordBookGridHTML(recs) {
  return `<div class="records-grid">
      ${RECORD_CATEGORIES.map(cat => {
        const pool = cat.scope === 'drivers' ? recs.drivers : recs.teams;
        const sorted = pool.slice().sort((a,b) => (b[cat.key] || 0) - (a[cat.key] || 0)).filter(x => (x[cat.key] || 0) > 0);
        const leader = sorted[0];
        const top5 = sorted.slice(0, 5);
        const others = top5.slice(1);
        let portraitHTML = '';
        if (leader) {
          if (cat.scope === 'drivers') {
            portraitHTML = leader.photo
              ? `<div class="record-portrait" style="background-image:url('${esc(leader.photo)}')"></div>`
              : `<div class="record-portrait"></div>`;
          } else {
            portraitHTML = leader.logo
              ? `<div class="record-portrait record-portrait-team" style="background-image:url('${esc(leader.logo)}')"></div>`
              : `<div class="record-portrait record-portrait-team">${esc((leader.name || '?').slice(0, 3).toUpperCase())}</div>`;
          }
        }
        const miniPortrait = (h) => {
          if (cat.scope === 'drivers') {
            return h.photo
              ? `<div class="record-mini-portrait" style="background-image:url('${esc(h.photo)}')"></div>`
              : `<div class="record-mini-portrait"></div>`;
          }
          return h.logo
            ? `<div class="record-mini-portrait record-mini-portrait-team" style="background-image:url('${esc(h.logo)}')"></div>`
            : `<div class="record-mini-portrait record-mini-portrait-team">${esc((h.name || '?').slice(0, 2).toUpperCase())}</div>`;
        };
        const rankClass = (i) => i === 1 ? 'silver' : i === 2 ? 'bronze' : '';
        return `
          <div class="record-tile ${leader ? '' : 'record-tile-empty-state'}" data-cat="${cat.id}">
            <div class="record-tile-head">
              <span class="record-tile-icon" aria-hidden="true">${cat.scope === 'drivers' ? '👤' : '🏎'}</span>
              <span class="record-tile-label">${esc(cat.label)}</span>
            </div>
            ${leader ? `
              <div class="record-tile-body">
                ${portraitHTML}
                <div class="record-tile-leader-text">
                  <div class="record-tile-value">
                    <span class="record-tile-value-num">${leader[cat.key]}</span>
                    <span class="record-tile-value-unit">${esc(cat.unit)}</span>
                  </div>
                  <div class="record-tile-leader">${esc(leader.name)}</div>
                </div>
              </div>
              ${others.length ? `
                <div class="record-tile-top5">
                  ${others.map((h, idx) => `
                    <div class="record-tile-top5-row ${rankClass(idx + 1)}">
                      <span class="record-tile-top5-rank">${idx + 2}</span>
                      ${miniPortrait(h)}
                      <span class="record-tile-top5-name">${esc(h.name)}</span>
                      <span class="record-tile-top5-val">${h[cat.key]}</span>
                    </div>
                  `).join('')}
                </div>` : ''}
              <div class="record-tile-cta">VIEW FULL LEADERBOARD →</div>` : `
              <div class="record-tile-empty-block">
                <div class="record-tile-empty-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/></svg>
                </div>
                <div class="record-tile-empty-msg">No record set</div>
                <div class="record-tile-empty-sub">Complete some races to claim this record.</div>
              </div>`}
          </div>`;
      }).join('')}
    </div>`;
}

// The per-circuit "Track Records" grid — one tile per circuit, each showing
// the all-time wins / poles / fastest-lap leader at that track.
function renderTrackRecordsHTML(trackRecs) {
  if (!trackRecs.length) {
    return `<div class="empty"><div class="empty-headline">NO TRACK DATA</div><div class="empty-sub">Complete some races to build track records.</div></div>`;
  }
  const miniPortrait = (d) => d.photo
    ? `<span class="track-rec-portrait" style="background-image:url('${esc(d.photo)}')"></span>`
    : `<span class="track-rec-portrait"></span>`;
  const statRow = (label, lead) => `
    <div class="track-rec-stat">
      <span class="track-rec-stat-label">${label}</span>
      ${lead ? `
        <span class="track-rec-stat-leader">
          ${miniPortrait(lead)}
          <span class="track-rec-stat-name">${esc(lead.name)}</span>
        </span>
        <span class="track-rec-stat-val">${lead.val}</span>`
      : `<span class="track-rec-stat-name track-rec-stat-empty">—</span><span class="track-rec-stat-val zero">0</span>`}
    </div>`;
  return `<div class="records-grid track-records-grid">
      ${trackRecs.map(t => {
        const winLead  = leaderOf(t.drivers, 'wins');
        const poleLead = leaderOf(t.drivers, 'poles');
        const flLead   = leaderOf(t.drivers, 'fastestLaps');
        const flagHTML = raceFlagHTML({ country: t.country, flagImage: t.flagImage }, 24);
        return `
          <div class="track-rec-tile" data-track="${esc(t.key)}">
            <div class="track-rec-head">
              <span class="track-rec-flag">${flagHTML}</span>
              <div class="track-rec-titlewrap">
                <div class="track-rec-name">${esc(t.name)}</div>
                <div class="track-rec-sub">${t.count} EDITION${t.count === 1 ? '' : 'S'}</div>
              </div>
            </div>
            <div class="track-rec-stats">
              ${statRow('WINS', winLead)}
              ${statRow('POLES', poleLead)}
              ${statRow('FASTEST LAP', flLead)}
            </div>
            <div class="record-tile-cta">VIEW TRACK HISTORY →</div>
          </div>`;
      }).join('')}
    </div>`;
}

// Full per-track breakdown — ranked leaderboards for wins/poles/FL/podiums.
function openTrackRecordDetail(trackKey, trackRecs) {
  const t = trackRecs.find(x => x.key === trackKey); if (!t) return;
  const sections = [
    { key: 'wins',        label: 'Most Wins' },
    { key: 'poles',       label: 'Most Poles' },
    { key: 'fastestLaps', label: 'Fastest Laps' },
    { key: 'podiums',     label: 'Most Podiums' },
  ];
  const listFor = (key) => {
    const sorted = t.drivers.slice().filter(d => (d[key] || 0) > 0).sort((a,b) => (b[key] || 0) - (a[key] || 0));
    if (!sorted.length) return `<div class="empty"><div class="empty-headline">NO DATA</div><div class="empty-sub">No driver has registered this at ${esc(t.name)} yet.</div></div>`;
    return `<div class="record-detail-list">
      ${sorted.map((r, i) => {
        const rankClass = i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : '';
        const accent = r.color || '#3a3a4a';
        const initials = r.name.split(/\s+/).map(s => s[0] || '').join('').slice(0, 2).toUpperCase();
        const portraitHTML = r.photo
          ? `<div class="record-detail-portrait" style="background-image:url('${esc(r.photo)}');border-color:${accent}"></div>`
          : `<div class="record-detail-portrait" style="border-color:${accent};color:${accent}">${esc(initials)}</div>`;
        const meta = [
          r.starts ? `${r.starts} start${r.starts === 1 ? '' : 's'}` : null,
          r.country ? `${flag(r.country)} ${r.country}` : null,
        ].filter(Boolean).join(' · ');
        return `<div class="record-detail-row">
          <div class="record-detail-rank ${rankClass}">${i + 1}</div>
          ${portraitHTML}
          <div>
            <div class="record-detail-name">${esc(r.name)}</div>
            <div class="record-detail-meta">${esc(meta || '—')}</div>
          </div>
          <div class="record-detail-value">${r[key]}</div>
        </div>`;
      }).join('')}
    </div>`;
  };

  modal({
    title: `${esc(t.name)} <span class="accent">· TRACK HISTORY</span>`,
    size: 'wide',
    body: `
      <div class="track-detail-meta">
        ${raceFlagHTML({ country: t.country, flagImage: t.flagImage }, 22)}
        <span>${esc(t.fullName || t.name)}</span>
        ${t.circuit ? `<span class="track-detail-chip">${esc(t.circuit)}</span>` : ''}
        <span class="track-detail-chip">${t.count} EDITION${t.count === 1 ? '' : 'S'}</span>
      </div>
      <div class="f1-filter-strip" id="track-detail-tabs">
        ${sections.map((s, i) => `<button class="f1-filter ${i === 0 ? 'active' : ''}" data-tsec="${s.key}">${s.label}</button>`).join('')}
      </div>
      <div id="track-detail-body">${listFor('wins')}</div>
    `,
    footer: `<span style="font-family:var(--f-mono);font-size:10px;color:var(--text-muted);letter-spacing:0.1em;margin-right:auto">${t.drivers.length} DRIVERS</span><button class="btn btn-ghost" data-act="cancel">Close</button>`,
    onMount: (root, close) => {
      $('[data-act="cancel"]', root).onclick = close;
      $$('[data-tsec]', root).forEach(b => b.onclick = () => {
        $$('[data-tsec]', root).forEach(x => x.classList.toggle('active', x === b));
        $('#track-detail-body', root).innerHTML = listFor(b.dataset.tsec);
      });
    }
  });
}

function openRecordDetail(catId, recs) {
  const cat = RECORD_CATEGORIES.find(c => c.id === catId); if (!cat) return;
  const pool = cat.scope === 'drivers' ? recs.drivers : recs.teams;
  const sorted = pool.slice().sort((a,b) => (b[cat.key] || 0) - (a[cat.key] || 0)).filter(x => (x[cat.key] || 0) > 0);

  modal({
    title: `${esc(cat.label)} <span class="accent">· FULL LIST</span>`,
    size: 'wide',
    body: sorted.length ? `
      <div class="record-detail-list">
        ${sorted.map((r, i) => {
          const rankClass = i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : '';
          const meta = cat.scope === 'drivers'
            ? [r.starts ? `${r.starts} starts` : null, r.championships ? `${r.championships}× champion` : null, r.latestCountry ? `${flag(r.latestCountry)} ${r.latestCountry}` : null].filter(Boolean).join(' · ')
            : [r.championships ? `${r.championships}× champion` : null, r.podiums ? `${r.podiums} podiums` : null, r.latestCountry ? `${flag(r.latestCountry)} ${r.latestCountry}` : null].filter(Boolean).join(' · ');
          const accent = cat.scope === 'drivers' ? (r.latestTeamColor || '#3a3a4a') : (r.latestColor || '#3a3a4a');
          let portraitHTML;
          if (cat.scope === 'drivers') {
            const initials = r.name.split(/\s+/).map(s => s[0] || '').join('').slice(0, 2).toUpperCase();
            portraitHTML = r.photo
              ? `<div class="record-detail-portrait" style="background-image:url('${esc(r.photo)}');border-color:${accent}"></div>`
              : `<div class="record-detail-portrait" style="border-color:${accent};color:${accent}">${esc(initials)}</div>`;
          } else {
            portraitHTML = r.logo
              ? `<div class="record-detail-portrait" style="background-image:url('${esc(r.logo)}');border-color:${accent}"></div>`
              : `<div class="record-detail-portrait" style="border-color:${accent};color:${accent}">${esc(r.name.slice(0,3).toUpperCase())}</div>`;
          }
          return `<div class="record-detail-row">
            <div class="record-detail-rank ${rankClass}">${i+1}</div>
            ${portraitHTML}
            <div>
              <div class="record-detail-name">${esc(r.name)}</div>
              <div class="record-detail-meta">${esc(meta || '—')}</div>
            </div>
            <div class="record-detail-value">${r[cat.key]}</div>
          </div>`;
        }).join('')}
      </div>
    ` : `<div class="empty"><div class="empty-headline">NO DATA</div><div class="empty-sub">Run some races to populate this record.</div></div>`,
    footer: `<span style="font-family:var(--f-mono);font-size:10px;color:var(--text-muted);letter-spacing:0.1em;margin-right:auto">${sorted.length} ${cat.scope.toUpperCase()} RANKED</span><button class="btn btn-ghost" data-act="cancel">Close</button>`,
    onMount: (root, close) => { $('[data-act="cancel"]', root).onclick = close; }
  });
}

/* ---------- modals: new save / season / rename ---------- */

/* ---------- modal: share (collaboration invite + member management + public link) ---------- */
function openShareModal() {
  if (!state.activeSaveId) return;
  const save = state.saves[state.activeSaveId];
  const isOwner = (save._members?.length
    ? save._members.some(m => m.user_id === currentUser?.id && m.role === 'owner')
    : (cloudSaveIds.has(save.id) && !!currentUser));

  let inviteRole = 'editor';   // current selection for the next invite
  let publicSlug = null;        // populated on mount via cloudGetPublicShareSlug

  modal({
    title: `<span class="accent">Share</span> ${esc(save.name)}`,
    size: 'wide',
    body: `
      <div class="field-help" style="margin-bottom:18px">
        Invite a friend to collaborate on this save. Editors can change everything; viewers can see but not edit.
      </div>
      ${isOwner ? `
      <div class="share-section">
        <div class="share-section-head">INVITE A NEW MEMBER</div>
        <div class="share-invite-row">
          <div class="share-role-toggle">
            <button class="btn btn-ghost btn-sm" data-role="editor">EDITOR</button>
            <button class="btn btn-ghost btn-sm" data-role="viewer">VIEWER</button>
          </div>
          <button class="btn btn-primary" data-act="gen">✦ GENERATE INVITE LINK</button>
        </div>
        <div class="share-link-row" id="share-link-row" style="display:none">
          <label>Send this link to your collaborator:</label>
          <div class="share-link-box">
            <input type="text" id="share-link-input" readonly>
            <button class="btn btn-primary btn-sm" id="share-copy">COPY</button>
          </div>
          <div class="field-help">Link expires in 7 days. One-time use.</div>
        </div>
      </div>` : ''}

      <div class="share-section">
        <div class="share-section-head">CURRENT MEMBERS · <span id="member-count">${(save._members || []).length}</span></div>
        <div class="members-list" id="members-list"></div>
      </div>

      ${isOwner ? `
      <div class="share-section">
        <div class="share-section-head">PUBLIC READ-ONLY LINK</div>
        <div class="field-help" style="margin-bottom:10px">Anyone with the link can view this save as a webpage. They cannot edit. Useful for showing off your fictional season.</div>
        <div id="public-link-area">
          <div class="loading-row">Checking…</div>
        </div>
      </div>` : ''}
    `,
    footer: `<button class="btn btn-ghost" data-act="cancel">Done</button>`,
    onMount: async (root, close) => {
      $('[data-act="cancel"]', root).onclick = close;

      // Role toggle
      const updateRoleButtons = () => {
        $$('.share-role-toggle button', root).forEach(b => {
          b.classList.toggle('active', b.dataset.role === inviteRole);
        });
      };
      $$('.share-role-toggle button', root).forEach(b => {
        b.onclick = () => { inviteRole = b.dataset.role; updateRoleButtons(); };
      });
      updateRoleButtons();

      // Members list rendering
      const renderMembers = () => {
        const list = $('#members-list', root);
        const members = save._members || [];
        $('#member-count', root).textContent = members.length;
        if (!members.length) {
          list.innerHTML = `<div class="empty-row">No members yet.</div>`;
          return;
        }
        list.innerHTML = members.map(m => {
          const isYou = m.user_id === currentUser?.id;
          const isThisMemberOwner = m.role === 'owner';
          const canKick = isOwner && !isThisMemberOwner;
          const canChangeRole = isOwner && !isThisMemberOwner;
          return `
            <div class="member-row" data-uid="${esc(m.user_id)}">
              <span class="member-name">${isYou ? 'You' : (m.user_id.slice(0,8) + '…')}</span>
              ${canChangeRole ? `
                <select class="member-role-select" data-uid="${esc(m.user_id)}">
                  <option value="editor" ${m.role === 'editor' ? 'selected' : ''}>EDITOR</option>
                  <option value="viewer" ${m.role === 'viewer' ? 'selected' : ''}>VIEWER</option>
                </select>` : `<span class="member-role role-${esc(m.role)}">${esc(m.role.toUpperCase())}</span>`}
              ${canKick ? `<button class="btn-icon-x" data-act="kick" data-uid="${esc(m.user_id)}" title="Remove">×</button>` : ''}
            </div>`;
        }).join('');

        // Wire kick + role-change handlers
        $$('[data-act="kick"]', list).forEach(b => {
          b.onclick = async () => {
            if (!confirm('Remove this collaborator from the save?')) return;
            try {
              await cloudRemoveMember(save.id, b.dataset.uid);
              toast('Member removed', 'success');
              renderMembers();
            } catch (e) { toast('Failed: ' + e.message, 'error'); }
          };
        });
        $$('.member-role-select', list).forEach(s => {
          s.onchange = async () => {
            try {
              await cloudUpdateMemberRole(save.id, s.dataset.uid, s.value);
              toast(`Role set to ${s.value}`, 'success');
            } catch (e) {
              toast('Failed: ' + e.message, 'error');
              renderMembers();
            }
          };
        });
      };
      renderMembers();

      // Generate invite link
      const gen = $('[data-act="gen"]', root);
      if (gen) gen.onclick = async () => {
        try {
          gen.disabled = true; gen.textContent = 'Generating…';
          const url = await cloudInvite(state.activeSaveId, inviteRole);
          $('#share-link-row', root).style.display = 'block';
          const inp = $('#share-link-input', root);
          inp.value = url;
          inp.select();
          $('#share-copy', root).onclick = async () => {
            try { await navigator.clipboard.writeText(url); toast('Link copied', 'success'); }
            catch { inp.select(); document.execCommand('copy'); toast('Link copied', 'success'); }
          };
        } catch (err) {
          toast('Could not generate link: ' + err.message, 'error');
        } finally {
          gen.disabled = false; gen.textContent = '✦ GENERATE INVITE LINK';
        }
      };

      // Public share link (owner-only)
      if (isOwner) {
        publicSlug = await cloudGetPublicShareSlug(save.id);
        const renderPublic = () => {
          const area = $('#public-link-area', root);
          if (publicSlug) {
            const url = `${window.location.origin}${window.location.pathname}?view=${publicSlug}`;
            area.innerHTML = `
              <div class="share-link-box">
                <input type="text" readonly value="${esc(url)}">
                <button class="btn btn-ghost btn-sm" data-act="copy-public">COPY</button>
                <button class="btn btn-ghost btn-sm" data-act="disable-public" style="color:var(--red)">DISABLE</button>
              </div>`;
            $('[data-act="copy-public"]', area).onclick = async () => {
              try { await navigator.clipboard.writeText(url); toast('Public link copied', 'success'); } catch {}
            };
            $('[data-act="disable-public"]', area).onclick = async () => {
              if (!confirm('Disable the public link? The current URL will stop working.')) return;
              try {
                await cloudDisablePublicShare(save.id);
                publicSlug = null;
                renderPublic();
                toast('Public link disabled', 'success');
              } catch (e) { toast('Failed: ' + e.message, 'error'); }
            };
          } else {
            area.innerHTML = `<button class="btn btn-ghost" data-act="enable-public">⚡ ENABLE PUBLIC VIEW</button>`;
            $('[data-act="enable-public"]', area).onclick = async () => {
              try {
                const url = await cloudEnablePublicShare(save.id);
                publicSlug = url.split('?view=')[1];
                renderPublic();
                toast('Public link enabled', 'success');
              } catch (e) { toast('Failed: ' + e.message, 'error'); }
            };
          }
        };
        renderPublic();
      }
    },
  });
}

/* ---------- modal: account / sign out ---------- */
/* =====================================================
   STORAGE ANALYSIS & COMPACTION
   Helps users see what's using space and clean up bloat before
   hitting Supabase free-tier limits.
   ===================================================== */
function analyzeStorageUsage() {
  // Walk every save, measure photo/logo/flag payloads, count rows
  const stats = {
    savesCount: 0,
    seasonsCount: 0,
    driversCount: 0,
    teamsCount: 0,
    racesCount: 0,
    resultsCount: 0,
    photoCount: 0,
    photoBytes: 0,
    logoCount: 0,
    logoBytes: 0,
    flagCount: 0,
    flagBytes: 0,
    totalBytes: 0,
    overSizedPhotos: [], // { saveName, driverName, currentSize }
    overSizedLogos: [],  // { saveName, teamName, currentSize }
  };
  // Approximate: a base64 string's `length` ≈ the bytes it occupies.
  const byteLen = (s) => typeof s === 'string' ? s.length : 0;
  for (const save of Object.values(state.saves || {})) {
    stats.savesCount++;
    for (const season of Object.values(save.seasons || {})) {
      stats.seasonsCount++;
      for (const d of season.drivers || []) {
        stats.driversCount++;
        if (d.photo) {
          stats.photoCount++;
          const sz = byteLen(d.photo);
          stats.photoBytes += sz;
          if (sz > IMAGE_HARD_CAP) stats.overSizedPhotos.push({ saveName: save.name, driverName: d.name, currentSize: sz, ref: d });
        }
      }
      for (const t of season.teams || []) {
        stats.teamsCount++;
        if (t.logo) {
          stats.logoCount++;
          const sz = byteLen(t.logo);
          stats.logoBytes += sz;
          if (sz > IMAGE_HARD_CAP) stats.overSizedLogos.push({ saveName: save.name, teamName: t.name, currentSize: sz, ref: t });
        }
      }
      for (const r of season.races || []) {
        stats.racesCount++;
        if (r.flagImage) {
          stats.flagCount++;
          stats.flagBytes += byteLen(r.flagImage);
        }
        stats.resultsCount += (r.results?.length || 0) + (r.sprintResults?.length || 0);
      }
    }
  }
  stats.totalBytes = stats.photoBytes + stats.logoBytes + stats.flagBytes;
  return stats;
}

// Compact: re-compress every photo/logo/flag that exceeds the current hard cap.
// Uses an off-DOM canvas. Returns a promise that resolves with a stats summary.
async function compactSaveStorage() {
  const before = analyzeStorageUsage();
  const oversized = [
    ...before.overSizedPhotos.map(x => ({ kind: 'photo', ...x })),
    ...before.overSizedLogos.map(x => ({ kind: 'logo', ...x })),
  ];
  if (!oversized.length) {
    return { before, after: before, compacted: 0, saved: 0 };
  }
  // Re-encode each over-cap image
  let compacted = 0;
  for (const item of oversized) {
    const original = item.ref[item.kind === 'photo' ? 'photo' : 'logo'];
    try {
      const recompressed = await recompressDataUrl(original);
      if (recompressed && recompressed.length < original.length) {
        item.ref[item.kind === 'photo' ? 'photo' : 'logo'] = recompressed;
        compacted++;
      }
    } catch (e) {
      console.warn('[P1] failed to recompress image', e);
    }
  }
  saveState();
  const after = analyzeStorageUsage();
  return { before, after, compacted, saved: before.totalBytes - after.totalBytes };
}

function recompressDataUrl(dataUrl) {
  return new Promise((resolve, reject) => {
    if (!dataUrl || !dataUrl.startsWith('data:image')) return resolve(dataUrl);
    const img = new Image();
    img.onload = () => {
      let dim = 200, q = 0.7, result = encodeAtDim(img, dim, q);
      let i = 0;
      while (result.length > IMAGE_HARD_CAP && i < 6) {
        i++;
        dim = Math.round(dim * 0.85);
        q = Math.max(0.35, q - 0.08);
        result = encodeAtDim(img, dim, q);
      }
      resolve(result);
    };
    img.onerror = () => reject(new Error('Could not re-decode image'));
    img.src = dataUrl;
  });
}

const fmtBytes = (n) => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
};

function openAccountModal() {
  // Pre-compute storage stats so they show on open
  const stats = analyzeStorageUsage();
  // Soft budget — what we'd consider "comfortable" before hitting Supabase pain
  const COMFY_BUDGET = 50 * 1024 * 1024; // 50MB
  const pct = Math.min(100, Math.round(stats.totalBytes / COMFY_BUDGET * 100));
  const barColor = pct < 50 ? 'var(--green, #10b981)' : pct < 80 ? '#f59e0b' : 'var(--red)';
  const hasOversized = (stats.overSizedPhotos.length + stats.overSizedLogos.length) > 0;

  modal({
    title: `<span class="accent">Account</span>`,
    size: 'wide',
    body: `
      <div class="account-info">
        <div class="account-row"><span class="lbl">Signed in as</span><span class="val">${esc(currentUser?.email || '—')}</span></div>
        <div class="account-row"><span class="lbl">User ID</span><span class="val mono">${esc(currentUser?.id?.slice(0, 18) + '…' || '—')}</span></div>
        <div class="account-row"><span class="lbl">Cloud sync</span><span class="val accent">● ACTIVE</span></div>
      </div>

      <div class="share-section" style="margin-top:24px">
        <div class="share-section-head">STORAGE USAGE</div>
        <div class="storage-summary">
          <div class="storage-meter">
            <div class="storage-bar" style="width:${pct}%;background:${barColor}"></div>
          </div>
          <div class="storage-amount">
            <span class="storage-used">${fmtBytes(stats.totalBytes)}</span>
            <span class="storage-budget">/ ${fmtBytes(COMFY_BUDGET)} comfortable budget</span>
          </div>
        </div>

        <div class="storage-breakdown">
          <div class="storage-cat">
            <div class="storage-cat-label">DRIVER PHOTOS</div>
            <div class="storage-cat-val">${stats.photoCount} · ${fmtBytes(stats.photoBytes)}</div>
          </div>
          <div class="storage-cat">
            <div class="storage-cat-label">TEAM LOGOS</div>
            <div class="storage-cat-val">${stats.logoCount} · ${fmtBytes(stats.logoBytes)}</div>
          </div>
          <div class="storage-cat">
            <div class="storage-cat-label">TRACK FLAGS</div>
            <div class="storage-cat-val">${stats.flagCount} · ${fmtBytes(stats.flagBytes)}</div>
          </div>
        </div>

        <div class="storage-rows">
          <div class="storage-row">
            <span class="lbl">Saves</span><span class="val">${stats.savesCount}</span>
          </div>
          <div class="storage-row">
            <span class="lbl">Seasons</span><span class="val">${stats.seasonsCount}</span>
          </div>
          <div class="storage-row">
            <span class="lbl">Drivers · Teams · Races</span><span class="val">${stats.driversCount} · ${stats.teamsCount} · ${stats.racesCount}</span>
          </div>
          <div class="storage-row">
            <span class="lbl">Result rows</span><span class="val">${stats.resultsCount}</span>
          </div>
        </div>

        ${hasOversized ? `
          <div class="storage-warning">
            <div class="storage-warning-head">⚠ ${stats.overSizedPhotos.length + stats.overSizedLogos.length} oversized image(s) detected</div>
            <div class="storage-warning-body">These were uploaded before image compression was tightened. Run COMPACT to re-compress them and save approximately ${fmtBytes(estimateCompactSavings(stats))}.</div>
            <button class="btn btn-primary btn-sm" id="btn-compact" style="margin-top:10px">⚡ COMPACT NOW</button>
          </div>
        ` : `
          <div class="storage-ok">✓ All images within size targets</div>
        `}

        <div class="field-help" style="margin-top:14px;font-size:11px">
          Saves sync to Supabase Postgres. Photos consume the most space — each new upload is auto-compressed to under ${fmtBytes(IMAGE_HARD_CAP)}.
        </div>
      </div>

      <div class="field-help" style="margin-top:14px">
        Signing out clears local cached data but your cloud saves stay intact.
      </div>`,
    footer: `<button class="btn btn-ghost" data-act="cancel">Close</button><button class="btn btn-ghost" data-act="signout" style="color:var(--red)">SIGN OUT</button>`,
    onMount: (root, close) => {
      $('[data-act="cancel"]', root).onclick = close;
      $('[data-act="signout"]', root).onclick = async () => {
        if (!confirm('Sign out of P1?')) return;
        await cloudSignOut();
      };
      const compactBtn = $('#btn-compact', root);
      if (compactBtn) compactBtn.onclick = async () => {
        compactBtn.disabled = true; compactBtn.textContent = 'Compacting…';
        try {
          const r = await compactSaveStorage();
          toast(`Compacted ${r.compacted} image(s) — saved ${fmtBytes(r.saved)}`, 'success');
          close();
          openAccountModal(); // re-open with fresh stats
        } catch (e) {
          compactBtn.disabled = false; compactBtn.textContent = '⚡ COMPACT NOW';
          toast('Compact failed: ' + e.message, 'error');
        }
      };
    },
  });
}
function estimateCompactSavings(stats) {
  // Each oversized image currently averages roughly photoBytes/photoCount but
  // could be ~30KB after compression. Conservative estimate.
  const oversizedCount = stats.overSizedPhotos.length + stats.overSizedLogos.length;
  if (!oversizedCount) return 0;
  let oversizedBytes = 0;
  stats.overSizedPhotos.forEach(p => { oversizedBytes += p.currentSize; });
  stats.overSizedLogos.forEach(p => { oversizedBytes += p.currentSize; });
  // Assume compaction averages to IMAGE_TARGET per image
  return Math.max(0, oversizedBytes - (oversizedCount * IMAGE_TARGET));
}

function openNewSaveModal() {
  modal({
    title: `<span class="accent">New</span> Save File`,
    body: `
      <div class="field"><label>Save Name</label><input type="text" id="new-save-name" placeholder="e.g. The 2030s Universe" autofocus></div>
      <div class="field-help">A save file holds all your seasons, drivers, teams and records. Create separate saves for parallel universes.</div>`,
    footer: `<button class="btn btn-ghost" data-act="cancel">Cancel</button><button class="btn btn-primary" data-act="ok">Create Save</button>`,
    onMount: (root, close) => {
      const input = $('#new-save-name', root);
      setTimeout(() => input.focus(), 50);
      const submit = () => {
        const name = input.value.trim();
        if (!name) return toast('Save name required', 'error');
        createSave(name); close(); renderAll(); toast('Save created', 'success');
      };
      input.onkeydown = (e) => { if (e.key === 'Enter') submit(); };
      $('[data-act="ok"]', root).onclick = submit;
      $('[data-act="cancel"]', root).onclick = close;
    }
  });
}

function openRenameSaveModal() {
  const save = activeSave(); if (!save) return;
  modal({
    title: 'Rename Save',
    body: `<div class="field"><label>Save Name</label><input type="text" id="rn-name" value="${esc(save.name)}" autofocus></div>`,
    footer: `<button class="btn btn-ghost" data-act="cancel">Cancel</button><button class="btn btn-primary" data-act="ok">Save</button>`,
    onMount: (root, close) => {
      const input = $('#rn-name', root);
      setTimeout(() => input.focus(), 50);
      const submit = () => {
        renameSave(save.id, input.value); close(); renderAll(); toast('Renamed', 'success');
      };
      input.onkeydown = (e) => { if (e.key === 'Enter') submit(); };
      $('[data-act="ok"]', root).onclick = submit;
      $('[data-act="cancel"]', root).onclick = close;
    }
  });
}

function openNewSeasonModal() {
  if (!state.activeSaveId) {
    return toast('Open a save first', 'warn');
  }
  const teamBundles = state.teamClasses || [];
  const driverBundles = state.driverClasses || [];
  const calPresets = state.calendarPresets || [];

  modal({
    title: `<span class="accent">New</span> Season`,
    body: `
      <div class="field-row">
        <div class="field"><label>Year</label><input type="number" id="ns-year" value="${new Date().getFullYear()}"></div>
        <div class="field"><label>Season Name</label><input type="text" id="ns-name" placeholder="e.g. The Comeback"></div>
      </div>
      <div class="field">
        <label>Points System</label>
        <select id="ns-points">
          ${POINTS_SYSTEMS.map(p => `<option value="${p.id}" ${p.id === DEFAULT_POINTS_SYSTEM_ID ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
        </select>
        <span class="field-help">Pick the era. You can change this later in Season Settings.</span>
      </div>
      <div class="divider" style="margin:16px 0"></div>
      <div style="font-family:var(--f-mono);font-size:10px;letter-spacing:0.2em;color:var(--text-dim);text-transform:uppercase;margin-bottom:12px">PRELOADS</div>

      <div class="field">
        <label>Teams</label>
        <select id="ns-team-bundle">
          <option value="default" selected>Default — 10 standard fictional teams</option>
          <option value="">— None — empty paddock</option>
          ${teamBundles.length ? `<optgroup label="Your saved bundles">${teamBundles.map(b => `<option value="${esc(b.id)}">${esc(b.name)} · ${b.teams.length} team${b.teams.length === 1 ? '' : 's'}</option>`).join('')}</optgroup>` : ''}
        </select>
        <span class="field-help">${teamBundles.length ? `${teamBundles.length} saved bundle${teamBundles.length === 1 ? '' : 's'} available.` : 'Save a team bundle from the Constructors tab to reuse it here.'}</span>
      </div>

      <div class="field">
        <label>Drivers</label>
        <select id="ns-driver-bundle">
          <option value="default" selected>Default — sample drivers (paired to default teams)</option>
          <option value="">— None — empty grid</option>
          ${driverBundles.length ? `<optgroup label="Your saved bundles">${driverBundles.map(b => `<option value="${esc(b.id)}">${esc(b.name)} · ${b.drivers.length} driver${b.drivers.length === 1 ? '' : 's'}</option>`).join('')}</optgroup>` : ''}
        </select>
        <span class="field-help">${driverBundles.length ? `${driverBundles.length} saved bundle${driverBundles.length === 1 ? '' : 's'} available. Saved drivers come without team assignments — sign them after.` : 'Save a driver bundle from the Drivers tab to reuse it here.'}</span>
      </div>

      <div class="field" id="ns-driver-count-field">
        <label>Driver count <span style="color:var(--text-dim);font-family:var(--f-body);text-transform:none;letter-spacing:0">(default grid)</span></label>
        <input type="number" id="ns-driver-count" value="20" min="1" max="30" step="1">
        <span class="field-help">How many drivers to put on the grid, up to 30. Spread evenly across your teams. Only applies to the <b>Default</b> driver option — saved bundles use their own roster.</span>
      </div>

      <div class="field">
        <label>Calendar</label>
        <select id="ns-calendar">
          <option value="default" selected>Default — 22-round classic calendar</option>
          <option value="">— None — empty calendar</option>
          ${calPresets.length ? `<optgroup label="Your saved presets">${calPresets.map(p => `<option value="${esc(p.id)}">${esc(p.name)} · ${p.races.length} round${p.races.length === 1 ? '' : 's'}</option>`).join('')}</optgroup>` : ''}
        </select>
        <span class="field-help">${calPresets.length ? `${calPresets.length} saved preset${calPresets.length === 1 ? '' : 's'} available.` : 'Save a calendar preset from the Calendar tab to reuse it here.'}</span>
      </div>

      <div class="divider" style="margin:16px 0"></div>
      <button class="btn btn-ghost" id="ns-import-real" style="width:100%;display:flex;flex-direction:column;gap:2px;padding:14px;align-items:flex-start;text-align:left;margin-bottom:8px">
        <div style="font-weight:700;font-family:var(--f-display);font-size:14px;letter-spacing:0.02em">⇡ IMPORT REAL SEASON FROM F1.COM PASTE</div>
        <div style="font-family:var(--f-mono);font-size:10px;color:var(--text-muted);letter-spacing:0.04em;text-transform:none">Skip the form — paste the full standings table and we'll build the season for you</div>
      </button>
      <button class="btn btn-ghost" id="ns-import-shot" style="width:100%;display:flex;flex-direction:column;gap:2px;padding:14px;align-items:flex-start;text-align:left;margin-bottom:8px">
        <div style="font-weight:700;font-family:var(--f-display);font-size:14px;letter-spacing:0.02em">📷 IMPORT FROM SCREENSHOT (MATRIX MODE)</div>
        <div style="font-family:var(--f-mono);font-size:10px;color:var(--text-muted);letter-spacing:0.04em;text-transform:none">Upload a season-matrix screenshot and fill in a cell grid alongside it — supports pole (P), fastest lap, and sprint subscript points</div>
      </button>
      <button class="btn btn-ghost" id="ns-import-csv" style="width:100%;display:flex;flex-direction:column;gap:2px;padding:14px;align-items:flex-start;text-align:left;border-color:var(--sec-cyan)">
        <div style="font-weight:700;font-family:var(--f-display);font-size:14px;letter-spacing:0.02em;color:var(--sec-cyan)">📊 IMPORT FROM CSV FILE</div>
        <div style="font-family:var(--f-mono);font-size:10px;color:var(--text-muted);letter-spacing:0.04em;text-transform:none">Upload a .csv with columns: Position, Driver, Team, Points, then race columns. Cells support pole (P), sprint (/N), and fastest lap (F).</div>
      </button>`,
    footer: `<button class="btn btn-ghost" data-act="cancel">Cancel</button><button class="btn btn-primary" data-act="ok">Create Season</button>`,
    onMount: (root, close) => {
      const submit = () => {
        const year = $('#ns-year', root).value;
        const name = $('#ns-name', root).value;
        const pointsSystemId = $('#ns-points', root).value;
        const teamBundleId = $('#ns-team-bundle', root).value;
        const driverBundleId = $('#ns-driver-bundle', root).value;
        const calendarPresetId = $('#ns-calendar', root).value;
        const driverCount = $('#ns-driver-count', root).value;
        createSeason({ year, name, pointsSystemId, teamBundleId, driverBundleId, calendarPresetId, driverCount });
        close(); renderAll(); toast('Season opened', 'success');
      };
      $('[data-act="ok"]', root).onclick = submit;
      $('[data-act="cancel"]', root).onclick = close;
      // The driver-count field only matters for the Default grid — dim it when a
      // saved bundle or "None" is chosen so it's clear it won't apply.
      const driverSel = $('#ns-driver-bundle', root);
      const countField = $('#ns-driver-count-field', root);
      const syncCountField = () => {
        const isDefault = driverSel.value === 'default';
        countField.style.opacity = isDefault ? '' : '0.4';
        $('#ns-driver-count', root).disabled = !isDefault;
      };
      driverSel.onchange = syncCountField;
      syncCountField();
      $('#ns-import-real', root).onclick = () => { close(); openImportRealSeasonModal(); };
      $('#ns-import-shot', root).onclick = () => { close(); openImportScreenshotModal(); };
      $('#ns-import-csv', root).onclick = () => { close(); openImportCSVModal(); };
      setTimeout(() => $('#ns-name', root).focus(), 50);
    }
  });
}

/* =====================================================
   F1.COM PASTE IMPORTER (feature: full-season import)
   ====================================================== */

// Race-code → race metadata. Covers every F1.com / Wikipedia 3-letter abbreviation
// I've seen in active rotation. Unknown codes still import as "{CODE} Grand Prix".
// NOTE: this is the LEGACY hardcoded map kept only as a final fallback. The real
// source of truth is now matchTrackPresetForCode() below, which consults the
// TRACK_PRESETS library and any user-saved custom track presets.
const F1_RACE_CODE_MAP = {
  BHR: { name: 'Bahrain Grand Prix',         circuit: 'Bahrain International', country: 'BHR' },
  SAU: { name: 'Saudi Arabian Grand Prix',   circuit: 'Jeddah Corniche',       country: 'KSA' },
  KSA: { name: 'Saudi Arabian Grand Prix',   circuit: 'Jeddah Corniche',       country: 'KSA' },
  AUS: { name: 'Australian Grand Prix',      circuit: 'Albert Park',           country: 'AUS' },
  CHN: { name: 'Chinese Grand Prix',         circuit: 'Shanghai International',country: 'CHN' },
  AZE: { name: 'Azerbaijan Grand Prix',      circuit: 'Baku City Circuit',     country: 'AZE' },
  MIA: { name: 'Miami Grand Prix',           circuit: 'Miami International',   country: 'USA', sprint: false },
  EMI: { name: 'Emilia-Romagna Grand Prix',  circuit: 'Imola',                 country: 'ITA' },
  IMO: { name: 'Emilia-Romagna Grand Prix',  circuit: 'Imola',                 country: 'ITA' },
  MON: { name: 'Monaco Grand Prix',          circuit: 'Circuit de Monaco',     country: 'MCO' },
  MCO: { name: 'Monaco Grand Prix',          circuit: 'Circuit de Monaco',     country: 'MCO' },
  ESP: { name: 'Spanish Grand Prix',         circuit: 'Catalunya',             country: 'ESP' },
  CAN: { name: 'Canadian Grand Prix',        circuit: 'Gilles Villeneuve',     country: 'CAN' },
  AUT: { name: 'Austrian Grand Prix',        circuit: 'Red Bull Ring',         country: 'AUT' },
  GBR: { name: 'British Grand Prix',         circuit: 'Silverstone',           country: 'GBR' },
  HUN: { name: 'Hungarian Grand Prix',       circuit: 'Hungaroring',           country: 'HUN' },
  BEL: { name: 'Belgian Grand Prix',         circuit: 'Spa-Francorchamps',     country: 'BEL' },
  NED: { name: 'Dutch Grand Prix',           circuit: 'Zandvoort',             country: 'NED' },
  NLD: { name: 'Dutch Grand Prix',           circuit: 'Zandvoort',             country: 'NED' },
  ITA: { name: 'Italian Grand Prix',         circuit: 'Monza',                 country: 'ITA' },
  SIN: { name: 'Singapore Grand Prix',       circuit: 'Marina Bay',            country: 'SGP' },
  SGP: { name: 'Singapore Grand Prix',       circuit: 'Marina Bay',            country: 'SGP' },
  JPN: { name: 'Japanese Grand Prix',        circuit: 'Suzuka',                country: 'JPN' },
  QAT: { name: 'Qatar Grand Prix',           circuit: 'Lusail International',  country: 'QAT' },
  USA: { name: 'United States Grand Prix',   circuit: 'Circuit of the Americas', country: 'USA' },
  COTA:{ name: 'United States Grand Prix',   circuit: 'Circuit of the Americas', country: 'USA' },
  MXC: { name: 'Mexico City Grand Prix',     circuit: 'Hermanos Rodriguez',    country: 'MEX' },
  MEX: { name: 'Mexico City Grand Prix',     circuit: 'Hermanos Rodriguez',    country: 'MEX' },
  SAP: { name: 'São Paulo Grand Prix',       circuit: 'Interlagos',            country: 'BRA' },
  BRA: { name: 'São Paulo Grand Prix',       circuit: 'Interlagos',            country: 'BRA' },
  LVG: { name: 'Las Vegas Grand Prix',       circuit: 'Las Vegas Strip',       country: 'USA' },
  LAS: { name: 'Las Vegas Grand Prix',       circuit: 'Las Vegas Strip',       country: 'USA' },
  ABU: { name: 'Abu Dhabi Grand Prix',       circuit: 'Yas Marina',            country: 'UAE' },
  UAE: { name: 'Abu Dhabi Grand Prix',       circuit: 'Yas Marina',            country: 'UAE' },
  FRA: { name: 'French Grand Prix',          circuit: 'Paul Ricard',           country: 'FRA' },
  GER: { name: 'German Grand Prix',          circuit: 'Hockenheim',            country: 'GER' },
  DEU: { name: 'German Grand Prix',          circuit: 'Hockenheim',            country: 'GER' },
  RUS: { name: 'Russian Grand Prix',         circuit: 'Sochi Autodrom',        country: 'RUS' },
  TUR: { name: 'Turkish Grand Prix',         circuit: 'Istanbul Park',         country: 'TUR' },
  POR: { name: 'Portuguese Grand Prix',      circuit: 'Algarve',               country: 'POR' },
};

// Maps F1.com pasted codes to track-preset matching hints. Each entry says:
//   - "country" — the country code to look up in TRACK_PRESETS
//   - "circuitContains" — a substring of the canonical circuit name (used to
//     disambiguate when one country has multiple tracks, e.g. USA has Miami,
//     Austin, and Las Vegas).
const F1_CODE_TO_TRACK_HINT = {
  BHR:  { country: 'BHR' },
  SAU:  { country: 'KSA' },                                   // F1 uses SAU, presets use KSA
  KSA:  { country: 'KSA' },
  AUS:  { country: 'AUS' },
  CHN:  { country: 'CHN' },
  AZE:  { country: 'AZE' },
  MIA:  { country: 'USA', circuitContains: 'Miami' },
  EMI:  { country: 'ITA', circuitContains: 'Imola' },
  IMO:  { country: 'ITA', circuitContains: 'Imola' },
  MON:  { country: 'MCO' },                                   // F1 uses MON, presets use MCO
  MCO:  { country: 'MCO' },
  ESP:  { country: 'ESP', circuitContains: 'Catalunya' },     // ESP also has Valencia historically
  CAN:  { country: 'CAN' },
  AUT:  { country: 'AUT' },
  GBR:  { country: 'GBR' },
  HUN:  { country: 'HUN' },
  BEL:  { country: 'BEL' },
  NED:  { country: 'NED' },
  NLD:  { country: 'NED' },
  ITA:  { country: 'ITA', circuitContains: 'Monza' },         // ITA has Monza AND Imola
  SIN:  { country: 'SGP' },                                   // F1 uses SIN, presets use SGP
  SGP:  { country: 'SGP' },
  JPN:  { country: 'JPN' },
  QAT:  { country: 'QAT' },
  USA:  { country: 'USA', circuitContains: 'Americas' },      // F1 USA = Austin (COTA)
  COTA: { country: 'USA', circuitContains: 'Americas' },
  MXC:  { country: 'MEX' },
  MEX:  { country: 'MEX' },
  SAP:  { country: 'BRA' },                                   // F1 uses SAP for São Paulo
  BRA:  { country: 'BRA' },
  LVG:  { country: 'USA', circuitContains: 'Vegas' },         // disambiguate vs Miami/Austin
  LAS:  { country: 'USA', circuitContains: 'Vegas' },
  ABU:  { country: 'UAE' },
  UAE:  { country: 'UAE' },
  FRA:  { country: 'FRA' },
  GER:  { country: 'GER' },
  DEU:  { country: 'GER' },
  RUS:  { country: 'RUS' },
  TUR:  { country: 'TUR' },
  POR:  { country: 'POR' },
};

// Find a track preset (built-in or custom) that matches a pasted F1 race code.
// Returns { name, circuit, country, length?, sprint?, source } or null if no match.
// Priority:
//   1. User's customTrackPresets (so user overrides always win)
//   2. Built-in TRACK_PRESETS
// Both sources are matched by country + optional circuitContains.
function matchTrackPresetForCode(code) {
  const codeKey = (code || '').toUpperCase().trim();
  if (!codeKey) return null;

  // Get the EFFECTIVE preset list — this includes:
  //   - User customs (state.customTrackPresets)
  //   - Built-in TRACK_PRESETS, with any user overrides from state.presetOverrides.tracks merged on top
  // This is the same data the user sees in the track preset library, so the
  // matcher and the library stay in sync.
  const effective = getEffectiveTrackPresets();

  // Pre-compute the disambiguation hint (if any). Hints tell us which preset
  // to pick when one country has multiple tracks (USA = Miami/Austin/Vegas,
  // ITA = Monza/Imola, ESP = Catalunya/Valencia, etc.).
  const hint = F1_CODE_TO_TRACK_HINT[codeKey];

  // Helper: pick the best preset from a list of candidates that all share the
  // same country code. Uses circuitContains hint to disambiguate, then prefers
  // user customs, then Current era.
  const pickBest = (candidates) => {
    if (!candidates.length) return null;
    let pool = candidates;
    if (hint?.circuitContains) {
      const matched = candidates.filter(p =>
        (p.circuit || '').toLowerCase().includes(hint.circuitContains.toLowerCase())
      );
      if (matched.length) pool = matched;
    }
    // Sort priority: custom > built-in-with-override > built-in current era > anything else
    return pool.find(p => p.isCustom)
        || pool.find(p => p.era === 'Current')
        || pool[0];
  };

  // Step 1: DIRECT match — preset country equals pasted code exactly
  const directCandidates = effective.filter(p => (p.country || '').toUpperCase().trim() === codeKey);
  const direct = pickBest(directCandidates);
  if (direct) {
    const source = direct.isCustom
      ? 'custom track preset'
      : (direct.era === 'Current' ? 'track preset (current)' : `track preset (${direct.era})`);
    return { ...direct, source };
  }

  // Step 2: ALIAS match — pasted code is an F1.com abbreviation that needs translation
  // (e.g. SAU → KSA, SIN → SGP, MON → MCO). Look up via the hint table.
  if (!hint) return null;

  const aliasCandidates = effective.filter(p => {
    if ((p.country || '').toUpperCase() !== hint.country) return false;
    if (hint.circuitContains) {
      return (p.circuit || '').toLowerCase().includes(hint.circuitContains.toLowerCase());
    }
    return true;
  });
  const alias = aliasCandidates.find(p => p.isCustom)
             || aliasCandidates.find(p => p.era === 'Current')
             || aliasCandidates[0];
  if (alias) {
    const source = alias.isCustom
      ? 'custom track preset'
      : (alias.era === 'Current' ? 'track preset (current)' : `track preset (${alias.era})`);
    return { ...alias, source };
  }

  return null;
}

// Normalise a driver name for matching: lowercase, strip diacritics & punctuation,
// collapse whitespace. So "Sergio Pérez" ≡ "sergio perez", "LECLERC, Charles" ≡
// "leclerc charles". Used by matchDriverPresetForName below.
function normalizeDriverName(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Find a driver preset (built-in or user custom) whose name matches a parsed name.
// Priority: exact normalised match → unambiguous last-name match → null.
// Returns { name, country, number, photo?, era, isCustom?, source } or null.
function matchDriverPresetForName(name) {
  const target = normalizeDriverName(name);
  if (!target) return null;
  const all = getEffectiveDriverPresets();

  const exact = all.find(p => normalizeDriverName(p.name) === target);
  if (exact) {
    const source = exact.isCustom
      ? 'custom driver preset'
      : (exact.era === 'Current' ? 'driver preset (current)' : `driver preset (${exact.era || 'historic'})`);
    return { ...exact, source };
  }

  const lastName = target.split(' ').pop();
  if (lastName && lastName.length >= 3) {
    const candidates = all.filter(p => normalizeDriverName(p.name).split(' ').pop() === lastName);
    if (candidates.length === 1) {
      const m = candidates[0];
      const source = m.isCustom
        ? 'custom driver preset (last name)'
        : `driver preset (last name, ${m.era || 'historic'})`;
      return { ...m, source };
    }
  }
  return null;
}

function normalizeTeamName(s) {
  const base = (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return base
    .replace(/\b(racing|f1|team|scuderia|motorsport|gp)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchTeamPresetForName(name) {
  const target = normalizeTeamName(name);
  if (!target) return null;
  const all = getEffectiveTeamPresets();

  const exact = all.find(p => normalizeTeamName(p.name) === target);
  if (exact) {
    const source = exact.isCustom
      ? 'custom team preset'
      : (exact.era === 'Current' ? 'team preset (current)' : `team preset (${exact.era || 'historic'})`);
    return { ...exact, source };
  }

  const targetShort = (name || '').toUpperCase().replace(/[^A-Z]/g, '');
  if (targetShort.length >= 2 && targetShort.length <= 5) {
    const byShort = all.find(p => (p.short || '').toUpperCase() === targetShort);
    if (byShort) {
      const source = byShort.isCustom
        ? 'custom team preset (short code)'
        : `team preset (short code, ${byShort.era || 'historic'})`;
      return { ...byShort, source };
    }
  }

  const targetTokens = target.split(/\s+/).filter(t => t.length >= 3);
  if (!targetTokens.length) return null;
  const candidates = all.filter(p => {
    const pn = normalizeTeamName(p.name);
    if (!pn) return false;
    const pTokens = pn.split(/\s+/).filter(t => t.length >= 3);
    if (!pTokens.length) return false;
    const a = pTokens.every(t => target.includes(t));
    const b = targetTokens.every(t => pn.includes(t));
    return a || b;
  });
  if (candidates.length === 1) {
    const m = candidates[0];
    const source = m.isCustom
      ? 'custom team preset (keyword)'
      : `team preset (keyword, ${m.era || 'historic'})`;
    return { ...m, source };
  }
  return null;
}

// Same-row team-name normalisation. F1.com uses a few different spellings.
// Maps the raw text → canonical team name, short code, and a default colour.
const F1_TEAM_NORMALIZER = {
  'red bull':       { name: 'Red Bull Racing',     short: 'RBR', color: '#3671C6' },
  'red bull racing':{ name: 'Red Bull Racing',     short: 'RBR', color: '#3671C6' },
  'mercedes':       { name: 'Mercedes',            short: 'MER', color: '#27F4D2' },
  'ferrari':        { name: 'Scuderia Ferrari',    short: 'FER', color: '#E80020' },
  'scuderia ferrari':{name: 'Scuderia Ferrari',    short: 'FER', color: '#E80020' },
  'mclaren':        { name: 'McLaren',             short: 'MCL', color: '#FF8000' },
  'aston martin':   { name: 'Aston Martin',        short: 'AMR', color: '#229971' },
  'alpine':         { name: 'Alpine',              short: 'ALP', color: '#0093CC' },
  'williams':       { name: 'Williams Racing',     short: 'WIL', color: '#64C4FF' },
  'rb':             { name: 'RB',                  short: 'VRB', color: '#6692FF' },
  'visa cash app rb':{name:'RB',                   short: 'VRB', color: '#6692FF' },
  'alphatauri':     { name: 'AlphaTauri',          short: 'AT',  color: '#2B4562' },
  'kick sauber':    { name: 'Kick Sauber',         short: 'SAU', color: '#52E252' },
  'sauber':         { name: 'Kick Sauber',         short: 'SAU', color: '#52E252' },
  'alfa romeo':     { name: 'Alfa Romeo',          short: 'ALF', color: '#C92D4B' },
  'haas':           { name: 'Haas',                short: 'HAS', color: '#B6BABD' },
  'haas f1 team':   { name: 'Haas',                short: 'HAS', color: '#B6BABD' },
};

// Parse one result cell. Returns { position, dnf, dsq, dns, pole, sprintPoints } or null if unreadable.
// Real F1.com paste examples this must handle:
//   "1"     → P1
//   "1P"    → P1 + pole
//   "26"    → P2 + 6 sprint points (NOT P26 — F1 doesn't have 26 finishers)
//   "1P8"   → P1 + pole + 8 sprint points
//   "4P2"   → P4 + pole + 2 sprint points
//   "DNF"   → did not finish
//   "DNF4"  → did not finish + 4 sprint points (rare)
//   "DSQ7"  → disqualified + 7 sprint points
//   "DSQ"   → disqualified
//   "DNS"   → did not start
function parseImportResultCell(raw) {
  if (raw == null) return null;
  // Normalize subscript characters to regular digits.
  // Some F1.com pastes use Unicode subscripts (₀-₉) for sprint points.
  let s = String(raw).trim();
  s = s.replace(/[₀₁₂₃₄₅₆₇₈₉]/g, c => '₀₁₂₃₄₅₆₇₈₉'.indexOf(c).toString());
  s = s.toUpperCase();
  if (!s || s === '-' || s === '—' || s === '–') return null;

  // Status codes — may be followed by sprint subscript digits ("DNF4" = DNF + 4 sprint pts)
  const statusMatch = s.match(/^(DNF|RET|DSQ|EX|DNS|NC)(\d+)?$/);
  if (statusMatch) {
    const code = statusMatch[1];
    const sprintPts = statusMatch[2] ? parseInt(statusMatch[2], 10) : 0;
    const out = { sprintPoints: sprintPts || 0 };
    if (code === 'DNF' || code === 'RET' || code === 'NC') out.dnf = true;
    else if (code === 'DSQ' || code === 'EX') out.dsq = true;
    else if (code === 'DNS') out.dns = true;
    return out;
  }

  // Position cell — leading digits + optional P + optional sprint-point subscript digits.
  // Real F1 finishes are 1-20. Anything above 20 in the leading-digits slot is interpreted
  // as "1 or 2-digit position", with everything after taken as sprint points.
  // Pattern: [pos digits, max 2][P]?[sprint digits, optional]
  const m = s.match(/^(\d{1,2})(P)?(\d+)?$/);
  if (!m) return null;
  let position = parseInt(m[1], 10);
  const pole = !!m[2];
  let sprintPoints = m[3] ? parseInt(m[3], 10) : 0;

  // Heuristic disambiguation:
  // If position > 20 AND it's exactly 2 digits AND we don't have a P or sprint marker,
  // it's almost certainly a single-digit position + sprint subscript glued together.
  // e.g. "26" → P2 + 6, not P26
  if (position > 20 && m[1].length === 2 && !m[2] && !m[3]) {
    sprintPoints = position % 10;
    position = Math.floor(position / 10);
  }

  if (position < 1 || position > 30) return null;
  return { position, pole, sprintPoints };
}

// Main parser. Real F1.com paste format is BLOCK-based (not tab-separated):
//   POS\nDRIVER_NAME\n[blank]\nTEAM_NAME\nPOINTS RESULT1 RESULT2 RESULT3 ...
// where POS is either a digit ("2", "3"...) or a crown emoji (👑 for P1).
// Returns: { headers?, drivers: [{ pos, name, team, points, cells: [resultObj or null] }], errors: [] }
function parseImportSeasonPaste(text) {
  // Normalize whitespace; preserve line breaks
  const rawLines = text.split(/\r?\n/);

  // First pass: skip leading garbage (any blank lines or "POS DRIVER TEAM PTS BHR SAU..." header).
  // The real F1.com paste might or might not include the table header. We tolerate both.
  // We're done with the header section when we hit a line that looks like a POS marker
  // (a digit, or a crown emoji).
  const isPosLine = (l) => {
    const t = l.trim();
    if (!t) return false;
    // Crown emoji (P1) — any of the common variants
    if (/^[👑🏆]+$/u.test(t)) return true;
    // Plain digit (POS for P2+)
    if (/^\d{1,2}$/.test(t)) return true;
    return false;
  };

  // Find where the driver blocks start
  let firstDriverIdx = -1;
  for (let i = 0; i < rawLines.length; i++) {
    if (isPosLine(rawLines[i])) { firstDriverIdx = i; break; }
  }
  if (firstDriverIdx === -1) {
    return { error: 'Couldn\'t find any driver rows. The paste should start with a position indicator (a digit or crown emoji) followed by the driver name on the next line.' };
  }

  // Walk the lines and chunk them into driver blocks.
  // A block is: POS_LINE, NAME_LINE, [optional blank], TEAM_LINE, RESULTS_LINE.
  // The next block starts at the following POS_LINE.
  const drivers = [];
  let i = firstDriverIdx;
  while (i < rawLines.length) {
    if (!isPosLine(rawLines[i])) { i++; continue; }
    const posLine = rawLines[i].trim();
    // Read forward to gather the block: skip blanks, take next 3 non-blank lines
    const blockLines = [];
    let j = i + 1;
    while (j < rawLines.length && blockLines.length < 3) {
      const t = rawLines[j].trim();
      if (t) blockLines.push(t);
      j++;
      // Stop if we hit the next POS_LINE — that's the start of the next driver
      if (j < rawLines.length && isPosLine(rawLines[j]) && blockLines.length >= 3) break;
    }

    if (blockLines.length < 3) {
      // Incomplete trailing block — stop here
      break;
    }
    const [nameLine, teamLine, resultsLine] = blockLines;

    // Parse the results line: first token is total points, rest are race results.
    const tokens = resultsLine.split(/\s+/).filter(Boolean);
    if (tokens.length < 1) { i = j; continue; }

    const points = parseInt(tokens[0].replace(/[^\d]/g, ''), 10) || 0;
    const cellTokens = tokens.slice(1);
    const cells = cellTokens.map(t => parseImportResultCell(t));

    // Position: crown = 1, otherwise parse digit
    const pos = posLine.match(/^\d+$/) ? parseInt(posLine, 10) : 1;

    drivers.push({ pos, name: nameLine, team: teamLine, points, cells });

    i = j;
  }

  if (!drivers.length) {
    return { error: 'Found POS markers but couldn\'t parse complete driver blocks. Each block needs POS, DRIVER NAME, TEAM NAME, RESULTS LINE.' };
  }

  // Figure out how many races we have — use the longest result-cell list as the canonical count.
  const raceCount = drivers.reduce((mx, d) => Math.max(mx, d.cells.length), 0);
  if (!raceCount) {
    return { error: 'Found driver blocks but no race result cells. The results line should contain points followed by race results separated by spaces.' };
  }

  // Build placeholder headers — we don't know race codes from this format.
  // The user can choose to fill them in or accept generated names like "Race 1", "Race 2"...
  const headers = Array.from({ length: raceCount }, (_, k) => `R${k + 1}`);

  // Pad any short driver to raceCount with nulls so the matrix is rectangular
  drivers.forEach(d => {
    while (d.cells.length < raceCount) d.cells.push(null);
  });

  return { headers, drivers, errors: [], formatType: 'block' };
}

// LEGACY: TSV header-based parser (kept around in case some users have it pre-formatted that way).
// Tries the block parser first, falls back to TSV if the block parser fails AND the text looks
// like it has a tab-separated header.
function parseImportSeasonPasteTSV(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) return { error: 'No data pasted' };

  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const cells = lines[i].split(/\t+/).map(c => c.trim().toUpperCase());
    if (cells.includes('POS') && cells.includes('DRIVER')) { headerIdx = i; break; }
  }
  if (headerIdx === -1) {
    return { error: 'No tab-separated header row found' };
  }

  const headerCells = lines[headerIdx].split(/\t+/).map(c => c.trim());
  const posIdx    = headerCells.findIndex(c => c.toUpperCase() === 'POS');
  const drvIdx    = headerCells.findIndex(c => c.toUpperCase() === 'DRIVER');
  const teamIdx   = headerCells.findIndex(c => c.toUpperCase() === 'TEAM');
  const ptsIdx    = headerCells.findIndex(c => c.toUpperCase() === 'PTS');
  if (drvIdx === -1 || teamIdx === -1) {
    return { error: 'Header row missing DRIVER or TEAM column' };
  }
  const racesStart = (ptsIdx !== -1) ? ptsIdx + 1 : teamIdx + 1;
  const raceCodes = headerCells.slice(racesStart).map(c => c.trim().toUpperCase()).filter(Boolean);
  if (!raceCodes.length) return { error: 'No race codes after PTS' };

  const drivers = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const cells = lines[i].split(/\t+/);
    if (cells.length < racesStart + 1) continue;
    const name = (cells[drvIdx] || '').trim();
    const team = (cells[teamIdx] || '').trim();
    if (!name || !team) continue;
    const pos = parseInt((cells[posIdx] || '').trim(), 10) || (drivers.length + 1);
    const points = parseInt((cells[ptsIdx] || '0').replace(/[^\d]/g,''), 10) || 0;
    const raceResultCells = raceCodes.map((_, ri) => parseImportResultCell((cells[racesStart + ri] || '').trim()));
    drivers.push({ pos, name, team, points, cells: raceResultCells });
  }
  if (!drivers.length) return { error: 'No driver rows' };

  return { headers: raceCodes, drivers, errors: [], formatType: 'tsv' };
}

// Build a season from a parsed preview. Returns the new season's id.
function buildSeasonFromImport(parsed, opts) {
  const save = activeSave(); if (!save) throw new Error('No active save');
  const seasonId = uid();
  const season = {
    id: seasonId,
    year: Number(opts.year) || new Date().getFullYear(),
    name: (opts.name || '').trim() || `${opts.year} F1 Season`,
    pointsSystemId: opts.pointsSystemId || DEFAULT_POINTS_SYSTEM_ID,
    polePointEnabled: false,
    flPointEnabled: true,
    polePointValue: 1,
    flPointValue: 1,
    createdAt: Date.now(),
    drivers: [],
    teams: [],
    races: [],
  };

  // 1. Build teams — two-step preset match (paste text → F1 canonical → preset)
  const teamByKey = {};
  for (const d of parsed.drivers) {
    const key = d.team.toLowerCase().trim();
    if (teamByKey[key]) continue;

    let preset = matchTeamPresetForName(d.team);
    const canonical = F1_TEAM_NORMALIZER[key];
    if (!preset && canonical?.name) {
      preset = matchTeamPresetForName(canonical.name);
    }

    if (preset) {
      const teamObj = {
        id: uid(),
        name: preset.name,
        short: preset.short || canonical?.short || d.team.slice(0,3).toUpperCase(),
        color: preset.color || canonical?.color || '#666666',
        country: preset.country || '',
        logo: preset.logo || '',
      };
      teamByKey[key] = teamObj;
      season.teams.push(teamObj);
      continue;
    }

    const teamObj = {
      id: uid(),
      name: canonical?.name || d.team,
      short: canonical?.short || d.team.slice(0,3).toUpperCase(),
      color: canonical?.color || '#666666',
      country: '',
    };
    teamByKey[key] = teamObj;
    season.teams.push(teamObj);
  }

  // 2. Build drivers — match each parsed driver against the user's DRIVER PRESET
  // library (built-in + customs). On match, pull through country, number, and
  // photo. Unmatched drivers fall back to incremental numbers and blank fields.
  const driverIdByImportName = {};
  const presetByDriverIdx = parsed.drivers.map(d => matchDriverPresetForName(d.name));
  const usedNumbers = new Set();
  presetByDriverIdx.forEach(p => { if (p?.number) usedNumbers.add(p.number); });
  let nextNum = 1;
  const allocNumber = () => {
    while (usedNumbers.has(nextNum) || nextNum > 99) nextNum++;
    usedNumbers.add(nextNum);
    return nextNum++;
  };
  parsed.drivers.forEach((d, i) => {
    const teamObj = teamByKey[d.team.toLowerCase().trim()];
    const preset = presetByDriverIdx[i];
    const driverObj = {
      id: uid(),
      name: preset?.name || d.name,
      number: preset?.number || allocNumber(),
      country: preset?.country || '',
      teamId: teamObj?.id || null,
      // Resolve the season-appropriate preset photo. Presets store images in a
      // `photos` array (multi-photo feature, each with a label); we match the
      // import's year/name to that label so e.g. a 2023 import uses the driver's
      // "2023" photo, falling back to the default photo, then the legacy `photo`.
      photo: pickPresetPhotoForSeason(preset, opts) || preset?.photo || '',
      dsq: false,
    };
    driverIdByImportName[d.name] = driverObj.id;
    season.drivers.push(driverObj);
  });

  // 3. Build races — one per header code (or per raceCodes override).
  // Simple resolution: compare each pasted code to the country code in each
  // calendar preset's races. Direct string match — no alias translation.
  // If no calendar preset has that country code, fall back to F1 built-in map,
  // then generic.
  // Build per-race header codes — caller may supply a full or partial array.
  // For any index without a user-supplied code, fall back to the parsed placeholder.
  const headerCodes = parsed.headers.map((h, i) => (opts.raceCodes && opts.raceCodes[i]) || h);

  // Build a lookup index from CALENDAR PRESETS (full saved season calendars).
  // Selected preset wins on conflicts.
  const presetById = id => (state.calendarPresets || []).find(p => p.id === id);
  const codeIndex = {}; // 'BHR' -> { name, circuit, country, flagImage, sprint }
  const indexCalPreset = (preset) => {
    if (!preset) return;
    preset.races.forEach(r => {
      const key = (r.country || '').toUpperCase().trim();
      if (key && !codeIndex[key]) {
        codeIndex[key] = {
          name: r.name,
          circuit: r.circuit,
          country: r.country,
          flagImage: r.flagImage || '',
          sprint: !!r.sprint,
        };
      }
    });
  };
  if (opts.calendarPresetId) indexCalPreset(presetById(opts.calendarPresetId));
  (state.calendarPresets || []).forEach(p => indexCalPreset(p));

  // Detect which races had sprints — any race where ANY driver has sprintPoints > 0
  const hadSprint = parsed.headers.map((_, ri) =>
    parsed.drivers.some(d => d.cells[ri]?.sprintPoints > 0)
  );

  const raceObjs = headerCodes.map((code, idx) => {
    const codeKey = (code || '').toUpperCase().trim();
    // Step 1: direct match against calendar presets' country codes
    let meta = codeIndex[codeKey];
    // Step 2: match against the user's TRACK PRESET library (built-in + custom).
    // Handles 3-letter aliases (SAU↔KSA, MON↔MCO, SIN↔SGP, etc.) and ambiguity
    // hints (MIA vs LVG vs USA, ITA vs IMO). This is the main resolution path.
    if (!meta) {
      const tp = matchTrackPresetForCode(codeKey);
      if (tp) meta = {
        name: tp.name,
        circuit: tp.circuit,
        country: tp.country,
        sprint: !!tp.sprint,
        flagImage: tp.flagImage || '',
      };
    }
    // Step 3: hardcoded F1 map (legacy fallback for codes nothing else covers)
    if (!meta) meta = F1_RACE_CODE_MAP[codeKey];
    // Step 4: generic fallback
    if (!meta) meta = { name: `${code} Grand Prix`, circuit: code, country: code };

    return {
      id: uid(),
      round: idx + 1,
      name: meta.name,
      circuit: meta.circuit,
      country: meta.country,
      flagImage: meta.flagImage || '',
      sprint: hadSprint[idx] || !!meta.sprint,
      completed: false,
      results: [],
      sprintResults: [],
      fastestLapDriverId: null,
      poleDriverId: null,
    };
  });
  season.races = raceObjs;

  // 4. Apply results per race
  // Reverse-engineer each driver's sprint finishing position from the sprint
  // POINTS they scored. The map is derived from the season's own points system,
  // so it works for the modern 8-7-…-1 sprint AND the 2021 3-2-1 sprint.
  const sprintPS = POINTS_SYSTEMS.find(p => p.id === (opts.pointsSystemId || DEFAULT_POINTS_SYSTEM_ID)) || POINTS_SYSTEMS[0];
  const SPRINT_POINT_TO_POS = {};
  (sprintPS.sprintPoints || []).forEach((pts, i) => { if (SPRINT_POINT_TO_POS[pts] == null) SPRINT_POINT_TO_POS[pts] = i + 1; });
  for (let ri = 0; ri < raceObjs.length; ri++) {
    const race = raceObjs[ri];
    let anyResults = false;
    let poleDrvId = null;
    let flDrvId = null;
    for (const d of parsed.drivers) {
      const cell = d.cells[ri];
      if (!cell) continue;
      anyResults = true;
      const drvId = driverIdByImportName[d.name];
      if (!drvId) continue;
      race.results.push({
        driverId: drvId,
        position: cell.position || null,
        dnf: !!cell.dnf,
        dsq: !!cell.dsq,
        dns: !!cell.dns,
      });
      if (cell.pole && !poleDrvId) poleDrvId = drvId;
      if (cell.fastestLap && !flDrvId) flDrvId = drvId;
      // Sprint result if this driver scored sprint points
      if (cell.sprintPoints > 0) {
        const sprintPos = SPRINT_POINT_TO_POS[cell.sprintPoints] || null;
        race.sprintResults.push({
          driverId: drvId,
          position: sprintPos,
          dnf: false, dsq: false, dns: false,
        });
      }
    }
    if (anyResults) {
      race.completed = true;
      race.poleDriverId = poleDrvId;
      race.fastestLapDriverId = flDrvId;
    }
  }

  // Apply per-race points multipliers parsed from race-code suffixes (e.g. BEL*0.5)
  if (Array.isArray(parsed.raceMultipliers)) {
    raceObjs.forEach((race, idx) => {
      const m = Number(parsed.raceMultipliers[idx]);
      if (m === 0.5 || m === 2) setRacePointsMultiplier(race.id, m);
    });
  }

  save.seasons[seasonId] = season;
  state.activeSeasonId = seasonId;
  state.view = 'dashboard';
  saveState();
  return seasonId;
}

function openImportRealSeasonModal() {
  if (!state.activeSaveId) return toast('Open a save first', 'warn');
  let parsed = null;

  modal({
    title: `<span class="accent">Import</span> F1 Season`,
    size: 'wide',
    body: `
      <div class="field-help" style="margin-bottom:14px">
        Copy a driver standings table from F1.com or Wikipedia and paste it below. Each driver appears as a block: position, name, team, then a line of results.
      </div>
      <details style="margin-bottom:14px;background:var(--bg-elev);border-radius:6px;padding:10px 14px">
        <summary style="cursor:pointer;font-family:var(--f-mono);font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:var(--text-soft)">▸ Format examples</summary>
        <div style="font-family:var(--f-mono);font-size:10px;color:var(--text-muted);margin-top:10px;line-height:1.6">
          <b style="color:var(--text)">F1.com paste format (most common):</b> each driver is 4 lines.
        </div>
        <pre style="margin:8px 0;font-size:10px;line-height:1.4;color:var(--text-soft);white-space:pre">👑
Max Verstappen

Red Bull
587   1P  2  1P  26  1  1P  1P  1P  1P8  1P  1  18  1P  1  5  1P  1P7  18  1  1P8  1  1P
2
Sergio Pérez

Red Bull
287   2  1P  5  18  2P  16  4  6  37  6  3  2  4  2  8  DNF  10  44  DNF  46  3  4</pre>
        <div style="font-family:var(--f-mono);font-size:10px;color:var(--text-muted);margin-top:10px;line-height:1.6">
          Each result token decodes as:<br>
          • <code>1</code> → P1 finish<br>
          • <code>1P</code> → P1 finish + pole position<br>
          • <code>26</code> → P2 finish + 6 sprint race points<br>
          • <code>1P8</code> → P1 finish + pole + 8 sprint points<br>
          • <code>DNF</code>, <code>DSQ</code>, <code>DNS</code> → status codes<br>
          • <b>Fastest laps cannot be detected from text</b> — add them manually after import.<br>
          • 👑 emoji or just a number indicates the championship position.
        </div>
      </details>
      <div class="field-row">
        <div class="field"><label>Year</label><input type="number" id="imp-year" value="${new Date().getFullYear()}"></div>
        <div class="field"><label>Season Name</label><input type="text" id="imp-name" placeholder="e.g. 2023 F1 World Championship"></div>
      </div>
      <div class="field">
        <label>Points System</label>
        <select id="imp-points">
          ${POINTS_SYSTEMS.map(p => `<option value="${p.id}" ${p.id === DEFAULT_POINTS_SYSTEM_ID ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label>Paste the driver standings here</label>
        <textarea id="imp-text" rows="12" placeholder="Paste the F1.com standings table here..." style="font-family:var(--f-mono);font-size:11px;width:100%;min-height:200px"></textarea>
      </div>
      <div class="field">
        <label>Match races to one of your saved calendar presets <span style="font-weight:400;color:var(--text-muted);font-family:var(--f-body)">(optional)</span></label>
        <div style="display:flex;gap:8px;align-items:flex-end">
          <select id="imp-cal-preset" style="flex:1">
            <option value="">— Use F1 default circuit names —</option>
            ${(state.calendarPresets || []).map(p => `<option value="${esc(p.id)}">${esc(p.name)} · ${p.races.length} round${p.races.length === 1 ? '' : 's'}</option>`).join('')}
          </select>
          <button type="button" class="btn btn-ghost" id="imp-fill-codes" style="white-space:nowrap" ${!(state.calendarPresets || []).length ? 'disabled' : ''}>↳ FILL CODES BELOW</button>
        </div>
        <span class="field-help">Selecting a preset auto-resolves race codes against its rounds. Click FILL CODES to populate the race calendar field below with that preset's country codes in order.</span>
      </div>
      <div class="field">
        <label>Race calendar codes <span style="font-weight:400;color:var(--text-muted);font-family:var(--f-body)">— space-separated, in calendar order</span></label>
        <input type="text" id="imp-races" placeholder="e.g. BHR SAU AUS AZE MIA MON ESP CAN AUT GBR HUN BEL NED ITA SIN JPN QAT USA MXC SAP LVG ABU" style="font-family:var(--f-mono);font-size:11px">
        <span class="field-help">Each code is matched in this order: (1) selected calendar preset's race country codes, (2) your <b>track preset library</b> (built-in circuits + your customs, with alias handling for SAU↔KSA, MON↔MCO, SIN↔SGP, etc.), (3) F1 built-in map, (4) generic "Grand Prix" fallback. A match pulls in the track's name, circuit, sprint flag, and uploaded flag image.</span>
      </div>
      <div id="imp-preview"></div>`,
    footer: `<button class="btn btn-ghost" data-act="cancel">Cancel</button><button class="btn btn-ghost" data-act="parse">⚙ PARSE</button><button class="btn btn-primary" data-act="ok" disabled>Build Season</button>`,
    onMount: (root, close) => {
      const ta = $('#imp-text', root);
      const racesInp = $('#imp-races', root);
      const calSel = $('#imp-cal-preset', root);
      const fillCodesBtn = $('#imp-fill-codes', root);
      const preview = $('#imp-preview', root);
      const okBtn = $('[data-act="ok"]', root);

      // Auto-fill codes button: takes the selected preset and fills imp-races with its country codes in order
      fillCodesBtn.onclick = () => {
        const pid = calSel.value;
        if (!pid) { toast('Pick a calendar preset first', 'warn'); return; }
        const preset = (state.calendarPresets || []).find(p => p.id === pid);
        if (!preset) return;
        const codes = preset.races
          .slice()
          .sort((a, b) => (a.round || 0) - (b.round || 0))
          .map(r => (r.country || '???').toUpperCase().trim())
          .filter(Boolean);
        racesInp.value = codes.join(' ');
        toast(`Filled ${codes.length} codes from "${preset.name}"`, 'success');
        if (parsed) doParse(); // re-render preview with new codes
      };

      // Selecting a preset doesn't auto-fill codes (user might want to pick a different code order)
      // but it does affect resolution priority.
      calSel.onchange = () => { if (parsed) doParse(); };

      const doParse = () => {
        const text = ta.value;
        if (!text.trim()) {
          preview.innerHTML = `<div class="empty-row" style="padding:20px">Paste some text and click PARSE.</div>`;
          okBtn.disabled = true; return;
        }
        // Try the block parser (real F1.com format) first
        let r = parseImportSeasonPaste(text);
        // If block parser fails, fall back to the legacy tab-separated parser
        if (r.error) {
          const tsv = parseImportSeasonPasteTSV(text);
          if (!tsv.error) r = tsv;
        }
        if (r.error) {
          preview.innerHTML = `<div class="storage-warning" style="margin-top:14px"><div class="storage-warning-head">⚠ Couldn't parse</div><div class="storage-warning-body">${esc(r.error)}</div></div>`;
          okBtn.disabled = true; parsed = null; return;
        }
        parsed = r;
        okBtn.disabled = false;

        // If user supplied race codes, overlay them onto the headers position-by-position.
        // Partial input works: type "BHR" alone and only R1 gets that code; R2..Rn keep
        // the placeholder. Extra codes beyond the race count are ignored.
        const userCodes = racesInp.value.trim().split(/\s+/).filter(Boolean);
        const previewHeaders = userCodes.length
          ? r.headers.map((h, i) => userCodes[i] || h)
          : r.headers;

        // Resolve each header code against (1) selected preset, (2) all presets, (3) F1 map
        // — same logic as buildSeasonFromImport, mirrored here so preview matches reality.
        const codeIndex = {};
        const indexPreset = (preset) => {
          if (!preset) return;
          preset.races.forEach(rr => {
            const key = (rr.country || '').toUpperCase().trim();
            if (key && !codeIndex[key]) codeIndex[key] = { name: rr.name, source: preset.name };
          });
        };
        const selectedPid = calSel.value;
        if (selectedPid) indexPreset((state.calendarPresets || []).find(p => p.id === selectedPid));
        (state.calendarPresets || []).forEach(p => indexPreset(p));

        // For each preview code, work out where it resolved. Order mirrors
        // buildSeasonFromImport so the preview matches the actual outcome.
        const resolutions = previewHeaders.map(code => {
          const k = (code || '').toUpperCase().trim();
          // Step 1: direct match against calendar preset country codes
          if (codeIndex[k]) return { code, name: codeIndex[k].name, source: `calendar preset: ${codeIndex[k].source}` };
          // Step 2: track preset library (built-in + user customs, with aliases)
          const tp = matchTrackPresetForCode(k);
          if (tp) return { code, name: tp.name, source: tp.source };
          // Step 3: F1 hardcoded map
          if (F1_RACE_CODE_MAP[k]) return { code, name: F1_RACE_CODE_MAP[k].name, source: 'F1 hardcoded map' };
          // Step 4: generic fallback
          return { code, name: `${code} Grand Prix`, source: 'fallback' };
        });
        const fromCalPreset = resolutions.filter(x => x.source.startsWith('calendar preset')).length;
        const fromTrackPreset = resolutions.filter(x => x.source.startsWith('track preset') || x.source === 'custom track preset').length;
        const fromF1Map = resolutions.filter(x => x.source === 'F1 hardcoded map').length;
        const fallback = resolutions.filter(x => x.source === 'fallback').length;

        // Resolve each driver against the DRIVER PRESET library (built-in + custom).
        const driverResolutions = r.drivers.map(d => matchDriverPresetForName(d.name));
        const driversMatched = driverResolutions.filter(Boolean).length;
        const driversUnmatched = r.drivers.length - driversMatched;

        // Resolve unique teams against the TEAM PRESET library — same two-step
        // resolution buildSeasonFromImport uses.
        const uniqueTeamNames = [...new Set(r.drivers.map(d => d.team).filter(Boolean))];
        const teamResolutions = uniqueTeamNames.map(t => {
          let p = matchTeamPresetForName(t);
          if (!p) {
            const c = F1_TEAM_NORMALIZER[t.toLowerCase().trim()];
            if (c?.name) p = matchTeamPresetForName(c.name);
          }
          return p;
        });
        const teamsMatched = teamResolutions.filter(Boolean).length;
        const teamsUnmatched = uniqueTeamNames.length - teamsMatched;

        const completedRaces = r.headers.length;
        const totalResults = r.drivers.reduce((sum, d) => sum + d.cells.filter(Boolean).length, 0);
        const totalSprintPoints = r.drivers.reduce((sum, d) => sum + d.cells.reduce((s, c) => s + (c?.sprintPoints || 0), 0), 0);
        const totalPoles = r.drivers.reduce((sum, d) => sum + d.cells.filter(c => c?.pole).length, 0);

        const statusParts = [];
        if (fromCalPreset)    statusParts.push(`<span style="color:var(--green,#10b981)">● ${fromCalPreset} race${fromCalPreset === 1 ? '' : 's'} from calendar preset</span>`);
        if (fromTrackPreset)  statusParts.push(`<span style="color:var(--sec-cyan,#00d9ff)">● ${fromTrackPreset} race${fromTrackPreset === 1 ? '' : 's'} from track preset library</span>`);
        if (fromF1Map)        statusParts.push(`<span style="color:var(--sec-blue,#60a5fa)">● ${fromF1Map} race${fromF1Map === 1 ? '' : 's'} from F1 map</span>`);
        if (fallback)         statusParts.push(`<span style="color:var(--sec-yellow,#f59e0b)">● ${fallback} race${fallback === 1 ? '' : 's'} fell back to generic name</span>`);
        if (driversMatched)   statusParts.push(`<span style="color:var(--sec-purple,#a78bfa)">● ${driversMatched} driver${driversMatched === 1 ? '' : 's'} from preset library</span>`);
        if (driversUnmatched) statusParts.push(`<span style="color:var(--text-muted)">● ${driversUnmatched} driver${driversUnmatched === 1 ? '' : 's'} unmatched (blank country/photo)</span>`);
        if (teamsMatched)     statusParts.push(`<span style="color:var(--sec-green,#10dc88)">● ${teamsMatched} team${teamsMatched === 1 ? '' : 's'} from preset library</span>`);
        if (teamsUnmatched)   statusParts.push(`<span style="color:var(--text-muted)">● ${teamsUnmatched} team${teamsUnmatched === 1 ? '' : 's'} unmatched (generic color)</span>`);
        const resolutionStatus = statusParts.length ? `
          <div style="font-family:var(--f-mono);font-size:10px;color:var(--text-muted);margin-bottom:10px;padding:8px 12px;background:var(--bg-elev);border-radius:6px;border:1px solid var(--border-dim);line-height:1.8">
            ${statusParts.join(' · ')}
          </div>` : '';

        preview.innerHTML = `
          <div style="margin-top:18px">
            <div style="font-family:var(--f-mono);font-size:10px;letter-spacing:0.18em;color:var(--text-muted);text-transform:uppercase;margin-bottom:10px">
              PREVIEW · ${r.drivers.length} DRIVER${r.drivers.length === 1 ? '' : 'S'} · ${completedRaces} RACE${completedRaces === 1 ? '' : 'S'} · ${totalResults} RESULT${totalResults === 1 ? '' : 'S'} · ${totalPoles} POLE${totalPoles === 1 ? '' : 'S'} · ${totalSprintPoints} SPRINT POINTS
            </div>
            ${resolutionStatus}
            <div style="overflow-x:auto;border:1px solid var(--border-dim);border-radius:6px;max-height:380px">
              <table style="border-collapse:collapse;font-family:var(--f-mono);font-size:11px;width:max-content;min-width:100%">
                <thead>
                  <tr style="background:var(--bg-elev)">
                    <th style="padding:8px 10px;text-align:left;border-bottom:1px solid var(--border)">POS</th>
                    <th style="padding:8px 10px;text-align:left;border-bottom:1px solid var(--border)">DRIVER</th>
                    <th style="padding:8px 10px;text-align:left;border-bottom:1px solid var(--border)">TEAM</th>
                    <th style="padding:8px 10px;text-align:right;border-bottom:1px solid var(--border)">PTS</th>
                    ${previewHeaders.map((h, idx) => {
                      const res = resolutions[idx];
                      const tip = `${res.name} (${res.source})`;
                      return `<th style="padding:8px 6px;text-align:center;border-bottom:1px solid var(--border);font-size:9px;letter-spacing:0.1em" title="${esc(tip)}">${esc(h)}</th>`;
                    }).join('')}
                  </tr>
                </thead>
                <tbody>
                  ${r.drivers.map((d, dIdx) => {
                    const dp = driverResolutions[dIdx];
                    const matchBadge = dp
                      ? `<span class="cf-img" style="display:inline-flex;align-items:center;margin-right:6px;width:auto;height:auto;border:none;box-shadow:none;background:transparent;padding:0">${flagImg(dp.country, 16)}</span><span title="Matched to ${esc(dp.source)} → #${dp.number}${dp.country ? ' · ' + esc(dp.country) : ''}" style="font-family:var(--f-mono);font-size:8px;letter-spacing:0.14em;color:var(--sec-purple);padding:2px 5px;border:1px solid currentColor;border-radius:2px;margin-left:6px;vertical-align:middle">PRESET #${dp.number}</span>`
                      : '<span title="No preset match — country &amp; photo will be blank" style="font-family:var(--f-mono);font-size:8px;letter-spacing:0.14em;color:var(--text-dim);padding:2px 5px;border:1px dashed currentColor;border-radius:2px;margin-left:6px;vertical-align:middle">NO MATCH</span>';
                    return `
                    <tr style="border-bottom:1px solid var(--border-dim)">
                      <td style="padding:6px 10px;color:var(--text-muted)">${d.pos}</td>
                      <td style="padding:6px 10px;font-weight:600;white-space:nowrap">${matchBadge}${esc(d.name)}</td>
                      <td style="padding:6px 10px;color:var(--text-soft)">${esc(d.team)}</td>
                      <td style="padding:6px 10px;text-align:right;font-weight:700">${d.points}</td>
                      ${d.cells.map(c => {
                        if (!c) return `<td style="padding:6px;text-align:center;color:var(--text-dim);opacity:0.5">—</td>`;
                        let txt = '', col = 'var(--text)';
                        if (c.dnf) { txt = 'DNF'; col = 'var(--red)'; }
                        else if (c.dsq) { txt = 'DSQ'; col = 'var(--red)'; }
                        else if (c.dns) { txt = 'DNS'; col = 'var(--text-muted)'; }
                        else if (c.position) {
                          txt = c.position + (c.pole ? '<sup style="color:var(--sec-blue);font-size:8px">P</sup>' : '');
                          if (c.position === 1) col = 'var(--gold)';
                          else if (c.position === 2) col = 'var(--silver)';
                          else if (c.position === 3) col = 'var(--bronze)';
                          else if (c.position > 10) col = 'var(--text-muted)';
                        }
                        // Sprint subscript
                        if (c.sprintPoints > 0) {
                          txt += `<sub style="color:var(--sec-yellow,#f59e0b);font-size:8px;margin-left:1px">${c.sprintPoints}</sub>`;
                        }
                        return `<td style="padding:6px;text-align:center;color:${col};font-weight:600">${txt}</td>`;
                      }).join('')}
                    </tr>`;
                  }).join('')}
                </tbody>
              </table>
            </div>
            <div class="field-help" style="margin-top:10px">
              ${driversMatched ? `<span style="color:var(--sec-purple)">●</span> Matched drivers will inherit their preset's <b>real F1 number</b>, <b>country</b>, and <b>photo</b> (if a custom preset has one). ` : ''}Teams are auto-created with default colors you can edit. ${userCodes.length === r.headers.length ? 'Race codes mapped to real circuits.' : 'Optionally fill the race calendar field above to get real circuit names.'}
            </div>
          </div>`;
      };

      $('[data-act="parse"]', root).onclick = doParse;
      $('[data-act="cancel"]', root).onclick = close;
      ta.oninput = () => { if (parsed) { parsed = null; okBtn.disabled = true; } };
      racesInp.oninput = () => { if (parsed) doParse(); };  // re-render preview with codes
      okBtn.onclick = async () => {
        if (!parsed) return doParse();
        try {
          const year = $('#imp-year', root).value;
          const name = $('#imp-name', root).value;
          const pointsSystemId = $('#imp-points', root).value;
          const userCodes = racesInp.value.trim().split(/\s+/).filter(Boolean);
          // Partial-overlay: typed codes fill positions left-to-right, missing
          // positions keep the parsed placeholder (R1, R2, …). Matches the preview.
          const raceCodes = userCodes.length
            ? parsed.headers.map((h, i) => userCodes[i] || h)
            : null;
          const calendarPresetId = calSel.value || null;
          buildSeasonFromImport(parsed, { year, name, pointsSystemId, raceCodes, calendarPresetId });
          close();
          renderAll();
          await cloudPushNowBlocking('Uploading the imported season — this can take a few seconds.');
          toast(`Imported ${parsed.drivers.length} driver${parsed.drivers.length === 1 ? '' : 's'} across ${parsed.headers.length} race${parsed.headers.length === 1 ? '' : 's'}`, 'success');
        } catch (e) {
          toast('Import failed: ' + e.message, 'error');
        }
      };
    }
  });
}

/* =====================================================
   TESSERACT.JS — lazy-loaded OCR engine
   ====================================================== */
let _tesseractLoading = null;
function loadTesseract() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  if (_tesseractLoading) return _tesseractLoading;
  _tesseractLoading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://unpkg.com/tesseract.js@5/dist/tesseract.min.js';
    s.async = true;
    s.onload = () => resolve(window.Tesseract);
    s.onerror = () => { _tesseractLoading = null; reject(new Error('Failed to load Tesseract.js — check your internet connection')); };
    document.head.appendChild(s);
  });
  return _tesseractLoading;
}

function cropImageDataURL(dataUrl, { leftFraction = 0, rightFraction = 1 } = {}) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        const w = img.naturalWidth;
        const h = img.naturalHeight;
        const sx = Math.round(w * leftFraction);
        const sw = Math.max(1, Math.round(w * (rightFraction - leftFraction)));
        const canvas = document.createElement('canvas');
        canvas.width = sw;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, sx, 0, sw, h, 0, 0, sw, h);
        resolve({ dataUrl: canvas.toDataURL('image/png'), width: sw, height: h });
      } catch (e) { reject(e); }
    };
    img.onerror = () => reject(new Error('Could not load image for cropping'));
    img.src = dataUrl;
  });
}

// OCR a season matrix screenshot for driver+team names only. Race-result
// cells are too small in a typical matrix view for Tesseract to read
// reliably — user fills those manually.
async function ocrScreenshotMatrix(imageDataUrl, expectedRaceCount, onProgress) {
  const Tess = await loadTesseract();
  onProgress({ status: 'cropping name strip', progress: 0.02 });

  const cropped = await cropImageDataURL(imageDataUrl, { leftFraction: 0, rightFraction: 0.38 });

  onProgress({ status: 'loading worker', progress: 0.06 });
  const worker = await Tess.createWorker('eng', 1, {
    logger: m => {
      if (m.status === 'recognizing text') onProgress({ status: 'reading driver names', progress: 0.1 + m.progress * 0.85 });
      else if (m.status) onProgress({ status: m.status, progress: 0.06 });
    }
  });
  await worker.setParameters({ tessedit_pageseg_mode: '11' });
  const result = await worker.recognize(cropped.dataUrl);
  await worker.terminate();
  onProgress({ status: 'parsing', progress: 0.96 });

  const words = (result.data.words || []).filter(w =>
    w && w.text && w.bbox &&
    w.confidence > 40 &&
    /[A-Za-z]/.test(w.text) &&
    w.text.replace(/[^A-Za-z]/g, '').length >= 2
  );
  if (!words.length) return { drivers: [] };

  const sortedByY = words.slice().sort((a, b) => (a.bbox.y0 + a.bbox.y1) / 2 - (b.bbox.y0 + b.bbox.y1) / 2);
  const bands = [];
  const tol = 14;
  for (const w of sortedByY) {
    const yc = (w.bbox.y0 + w.bbox.y1) / 2;
    let band = bands.find(b => Math.abs(b.yc - yc) < tol);
    if (!band) { band = { yc, words: [] }; bands.push(band); }
    band.words.push(w);
    band.yc = (band.yc * (band.words.length - 1) + yc) / band.words.length;
  }
  bands.forEach(b => b.words.sort((a, b) => a.bbox.x0 - b.bbox.x0));

  const HEADER_KEYWORDS = ['POS', 'DRIVER', 'TEAM', 'PTS', 'POINTS'];
  let headerBandIdx = bands.findIndex(b =>
    HEADER_KEYWORDS.some(k => b.words.some(w => w.text.toUpperCase().includes(k)))
  );
  const dataBands = bands.slice(headerBandIdx >= 0 ? headerBandIdx + 1 : 0);

  const drivers = [];
  for (const band of dataBands) {
    if (band.words.length < 1) continue;

    let maxGap = 0, maxGapIdx = -1;
    for (let i = 1; i < band.words.length; i++) {
      const gap = band.words[i].bbox.x0 - band.words[i - 1].bbox.x1;
      if (gap > maxGap) { maxGap = gap; maxGapIdx = i; }
    }
    let nameWords = band.words;
    let teamWords = [];
    if (maxGap > 22 && maxGapIdx > 0) {
      nameWords = band.words.slice(0, maxGapIdx);
      teamWords = band.words.slice(maxGapIdx);
    }

    const name = nameWords.map(w => w.text.trim()).join(' ').replace(/\s+/g, ' ').trim();
    const team = teamWords.map(w => w.text.trim()).join(' ').replace(/\s+/g, ' ').trim();
    if (!name || name.length < 3) continue;

    drivers.push({ name, team, points: 0, cells: [] });
  }

  onProgress({ status: 'done', progress: 1 });
  return { drivers };
}

/* =====================================================
   SCREENSHOT / MATRIX IMPORTER
   ====================================================== */
function openImportScreenshotModal() {
  if (!state.activeSaveId) return toast('Open a save first', 'warn');

  let imageDataUrl = '';
  let raceCodes = [];
  let drivers = [
    { name: '', team: '', cells: [] },
    { name: '', team: '', cells: [] },
  ];

  const ensureCellsLength = () => {
    drivers.forEach(d => {
      while (d.cells.length < raceCodes.length) d.cells.push('');
      d.cells.length = raceCodes.length;
    });
  };

  modal({
    title: `<span class="accent">Import</span> from Screenshot`,
    size: 'wide',
    body: `
      <div class="field-help" style="margin-bottom:14px">
        Upload a screenshot of any season matrix for visual reference, then fill in the grid below. Each cell uses the same shorthand as the F1 text paste — type <code>1</code>, <code>1P</code>, <code>26</code> (P2 + 6 sprint pts), <code>1P8</code> (P1 + pole + 8 sprint), <code>DNF</code>, <code>DSQ</code>, <code>DNS</code>.
      </div>

      <div class="field-row">
        <div class="field"><label>Year</label><input type="number" id="imp2-year" value="${new Date().getFullYear()}"></div>
        <div class="field"><label>Season Name</label><input type="text" id="imp2-name" placeholder="e.g. 2024 F1 World Championship"></div>
      </div>
      <div class="field">
        <label>Points System</label>
        <select id="imp2-points">
          ${POINTS_SYSTEMS.map(p => `<option value="${p.id}" ${p.id === DEFAULT_POINTS_SYSTEM_ID ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
        </select>
      </div>

      <div class="field">
        <label>Screenshot reference <span style="font-weight:400;color:var(--text-muted);font-family:var(--f-body)">(optional, displayed as a visual guide)</span></label>
        <div id="imp2-shot-mount"></div>
      </div>

      <div class="field">
        <label>Race calendar codes <span style="font-weight:400;color:var(--text-muted);font-family:var(--f-body)">— space-separated, in calendar order</span></label>
        <div style="display:flex;gap:8px;align-items:stretch">
          <select id="imp2-cal-preset" style="flex:1">
            <option value="">— No preset (type codes manually) —</option>
            ${(state.calendarPresets || []).map(p => `<option value="${esc(p.id)}">${esc(p.name)} · ${p.races.length} round${p.races.length === 1 ? '' : 's'}</option>`).join('')}
          </select>
          <button type="button" class="btn btn-ghost" id="imp2-fill-codes" style="white-space:nowrap" ${!(state.calendarPresets || []).length ? 'disabled' : ''}>↳ FILL FROM PRESET</button>
        </div>
        <input type="text" id="imp2-races" placeholder="e.g. BHR SAU AUS AZE MIA MON ESP CAN AUT GBR HUN BEL NED ITA SIN JPN QAT USA MXC SAP LVG ABU" style="font-family:var(--f-mono);font-size:11px;margin-top:8px">
      </div>

      <div class="field">
        <label>Driver grid <span style="font-weight:400;color:var(--text-muted);font-family:var(--f-body)">— one row per driver</span></label>
        <div class="imp2-matrix-wrap" id="imp2-matrix"></div>
        <div style="display:flex;gap:8px;margin-top:10px">
          <button type="button" class="btn btn-ghost btn-sm" id="imp2-add-row">+ ADD DRIVER ROW</button>
          <button type="button" class="btn btn-ghost btn-sm" id="imp2-add-rows-20" style="margin-left:auto">+ FILL TO 20 ROWS</button>
        </div>
      </div>

      <div id="imp2-preview-status"></div>`,
    footer: `<button class="btn btn-ghost" data-act="cancel">Cancel</button><button class="btn btn-primary" data-act="ok">Build Season</button>`,
    onMount: (root, close) => {
      const shotMount = $('#imp2-shot-mount', root);
      const renderShot = () => {
        shotMount.innerHTML = imageDataUrl ? `
          <div class="imp2-shot-frame">
            <img src="${esc(imageDataUrl)}" class="imp2-shot-img" alt="Season matrix reference">
            <div class="imp2-shot-actions">
              <button type="button" class="btn btn-primary btn-sm" id="imp2-ocr">🤖 AUTO-FILL FROM SCREENSHOT</button>
              <label class="btn btn-ghost btn-sm" style="cursor:pointer">
                <input type="file" accept="image/*" style="display:none">↻ REPLACE
              </label>
              <button type="button" class="btn btn-ghost btn-sm" id="imp2-clear-shot" style="color:var(--red);margin-left:auto">✕ REMOVE</button>
            </div>
            <div class="imp2-ocr-status" id="imp2-ocr-status" hidden></div>
          </div>
        ` : `
          <label class="imp2-shot-drop">
            <input type="file" accept="image/*" style="display:none">
            <div class="imp2-shot-drop-icon">📷</div>
            <div class="imp2-shot-drop-title">Upload screenshot</div>
            <div class="imp2-shot-drop-sub">Click to choose a file (PNG / JPG). After uploading you can click <b>🤖 AUTO-FILL</b> to extract driver + team names via OCR. <b>Race-result cells are too small for OCR — you fill those manually</b> in the grid below.</div>
          </label>
        `;
        const fileInp = shotMount.querySelector('input[type="file"]');
        if (fileInp) {
          fileInp.onchange = async (e) => {
            const f = e.target.files[0]; if (!f) return;
            try {
              imageDataUrl = await fileToDataURL(f, 1800);
              renderShot();
            } catch (err) { toast(err.message || 'Could not load image', 'error'); }
          };
        }
        const clearBtn = $('#imp2-clear-shot', root);
        if (clearBtn) clearBtn.onclick = () => { imageDataUrl = ''; renderShot(); };

        const ocrBtn = $('#imp2-ocr', root);
        const ocrStatus = $('#imp2-ocr-status', root);
        if (ocrBtn) {
          ocrBtn.onclick = async () => {
            if (!imageDataUrl) return toast('Upload a screenshot first', 'warn');
            ocrBtn.disabled = true;
            ocrStatus.hidden = false;
            ocrStatus.innerHTML = `<div class="imp2-ocr-bar"><div class="imp2-ocr-bar-fill" style="width:5%"></div></div><div class="imp2-ocr-msg">Loading OCR engine…</div>`;
            const barFill = ocrStatus.querySelector('.imp2-ocr-bar-fill');
            const msgEl = ocrStatus.querySelector('.imp2-ocr-msg');
            try {
              const expectedRaces = raceCodes.length || 0;
              const result = await ocrScreenshotMatrix(imageDataUrl, expectedRaces, (p) => {
                if (barFill) barFill.style.width = `${Math.round(p.progress * 100)}%`;
                if (msgEl) msgEl.textContent = `${p.status}…`;
              });
              if (!result.drivers.length) {
                ocrStatus.innerHTML = `<div class="imp2-ocr-msg" style="color:var(--red-light)">⚠ No driver rows detected. Try a higher-resolution screenshot or fill the grid manually.</div>`;
                ocrBtn.disabled = false;
                return;
              }
              const maxCells = result.drivers.reduce((m, d) => Math.max(m, d.cells.length), 0);
              if (!raceCodes.length && maxCells > 0) {
                raceCodes = Array.from({ length: maxCells }, (_, i) => `R${i + 1}`);
                racesInp.value = raceCodes.join(' ');
              }
              drivers = result.drivers.map(d => ({
                name: d.name,
                team: d.team,
                cells: d.cells.slice(0, raceCodes.length).concat(
                  Array(Math.max(0, raceCodes.length - d.cells.length)).fill('')
                ),
              }));
              ensureCellsLength();
              renderMatrix();
              updatePreviewStatus();
              ocrStatus.innerHTML = `<div class="imp2-ocr-msg" style="color:var(--sec-green)">✓ Extracted ${result.drivers.length} driver name${result.drivers.length === 1 ? '' : 's'} + team${result.drivers.length === 1 ? '' : 's'}. <b>Now fill the race cells manually</b> using the grid below — codes like <code>1</code>, <code>1P</code>, <code>26</code>, <code>DNF</code>.</div>`;
              ocrBtn.disabled = false;
            } catch (err) {
              ocrStatus.innerHTML = `<div class="imp2-ocr-msg" style="color:var(--red-light)">⚠ ${esc(err.message || 'OCR failed')}</div>`;
              ocrBtn.disabled = false;
            }
          };
        }
      };
      renderShot();

      const racesInp = $('#imp2-races', root);
      const calSel = $('#imp2-cal-preset', root);
      const updateRaceCodes = () => {
        raceCodes = racesInp.value.trim().split(/\s+/).filter(Boolean).map(s => s.toUpperCase());
        ensureCellsLength();
        renderMatrix();
      };
      racesInp.oninput = updateRaceCodes;
      $('#imp2-fill-codes', root).onclick = () => {
        const pid = calSel.value;
        if (!pid) { toast('Pick a calendar preset first', 'warn'); return; }
        const preset = (state.calendarPresets || []).find(p => p.id === pid);
        if (!preset) return;
        const codes = preset.races.slice().sort((a, b) => (a.round || 0) - (b.round || 0))
          .map(r => (r.country || '').toUpperCase().trim()).filter(Boolean);
        racesInp.value = codes.join(' ');
        updateRaceCodes();
        toast(`Filled ${codes.length} codes from "${preset.name}"`, 'success');
      };

      const matrixWrap = $('#imp2-matrix', root);
      const renderMatrix = () => {
        if (!raceCodes.length) {
          matrixWrap.innerHTML = `<div class="imp2-matrix-empty">Type some race codes above to start building the grid (e.g. <code>BHR SAU AUS</code>).</div>`;
          return;
        }
        matrixWrap.innerHTML = `
          <div class="imp2-matrix-scroll">
            <table class="imp2-matrix-table">
              <thead>
                <tr>
                  <th class="imp2-pos">#</th>
                  <th class="imp2-name">Driver</th>
                  <th class="imp2-team">Team</th>
                  ${raceCodes.map((c, i) => `<th class="imp2-race" title="Race ${i+1}">${esc(c)}</th>`).join('')}
                  <th class="imp2-del"></th>
                </tr>
              </thead>
              <tbody>
                ${drivers.map((d, ri) => `
                  <tr data-row="${ri}">
                    <td class="imp2-pos">${ri + 1}</td>
                    <td class="imp2-name"><input type="text" data-field="name" data-row="${ri}" value="${esc(d.name)}" placeholder="Driver name"></td>
                    <td class="imp2-team"><input type="text" data-field="team" data-row="${ri}" value="${esc(d.team)}" placeholder="Team"></td>
                    ${raceCodes.map((_, ci) => `<td class="imp2-cell"><input type="text" data-field="cell" data-row="${ri}" data-col="${ci}" value="${esc(d.cells[ci] || '')}" placeholder="—" maxlength="5"></td>`).join('')}
                    <td class="imp2-del">
                      <button type="button" class="btn btn-sm btn-danger btn-icon" data-act="del-row" data-row="${ri}" title="Remove driver">✕</button>
                    </td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>`;

        $$('input[data-field]', matrixWrap).forEach(inp => {
          inp.oninput = () => {
            const ri = Number(inp.dataset.row);
            const f = inp.dataset.field;
            if (!drivers[ri]) return;
            if (f === 'cell') {
              const ci = Number(inp.dataset.col);
              drivers[ri].cells[ci] = inp.value.trim().toUpperCase();
              const parsed = parseImportResultCell(inp.value);
              inp.classList.toggle('imp2-bad', !!inp.value.trim() && !parsed);
              inp.classList.toggle('imp2-pole', !!parsed?.pole);
            } else {
              drivers[ri][f] = inp.value;
            }
            updatePreviewStatus();
          };
          inp.onkeydown = (e) => {
            if (e.key === 'Enter' && inp.dataset.field === 'cell') {
              e.preventDefault();
              const ri = Number(inp.dataset.row);
              const ci = Number(inp.dataset.col);
              const next = matrixWrap.querySelector(`input[data-field="cell"][data-row="${ri+1}"][data-col="${ci}"]`);
              if (next) { next.focus(); next.select(); }
            }
          };
        });
        $$('[data-act="del-row"]', matrixWrap).forEach(b => {
          b.onclick = () => {
            const ri = Number(b.dataset.row);
            drivers.splice(ri, 1);
            renderMatrix();
            updatePreviewStatus();
          };
        });
      };
      renderMatrix();

      const statusEl = $('#imp2-preview-status', root);
      const updatePreviewStatus = () => {
        const filledDrivers = drivers.filter(d => d.name.trim()).length;
        const filledCells = drivers.reduce((s, d) => s + d.cells.filter(c => c && parseImportResultCell(c)).length, 0);
        const totalCells = drivers.length * raceCodes.length;
        const driverMatches = drivers.filter(d => d.name.trim() && matchDriverPresetForName(d.name)).length;
        const teamMatches = [...new Set(drivers.map(d => d.team.trim()).filter(Boolean))]
          .filter(t => matchTeamPresetForName(t)).length;
        const parts = [];
        parts.push(`<span style="color:var(--text-soft)">● ${filledDrivers} drivers</span>`);
        parts.push(`<span style="color:var(--text-soft)">● ${filledCells}/${totalCells} cells filled</span>`);
        if (driverMatches) parts.push(`<span style="color:var(--sec-purple)">● ${driverMatches} drivers from preset library</span>`);
        if (teamMatches) parts.push(`<span style="color:var(--sec-green)">● ${teamMatches} teams from preset library</span>`);
        statusEl.innerHTML = `<div style="font-family:var(--f-mono);font-size:10px;color:var(--text-muted);margin-top:14px;padding:10px 12px;background:var(--bg-elev);border-radius:6px;border:1px solid var(--border-dim);line-height:1.8">${parts.join(' · ')}</div>`;
      };
      updatePreviewStatus();

      $('#imp2-add-row', root).onclick = () => {
        drivers.push({ name: '', team: '', cells: new Array(raceCodes.length).fill('') });
        renderMatrix();
        updatePreviewStatus();
      };
      $('#imp2-add-rows-20', root).onclick = () => {
        while (drivers.length < 20) {
          drivers.push({ name: '', team: '', cells: new Array(raceCodes.length).fill('') });
        }
        renderMatrix();
        updatePreviewStatus();
      };

      $('[data-act="cancel"]', root).onclick = close;
      $('[data-act="ok"]', root).onclick = async () => {
        if (!raceCodes.length) return toast('Add some race codes first', 'error');
        const filled = drivers.filter(d => d.name.trim());
        if (!filled.length) return toast('Add at least one driver', 'error');

        const ps = getPointsSystem($('#imp2-points', root).value);
        const parsedDrivers = filled.map((d, idx) => {
          const cells = d.cells.map(c => parseImportResultCell(c));
          let pts = 0;
          cells.forEach((c) => {
            if (!c) return;
            if (c.dnf || c.dsq || c.dns || !c.position) return;
            if (c.position <= (ps.points?.length || 0)) pts += ps.points[c.position - 1];
            if (c.sprintPoints) pts += c.sprintPoints;
          });
          return {
            pos: idx + 1,
            name: d.name.trim(),
            team: d.team.trim() || 'Unassigned',
            points: pts,
            cells,
          };
        });
        parsedDrivers.sort((a, b) => b.points - a.points);
        parsedDrivers.forEach((d, i) => { d.pos = i + 1; });

        const parsed = { headers: raceCodes.slice(), drivers: parsedDrivers, errors: [], formatType: 'matrix' };
        const opts = {
          year: $('#imp2-year', root).value,
          name: $('#imp2-name', root).value,
          pointsSystemId: $('#imp2-points', root).value,
          raceCodes: raceCodes.slice(),
          calendarPresetId: calSel.value || null,
        };
        try {
          buildSeasonFromImport(parsed, opts);
          close();
          renderAll();
          await cloudPushNowBlocking('Uploading the imported season — this can take a few seconds.');
          toast(`Built season · ${parsedDrivers.length} drivers · ${raceCodes.length} races`, 'success');
        } catch (e) {
          toast('Build failed: ' + e.message, 'error');
        }
      };
    }
  });
}

/* =====================================================
   CSV IMPORT — full-season matrix from a .csv file
   ====================================================== */

// Split a single CSV line into fields. Handles "quoted, fields" with
// embedded escaped quotes ("" inside a quoted field).
function parseCSVLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else { cur += c; }
    } else {
      if (c === ',') { out.push(cur); cur = ''; }
      else if (c === '"' && cur === '') { inQuotes = true; }
      else { cur += c; }
    }
  }
  out.push(cur);
  return out.map(s => s.trim());
}

// Parse a single CSV result cell using the documented format.
// Returns { position, dnf, dsq, dns, pole, sprintPoints, fastestLap } or null
// for an empty cell. Reused by both the CSV importer and any other place
// that wants to accept that exact shorthand.
function parseCsvResultCell(raw) {
  if (raw == null) return null;
  let s = String(raw).trim().toUpperCase();
  if (!s || s === '-' || s === '—' || s === '–') return null;
  // Strip Unicode subscripts to regular digits (some spreadsheets export them)
  s = s.replace(/[₀₁₂₃₄₅₆₇₈₉]/g, c => '₀₁₂₃₄₅₆₇₈₉'.indexOf(c).toString());

  let position = null, dnf = false, dsq = false, dns = false;
  let rest = s;

  // 1. Result token: status keyword OR 1-2 digit position
  const statusMatch = rest.match(/^(DNF|DSQ|DNS|RET|EX|NC)/);
  if (statusMatch) {
    const code = statusMatch[1];
    if (code === 'DNF' || code === 'RET' || code === 'NC') dnf = true;
    else if (code === 'DSQ' || code === 'EX') dsq = true;
    else if (code === 'DNS') dns = true;
    rest = rest.slice(code.length);
  } else {
    const posMatch = rest.match(/^(\d{1,2})/);
    if (!posMatch) return null;
    position = parseInt(posMatch[1], 10);
    if (position < 1 || position > 30) return null;
    rest = rest.slice(posMatch[1].length);
  }

  // 2. Optional P (pole)
  let pole = false;
  if (rest.startsWith('P')) {
    pole = true;
    rest = rest.slice(1);
  }

  // 3. Optional /N (sprint points)
  let sprintPoints = 0;
  const sprintMatch = rest.match(/^\/(\d+)/);
  if (sprintMatch) {
    sprintPoints = parseInt(sprintMatch[1], 10) || 0;
    rest = rest.slice(sprintMatch[0].length);
  }

  // 4. Optional trailing F (fastest lap) — edge case: DNF already ended on F,
  //    so a DNF + FL would be "DNFF" (we already consumed DNF, rest === 'F')
  let fastestLap = false;
  if (rest === 'F') {
    fastestLap = true;
    rest = '';
  }

  // Tolerate any leftover characters silently — the cell still parses

  return { position, dnf, dsq, dns, pole, sprintPoints, fastestLap };
}

// Parse the entire CSV text body into a normalised structure the existing
// buildSeasonFromImport pipeline can consume.
function parseSeasonCSV(csvText) {
  const lines = csvText.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) throw new Error('CSV needs a header row and at least one driver row');
  const header = parseCSVLine(lines[0]);
  if (header.length < 5) throw new Error('Header must include Position, Driver, Team, Points, then at least one race code');
  // Standard order: Position, Driver, Team, Points, then race columns
  const lowerHeader = header.map(h => h.toLowerCase());
  const posIdx = lowerHeader.findIndex(h => h.startsWith('pos'));
  const drvIdx = lowerHeader.findIndex(h => h.startsWith('driv'));
  const teamIdx = lowerHeader.findIndex(h => h.startsWith('team') || h.startsWith('const'));
  const ptsIdx = lowerHeader.findIndex(h => h.startsWith('pts') || h.startsWith('point'));
  if (drvIdx < 0) throw new Error('Header row missing a "Driver" column');
  // Race columns are everything after the four fixed columns. Use the max index
  // of the fixed columns as the boundary.
  const fixedEnd = Math.max(posIdx, drvIdx, teamIdx, ptsIdx) + 1;
  // Race columns may carry a points-multiplier suffix: "BEL*0.5" (half points,
  // e.g. 2021 Belgium) or "MIA*2" (double points). Strip it off the code used for
  // track matching and keep a parallel multiplier array.
  const rawRaceCodes = header.slice(fixedEnd).map(c => c.toUpperCase().trim()).filter(Boolean);
  const raceCodes = [];
  const raceMultipliers = [];
  rawRaceCodes.forEach(rc => {
    let code = rc, mult = 1;
    const star = rc.indexOf('*');
    if (star >= 0) {
      code = rc.slice(0, star).trim();
      const ms = rc.slice(star + 1).trim();
      if (ms === '0.5' || ms === '.5' || ms === 'H' || ms === 'HALF') mult = 0.5;
      else if (ms === '2' || ms === 'D' || ms === 'DOUBLE') mult = 2;
    }
    raceCodes.push(code);
    raceMultipliers.push(mult);
  });
  if (!raceCodes.length) throw new Error('No race columns found after Position/Driver/Team/Points');

  const drivers = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i]);
    if (cols.length < fixedEnd) continue;
    const name = (cols[drvIdx] || '').trim();
    if (!name) continue;
    const cells = raceCodes.map((_, ri) => parseCsvResultCell(cols[fixedEnd + ri] || ''));
    drivers.push({
      pos: posIdx >= 0 ? parseInt(cols[posIdx], 10) || (drivers.length + 1) : (drivers.length + 1),
      name,
      team: teamIdx >= 0 ? (cols[teamIdx] || '').trim() : '',
      points: ptsIdx >= 0 ? parseInt((cols[ptsIdx] || '0').replace(/[^\d]/g, ''), 10) || 0 : 0,
      cells,
    });
  }
  if (!drivers.length) throw new Error('No driver rows found below the header');
  return { headers: raceCodes, raceMultipliers, drivers, errors: [], formatType: 'csv' };
}

function openImportCSVModal() {
  if (!state.activeSaveId) return toast('Open a save first', 'warn');
  let parsedCSV = null;

  modal({
    title: `<span class="accent">CSV Import</span> — Full Season`,
    size: 'wide',
    body: `
      <div class="field-help" style="margin-bottom:14px">
        Upload a CSV with the columns <code>Position, Driver, Team, Points</code> followed by race columns in calendar order (e.g. <code>BHR, SAU, AUS, ...</code>). Each cell uses the shorthand below.
      </div>

      <details style="margin-bottom:14px;background:var(--bg-elev);border-radius:6px;padding:10px 14px">
        <summary style="cursor:pointer;font-family:var(--f-mono);font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:var(--text-soft)">▸ Cell format reference</summary>
        <div style="font-family:var(--f-mono);font-size:10px;color:var(--text-muted);margin-top:10px;line-height:1.7">
          Each cell is built from up to four parts (in this exact order):<br>
          <b style="color:var(--text)">Result</b> — position (<code>1</code>, <code>2</code>, <code>17</code>) or status (<code>DNF</code>, <code>DSQ</code>, <code>DNS</code>). Empty cell = didn't compete.<br>
          <b style="color:var(--text)">P</b> — pole position in the main race<br>
          <b style="color:var(--text)">/N</b> — sprint points (1-8) on sprint weekends<br>
          <b style="color:var(--text)">F</b> — fastest lap (1 championship pt if in top 10)<br><br>
          <b style="color:var(--text)">Examples</b><br>
          <code>4</code> — finished 4th<br>
          <code>1P</code> — won from pole<br>
          <code>2F</code> — 2nd + fastest lap<br>
          <code>3P/7</code> — 3rd from pole + 7 sprint pts (= sprint P2)<br>
          <code>1P/8F</code> — won from pole, won the sprint, set FL (perfect weekend)<br>
          <code>DNF/3</code> — retired, 3 sprint pts (= sprint P6)<br>
          <code>DSQ</code> — disqualified<br>
          <i>(empty)</i> — did not compete this round<br><br>
          <b style="color:var(--text)">Race column suffix</b> (in the header row)<br>
          <code>BEL*0.5</code> — half points for that race (e.g. 2021 Belgium)<br>
          <code>MIA*2</code> — double points for that race
        </div>
      </details>

      <div class="field-row">
        <div class="field"><label>Year</label><input type="number" id="csv-year" value="${new Date().getFullYear()}"></div>
        <div class="field"><label>Season Name</label><input type="text" id="csv-name" placeholder="e.g. 2024 F1 World Championship"></div>
      </div>
      <div class="field">
        <label>Points System</label>
        <select id="csv-points">
          ${POINTS_SYSTEMS.map(p => `<option value="${p.id}" ${p.id === DEFAULT_POINTS_SYSTEM_ID ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label>Match races to a saved calendar preset <span style="font-weight:400;color:var(--text-muted);font-family:var(--f-body)">(optional)</span></label>
        <select id="csv-cal-preset">
          <option value="">— Use the CSV's race codes verbatim —</option>
          ${(state.calendarPresets || []).map(p => `<option value="${esc(p.id)}">${esc(p.name)} · ${p.races.length} round${p.races.length === 1 ? '' : 's'}</option>`).join('')}
        </select>
      </div>

      <div class="field">
        <label>CSV file</label>
        <div id="csv-drop-mount"></div>
      </div>

      <div class="field">
        <label>…or paste CSV text directly</label>
        <textarea id="csv-text" rows="8" placeholder='Position,Driver,Team,Points,BHR,SAU,AUS,...
1,Max Verstappen,Red Bull,575,1P,2,1P/8F,...' style="font-family:var(--f-mono);font-size:11px;width:100%;min-height:160px"></textarea>
      </div>

      <div id="csv-preview"></div>`,
    footer: `<button class="btn btn-ghost" data-act="cancel">Cancel</button><button class="btn btn-ghost" data-act="parse">⚙ VALIDATE</button><button class="btn btn-primary" data-act="ok" disabled>Build Season</button>`,
    onMount: (root, close) => {
      const ta = $('#csv-text', root);
      const preview = $('#csv-preview', root);
      const okBtn = $('[data-act="ok"]', root);
      const calSel = $('#csv-cal-preset', root);

      // File-drop / picker
      const dropMount = $('#csv-drop-mount', root);
      dropMount.innerHTML = `
        <label class="csv-drop">
          <input type="file" accept=".csv,text/csv,text/plain" style="display:none">
          <div class="csv-drop-icon">📊</div>
          <div class="csv-drop-title">Click to choose a CSV file</div>
          <div class="csv-drop-sub">Or paste the CSV text into the textarea below. UTF-8 encoding recommended.</div>
        </label>
        <div class="csv-drop-filename" id="csv-drop-filename" hidden></div>`;
      const fileInp = dropMount.querySelector('input[type="file"]');
      const fileLabel = $('#csv-drop-filename', root);
      fileInp.onchange = async () => {
        const f = fileInp.files[0]; if (!f) return;
        try {
          const text = await f.text();
          ta.value = text;
          fileLabel.hidden = false;
          fileLabel.textContent = `✓ Loaded ${f.name} (${(f.size / 1024).toFixed(1)} KB)`;
          validate();
        } catch (e) { toast('Could not read file: ' + e.message, 'error'); }
      };

      const validate = () => {
        const raw = ta.value;
        if (!raw.trim()) {
          preview.innerHTML = '<div class="empty-row" style="padding:14px">Upload a CSV file or paste CSV text to validate.</div>';
          okBtn.disabled = true; parsedCSV = null; return;
        }
        try {
          parsedCSV = parseSeasonCSV(raw);
        } catch (e) {
          preview.innerHTML = `<div class="storage-warning" style="margin-top:14px"><div class="storage-warning-head">⚠ Couldn't parse</div><div class="storage-warning-body">${esc(e.message)}</div></div>`;
          okBtn.disabled = true; parsedCSV = null; return;
        }
        okBtn.disabled = false;

        // Stats for the preview header
        const r = parsedCSV;
        const totalCells = r.drivers.length * r.headers.length;
        const filledCells = r.drivers.reduce((s, d) => s + d.cells.filter(Boolean).length, 0);
        const totalPoles = r.drivers.reduce((s, d) => s + d.cells.filter(c => c?.pole).length, 0);
        const totalFLs = r.drivers.reduce((s, d) => s + d.cells.filter(c => c?.fastestLap).length, 0);
        const totalSprintPts = r.drivers.reduce((s, d) => s + d.cells.reduce((sp, c) => sp + (c?.sprintPoints || 0), 0), 0);
        const driverHits = r.drivers.filter(d => matchDriverPresetForName(d.name)).length;
        const teamHits = [...new Set(r.drivers.map(d => d.team).filter(Boolean))]
          .filter(t => matchTeamPresetForName(t) || F1_TEAM_NORMALIZER[t.toLowerCase().trim()]).length;

        const status = [
          `<span style="color:var(--text-soft)">● ${r.drivers.length} drivers · ${r.headers.length} races</span>`,
          `<span style="color:var(--text-soft)">● ${filledCells}/${totalCells} cells filled</span>`,
          totalPoles ? `<span style="color:var(--sec-blue)">● ${totalPoles} poles</span>` : null,
          totalFLs ? `<span style="color:var(--sec-purple)">● ${totalFLs} fastest laps</span>` : null,
          totalSprintPts ? `<span style="color:var(--sec-yellow)">● ${totalSprintPts} sprint points</span>` : null,
          driverHits ? `<span style="color:var(--sec-purple)">● ${driverHits} drivers from preset library</span>` : null,
          teamHits ? `<span style="color:var(--sec-green)">● ${teamHits} teams from preset library</span>` : null,
        ].filter(Boolean).join(' · ');

        preview.innerHTML = `
          <div style="margin-top:16px">
            <div style="font-family:var(--f-mono);font-size:10px;color:var(--text-muted);margin-bottom:10px;padding:10px 12px;background:var(--bg-elev);border-radius:6px;border:1px solid var(--border-dim);line-height:1.8">
              ${status}
            </div>
            <div style="overflow-x:auto;border:1px solid var(--border-dim);border-radius:6px;max-height:380px;overflow-y:auto">
              <table style="border-collapse:collapse;font-family:var(--f-mono);font-size:11px;width:max-content;min-width:100%">
                <thead><tr style="background:var(--bg-elev)">
                  <th style="padding:8px 10px;text-align:left;border-bottom:1px solid var(--border)">POS</th>
                  <th style="padding:8px 10px;text-align:left;border-bottom:1px solid var(--border)">DRIVER</th>
                  <th style="padding:8px 10px;text-align:left;border-bottom:1px solid var(--border)">TEAM</th>
                  <th style="padding:8px 10px;text-align:right;border-bottom:1px solid var(--border)">PTS</th>
                  ${r.headers.map(h => `<th style="padding:8px 6px;text-align:center;border-bottom:1px solid var(--border);font-size:9px;letter-spacing:0.12em">${esc(h)}</th>`).join('')}
                </tr></thead>
                <tbody>
                  ${r.drivers.map(d => `
                    <tr style="border-bottom:1px solid var(--border-dim)">
                      <td style="padding:6px 10px;color:var(--text-muted)">${d.pos}</td>
                      <td style="padding:6px 10px;font-weight:600;white-space:nowrap">${esc(d.name)}</td>
                      <td style="padding:6px 10px;color:var(--text-soft);white-space:nowrap">${esc(d.team)}</td>
                      <td style="padding:6px 10px;text-align:right;font-weight:700">${d.points}</td>
                      ${d.cells.map(c => {
                        if (!c) return `<td style="padding:6px;text-align:center;color:var(--text-dim);opacity:0.5">—</td>`;
                        let txt = '', col = 'var(--text)';
                        if (c.dnf) { txt = 'DNF'; col = 'var(--red)'; }
                        else if (c.dsq) { txt = 'DSQ'; col = 'var(--red)'; }
                        else if (c.dns) { txt = 'DNS'; col = 'var(--text-muted)'; }
                        else if (c.position) {
                          txt = String(c.position);
                          if (c.position === 1) col = 'var(--gold)';
                          else if (c.position === 2) col = 'var(--silver)';
                          else if (c.position === 3) col = 'var(--bronze)';
                          else if (c.position > 10) col = 'var(--text-muted)';
                        }
                        if (c.pole) txt += `<sup style="color:var(--sec-blue);font-size:8px">P</sup>`;
                        if (c.fastestLap) txt = `<span style="text-decoration:underline;text-decoration-color:var(--sec-purple);text-decoration-thickness:1.5px">${txt}</span>`;
                        if (c.sprintPoints > 0) txt += `<sub style="color:var(--sec-yellow);font-size:8px;margin-left:1px">${c.sprintPoints}</sub>`;
                        return `<td style="padding:6px;text-align:center;color:${col};font-weight:600">${txt}</td>`;
                      }).join('')}
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
            <div class="field-help" style="margin-top:10px">Driver / team / track presets resolve automatically on build. POLE, FASTEST LAP and SPRINT POINTS shown above will all be set on the resulting races.</div>
          </div>`;
      };

      ta.oninput = () => { if (parsedCSV) { parsedCSV = null; okBtn.disabled = true; } };
      $('[data-act="parse"]', root).onclick = validate;
      $('[data-act="cancel"]', root).onclick = close;
      okBtn.onclick = async () => {
        if (!parsedCSV) return validate();
        try {
          buildSeasonFromImport(parsedCSV, {
            year: $('#csv-year', root).value,
            name: $('#csv-name', root).value,
            pointsSystemId: $('#csv-points', root).value,
            raceCodes: parsedCSV.headers,
            calendarPresetId: calSel.value || null,
          });
          close();
          renderAll();
          await cloudPushNowBlocking('Uploading the imported season — this can take a few seconds.');
          toast(`Built season · ${parsedCSV.drivers.length} drivers · ${parsedCSV.headers.length} races`, 'success');
        } catch (e) {
          toast('Build failed: ' + e.message, 'error');
        }
      };
    }
  });
}

/* ---------- driver preset search ---------- */
/* ---------------------------------------------------------------
   PRESET LIBRARY — defaults + per-user overrides + customs.
   Each preset has a stable key (`name|era`) used to look up edits.
   --------------------------------------------------------------- */
function presetKey(p) { return `${(p.name || '').toLowerCase()}|${p.era || ''}`; }
/* A preset can belong to several decades/eras. `eras` (array) is the source of
   truth when present; legacy presets with a single `era` string still work. The
   `era` field is kept as the stable "primary" era used for the preset key. */
function presetEras(p) {
  if (Array.isArray(p.eras) && p.eras.length) return p.eras;
  return p.era ? [p.era] : [];
}
const presetEraLabel = (p) => presetEras(p).join(' · ') || '—';

/* Collapse presets that share a name into ONE multi-era entry. Removes the visual
   duplicates created when the same team/driver exists in more than one era block
   (e.g. Ferrari in both 'Current' and '2026'), while preserving every era it
   belongs to and merging in any data (logo, abbr, team) from either copy. The
   first occurrence is canonical (customs precede built-ins; newer era blocks
   precede older), so its key/flags drive edits and deletes. */
function dedupePresetsByName(list) {
  const byName = new Map();
  const order = [];
  for (const p of list) {
    const k = (p.name || '').toLowerCase().trim();
    if (!k) { order.push(p); continue; }
    if (!byName.has(k)) {
      const entry = { ...p, eras: [...presetEras(p)] };
      byName.set(k, entry);
      order.push(entry);
    } else {
      const ex = byName.get(k);
      presetEras(p).forEach(e => { if (!ex.eras.includes(e)) ex.eras.push(e); });
      ['abbr', 'team', 'logo', 'photo', 'color', 'short', 'country', 'number'].forEach(f => {
        const cur = ex[f];
        if ((cur === undefined || cur === '' || cur === null) && p[f] !== undefined && p[f] !== '' && p[f] !== null) ex[f] = p[f];
      });
      // Multi-photo gallery array — carry it over if the canonical entry lacks one.
      if ((!Array.isArray(ex.photos) || !ex.photos.length) && Array.isArray(p.photos) && p.photos.length) ex.photos = p.photos;
    }
  }
  return order;
}

/* Find a saved override for a built-in preset. Prefer the exact `name|era` key,
   but fall back to ANY override stored under the same NAME (different era). This
   keeps saved edits — especially uploaded photos/logos — attached to a preset
   even when a new code version changes that preset's era / primary key (which
   would otherwise orphan the override and make the image "disappear"). */
function findPresetOverride(overrides, p) {
  if (!overrides) return null;
  const exact = overrides[presetKey(p)];
  if (exact) return exact;
  const name = (p.name || '').toLowerCase().trim();
  if (!name) return null;
  for (const k in overrides) {
    if ((k.split('|')[0] || '').trim() === name) return overrides[k];
  }
  return null;
}

/* Map of driver-name -> photo, gathered from every signed driver across all
   saves/seasons. Used so the preset library can show a driver's photo that still
   lives on a season entry even if it was never saved back onto the preset. */
function collectSeasonDriverPhotos() {
  const map = {};
  Object.values(state.saves || {}).forEach(save => {
    Object.values(save.seasons || {}).forEach(season => {
      (season.drivers || []).forEach(d => {
        const k = (d.name || '').toLowerCase().trim();
        if (k && d.photo && !map[k]) map[k] = d.photo;
      });
    });
  });
  return map;
}

function getEffectiveDriverPresets() {
  const overrides = state.presetOverrides?.drivers || {};
  const hidden = new Set(state.hiddenPresets?.drivers || []);
  const merged = DRIVER_PRESETS.filter(p => !hidden.has(presetKey(p))).map(p => {
    const k = presetKey(p);
    const ov = findPresetOverride(overrides, p);
    return ov ? { ...p, ...ov, presetKey: k, isBuiltin: true } : { ...p, presetKey: k, isBuiltin: true };
  });
  const customs = (state.customDriverPresets || []).map(p => ({ ...p, presetKey: presetKey(p), isCustom: true }));
  const result = dedupePresetsByName([...customs, ...merged]);
  // Fallback: if a preset has no photo, borrow it from a signed season driver of
  // the same name — so re-importing code that lacks the photo doesn't blank the
  // preset library while the image still exists on the seasons.
  const seasonPhotos = collectSeasonDriverPhotos();
  result.forEach(p => {
    const hasPhoto = p.photo || (Array.isArray(p.photos) && p.photos.some(x => x && x.url));
    if (!hasPhoto) {
      const ph = seasonPhotos[(p.name || '').toLowerCase().trim()];
      if (ph) p.photo = ph;
    }
  });
  return result;
}

function getEffectiveTeamPresets() {
  const overrides = state.presetOverrides?.teams || {};
  const hidden = new Set(state.hiddenPresets?.teams || []);
  const merged = TEAM_PRESETS.filter(p => !hidden.has(presetKey(p))).map(p => {
    const k = presetKey(p);
    const ov = findPresetOverride(overrides, p);
    return ov ? { ...p, ...ov, presetKey: k, isBuiltin: true } : { ...p, presetKey: k, isBuiltin: true };
  });
  const customs = (state.customTeamPresets || []).map(p => ({ ...p, presetKey: presetKey(p), isCustom: true }));
  return dedupePresetsByName([...customs, ...merged]);
}

function getEffectiveTrackPresets() {
  const overrides = state.presetOverrides?.tracks || {};
  const hidden = new Set(state.hiddenPresets?.tracks || []);
  const merged = TRACK_PRESETS.filter(p => !hidden.has(presetKey(p))).map(p => {
    const k = presetKey(p);
    const ov = findPresetOverride(overrides, p);
    return ov ? { ...p, ...ov, presetKey: k, isBuiltin: true } : { ...p, presetKey: k, isBuiltin: true };
  });
  const customs = (state.customTrackPresets || []).map(p => ({ ...p, presetKey: presetKey(p), isCustom: true }));
  return dedupePresetsByName([...customs, ...merged]);
}

/* Save an edit to a preset. For built-ins, write to overrides. For customs, replace in array. */
function presetCustomField(kind) {
  return kind === 'driver' ? 'customDriverPresets'
       : kind === 'team'   ? 'customTeamPresets'
       : 'customTrackPresets';
}
function presetOverridesField(kind) {
  return kind === 'driver' ? 'drivers'
       : kind === 'team'   ? 'teams'
       : 'tracks';
}

function savePresetEdit(kind, originalKey, updated) {
  if (!state.presetOverrides) state.presetOverrides = { drivers: {}, teams: {}, tracks: {} };
  if (!state.presetOverrides.tracks) state.presetOverrides.tracks = {};
  const target = presetOverridesField(kind);
  const customField = presetCustomField(kind);
  const customs = state[customField] || [];
  const customIdx = customs.findIndex(p => presetKey(p) === originalKey);
  // Capture the previous image so we can tell whether the photo/logo actually changed.
  const prevStore = customIdx >= 0 ? customs[customIdx] : state.presetOverrides[target][originalKey];
  const prevPhoto = (prevStore && prevStore.photo) || '';
  const prevLogo = (prevStore && prevStore.logo) || '';
  if (customIdx >= 0) {
    customs[customIdx] = { ...customs[customIdx], ...updated };
    state[customField] = customs;
  } else {
    state.presetOverrides[target][originalKey] = updated;
  }
  saveState();
  // Editing a preset's image flows through to entries already added to a season —
  // overwrite when the image CHANGED, fill any entry that has no image, and never
  // clear (so editing other fields won't wipe photos).
  if (kind === 'team') {
    const synced = syncTeamImageToSeasons(originalKey, updated.name, updated.logo, prevLogo);
    if (synced) { saveState(); renderMain(); }
  } else if (kind === 'driver') {
    const synced = syncDriverPhotoToSeasons(originalKey, updated.name, updated.photo, prevPhoto);
    if (synced) { saveState(); renderMain(); }
  }
}

/* Ensure every season team keeps its logo. If a team has no logo (e.g. the cloud
   round-trip dropped it), pull the image back from its matching preset in the
   local library. Only fills blanks — never overwrites a logo the team already has. */
function backfillTeamLogosFromPresets() {
  try {
    Object.values(state.saves || {}).forEach(save => {
      Object.values(save.seasons || {}).forEach(season => {
        (season.teams || []).forEach(t => {
          if (t.logo) return;
          const preset = matchTeamPresetForName(t.name);
          if (preset && preset.logo) t.logo = preset.logo;
        });
      });
    });
  } catch {}
}

/* Driver photos aren't persisted in localStorage (see stateForStorage). Re-hydrate
   each season driver's photo from its matching preset so the image is back after a
   reload. Only fills blanks. */
function backfillDriverPhotosFromPresets() {
  try {
    Object.values(state.saves || {}).forEach(save => {
      Object.values(save.seasons || {}).forEach(season => {
        (season.drivers || []).forEach(d => {
          if (d.photo) return;
          const preset = matchDriverPresetForName(d.name);
          const ph = preset ? defaultPresetPhoto(preset) : '';
          if (ph) d.photo = ph;
        });
      });
    });
  } catch {}
}

/* Push an edited team preset's logo onto matching season teams. Overwrites when
   the logo CHANGED; fills any team that has no logo; never clears. Matches by the
   preset link or by name (so a Ferrari already in the season updates too). */
function syncTeamImageToSeasons(originalKey, name, logo, prevLogo) {
  if (!logo) return 0; // nothing to push, and never wipe an existing logo
  const nameKey = (name || '').toLowerCase().trim();
  const logoChanged = logo !== (prevLogo || '');
  let changed = 0;
  Object.values(state.saves || {}).forEach(save => {
    Object.values(save.seasons || {}).forEach(season => {
      (season.teams || []).forEach(t => {
        const matches = (t.presetKey && t.presetKey === originalKey)
          || (nameKey && (t.name || '').toLowerCase().trim() === nameKey);
        if (matches && (logoChanged || !t.logo)) { t.logo = logo; changed++; }
      });
    });
  });
  return changed;
}

/* Same as above for driver preset photos: when a driver preset's photo is edited,
   overwrite the matching season drivers' photo if it changed, and fill any season
   driver that has no photo. Never clears. */
function syncDriverPhotoToSeasons(originalKey, name, photo, prevPhoto) {
  if (!photo) return 0;
  const nameKey = (name || '').toLowerCase().trim();
  const photoChanged = photo !== (prevPhoto || '');
  let changed = 0;
  Object.values(state.saves || {}).forEach(save => {
    Object.values(save.seasons || {}).forEach(season => {
      (season.drivers || []).forEach(d => {
        const matches = (d.presetKey && d.presetKey === originalKey)
          || (nameKey && (d.name || '').toLowerCase().trim() === nameKey);
        if (matches && (photoChanged || !d.photo)) { d.photo = photo; changed++; }
      });
    });
  });
  return changed;
}

function addCustomPreset(kind, data) {
  const field = presetCustomField(kind);
  if (!state[field]) state[field] = [];
  state[field].push(data);
  saveState();
}

function deleteCustomPreset(kind, key) {
  const field = presetCustomField(kind);
  state[field] = (state[field] || []).filter(p => presetKey(p) !== key);
  saveState();
}

/* Delete (hide) a built-in preset from the library. The default lives in code,
   so we remember its key and filter it out of the effective list. Any saved edit
   override for it is dropped too. */
function hideBuiltinPreset(kind, key) {
  if (!state.hiddenPresets) state.hiddenPresets = { drivers: [], teams: [], tracks: [] };
  const field = presetOverridesField(kind);
  if (!state.hiddenPresets[field]) state.hiddenPresets[field] = [];
  // A displayed preset may be a de-duplicated merge of several same-name built-ins
  // (e.g. Ferrari across 'Current' + '2026'). Hide ALL of them so it doesn't
  // reappear from another era block.
  const source = kind === 'driver' ? DRIVER_PRESETS : kind === 'team' ? TEAM_PRESETS : TRACK_PRESETS;
  const name = (key.split('|')[0] || '').trim();
  const keys = new Set([key]);
  source.forEach(p => { if ((p.name || '').toLowerCase().trim() === name) keys.add(presetKey(p)); });
  keys.forEach(k => {
    if (!state.hiddenPresets[field].includes(k)) state.hiddenPresets[field].push(k);
    if (state.presetOverrides?.[field]) delete state.presetOverrides[field][k];
  });
  saveState();
}

function resetPresetOverride(kind, key) {
  const target = presetOverridesField(kind);
  if (state.presetOverrides && state.presetOverrides[target]) {
    delete state.presetOverrides[target][key];
    saveState();
  }
}

/* Preset editor — used for both adding new and editing existing.
   `kind` = 'driver' | 'team'. `existing` = preset object or null for new. */
function openPresetEditor(kind, existing, onSaved) {
  const isEdit = !!existing;
  const isDriver = kind === 'driver';
  const isTeam   = kind === 'team';
  const isTrack  = kind === 'track';

  let data;
  if (existing) {
    data = { ...existing };
  } else if (isDriver) {
    data = { name: '', country: '', number: 1, abbr: '', photo: '', era: 'Current' };
  } else if (isTeam) {
    data = { name: '', short: '', color: '#e10600', country: '', logo: '', era: 'Current' };
  } else { // track
    data = { name: '', circuit: '', country: '', length: '', sprint: false, flagImage: '', era: 'Current' };
  }
  const originalKey = existing ? presetKey(existing) : null;

  const _selEras = presetEras(data);
  const eraChipsHtml = `<div class="field">
      <label>Eras / Decades <span style="font-weight:400;color:var(--text-muted);font-family:var(--f-body);text-transform:none;letter-spacing:0">— pick one or more (e.g. a driver across several decades)</span></label>
      <div class="era-chips" id="pe-era">
        ${ERA_FILTERS.filter(e => e !== 'All').map(e =>
          `<label class="era-chip${_selEras.includes(e) ? ' active' : ''}"><input type="checkbox" class="pe-era-cb" value="${e}" ${_selEras.includes(e) ? 'checked' : ''}><span>${e}</span></label>`).join('')}
      </div>
    </div>`;

  const driverFields = `
    <div class="field-row">
      <div class="field"><label>Driver Name</label><input type="text" id="pe-name" value="${esc(data.name)}" placeholder="e.g. Lewis Hamilton"></div>
      <div class="field" style="max-width:120px"><label>Number</label><input type="number" id="pe-number" min="1" max="99" value="${data.number || 1}"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Country (3-letter code)</label><input type="text" id="pe-country" value="${esc(data.country)}" placeholder="GBR" maxlength="3" style="text-transform:uppercase"></div>
      <div class="field"><label>Abbreviation</label><input type="text" id="pe-abbr" value="${esc(data.abbr || '')}" placeholder="HAM" maxlength="3" style="text-transform:uppercase"></div>
    </div>
    ${eraChipsHtml}
    <div class="field">
      <label>Driver Photos <span style="font-weight:400;color:var(--text-muted);font-family:var(--f-body);text-transform:none;letter-spacing:0">— add as many as you like (career eras, helmet variants, etc.)</span></label>
      <div id="pe-photo-mount"></div>
      <span class="field-help">Each driver signed from this preset can pick which photo to use. Mark one as <b>default</b> for auto-import (e.g. F1 paste imports).</span>
    </div>`;

  const teamFields = `
    <div class="field-row">
      <div class="field"><label>Team Name</label><input type="text" id="pe-name" value="${esc(data.name)}" placeholder="e.g. Williams Racing"></div>
      <div class="field" style="max-width:120px"><label>Short</label><input type="text" id="pe-short" value="${esc(data.short)}" placeholder="WIL" maxlength="4" style="text-transform:uppercase"></div>
    </div>
    <div class="field"><label>Country (3-letter code)</label><input type="text" id="pe-country" value="${esc(data.country)}" placeholder="GBR" maxlength="3" style="text-transform:uppercase"></div>
    ${eraChipsHtml}
    <div class="field-row">
      <div class="field" style="max-width:160px">
        <label>Team Colour</label>
        <input type="color" id="pe-color" value="${esc(data.color || '#e10600')}" style="height:38px;padding:2px;cursor:pointer">
      </div>
      <div class="field"><label>Hex</label><input type="text" id="pe-color-hex" value="${esc(data.color || '#e10600')}" placeholder="#e10600"></div>
    </div>
    <div class="field">
      <label>Team Logo (optional)</label>
      <div id="pe-logo-mount"></div>
      <span class="field-help">Colour and logo are saved with the preset.</span>
    </div>`;

  const trackFields = `
    <div class="field"><label>Race Name</label><input type="text" id="pe-name" value="${esc(data.name)}" placeholder="e.g. British Grand Prix"></div>
    <div class="field-row">
      <div class="field"><label>Circuit</label><input type="text" id="pe-circuit" value="${esc(data.circuit || '')}" placeholder="e.g. Silverstone"></div>
      <div class="field" style="max-width:160px"><label>Length (km)</label><input type="number" id="pe-length" step="0.001" min="0" value="${data.length || ''}" placeholder="5.891"></div>
    </div>
    <div class="field"><label>Country code</label><input type="text" id="pe-country" value="${esc(data.country)}" placeholder="GBR" maxlength="3" style="text-transform:uppercase"></div>
    ${eraChipsHtml}
    <div class="field">
      <label>Flag</label>
      <div id="pe-flag-mount"></div>
      <span class="field-help">Auto-uses the country code emoji unless you upload a custom flag image (useful for fictional countries).</span>
    </div>
    <div class="field">
      <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
        <input type="checkbox" id="pe-sprint" ${data.sprint ? 'checked' : ''} style="width:18px;height:18px;accent-color:var(--red)">
        <span>Sprint format weekend</span>
      </label>
    </div>`;

  modal({
    title: `${isEdit ? 'Edit' : 'New'} <span class="accent">${isDriver ? 'Driver' : isTeam ? 'Team' : 'Track'}</span> Preset`,
    body: isDriver ? driverFields : isTeam ? teamFields : trackFields,
    footer: `${isEdit ? `${existing.isBuiltin ? '<button class="btn btn-ghost" data-act="reset">Reset to default</button>' : ''}<button class="btn btn-ghost" data-act="delete" style="color:var(--red);margin-right:auto">Delete preset</button>` : ''}<button class="btn btn-ghost" data-act="cancel">Cancel</button><button class="btn btn-primary" data-act="ok">Save preset</button>`,
    onMount: (root, close) => {
      // Photo / logo upload widgets
      const mountUpload = (containerId, currentValue, onChange) => {
        const el = $('#' + containerId, root);
        const renderUpload = () => {
          el.innerHTML = `
            <div class="photo-upload">
              <div class="photo-preview" style="background-image:url('${esc(currentValue || '')}')">${currentValue ? '' : '<span style="color:var(--text-muted);font-family:var(--f-mono);font-size:10px;letter-spacing:0.15em">NO IMAGE</span>'}</div>
              <div style="display:flex;flex-direction:column;gap:6px;flex:1">
                <label class="btn btn-ghost" style="cursor:pointer;text-align:center"><input type="file" accept="image/*" style="display:none">${currentValue ? '↻ REPLACE' : '↥ UPLOAD'}</label>
                ${currentValue ? '<button class="btn btn-ghost" data-clear style="color:var(--red)">× REMOVE</button>' : ''}
              </div>
            </div>`;
          el.querySelector('input[type="file"]').onchange = async (e) => {
            const f = e.target.files[0]; if (!f) return;
            try {
              const dataUrl = await fileToDataURL(f);
              currentValue = dataUrl;
              onChange(dataUrl);
              renderUpload();
            } catch (err) { toast(err.message || 'Could not load image', 'error'); }
          };
          if (el.querySelector('[data-clear]')) {
            el.querySelector('[data-clear]').onclick = () => { currentValue = ''; onChange(''); renderUpload(); };
          }
        };
        renderUpload();
      };

      if (isDriver) {
        data.photos = presetPhotosList(data);
        mountPhotoGallery($('#pe-photo-mount', root), data.photos, (next) => {
          data.photos = next;
          data.photo = (next.find(p => p.isDefault) || next[0])?.url || '';
        });
      } else if (isTeam) {
        mountUpload('pe-logo-mount', data.logo || '', (v) => { data.logo = v; });
        const cp = $('#pe-color', root);
        const hex = $('#pe-color-hex', root);
        cp.oninput = () => { hex.value = cp.value; data.color = cp.value; };
        hex.oninput = () => {
          const v = hex.value.trim();
          if (/^#[0-9a-f]{6}$/i.test(v)) { cp.value = v; data.color = v; }
        };
      } else if (isTrack) {
        // Live flag widget — emoji preview from country code, or custom uploaded image
        let currentFlag = data.flagImage || '';
        const renderFlag = () => {
          const code = ($('#pe-country', root)?.value || '').toUpperCase();
          const el = $('#pe-flag-mount', root);
          const previewBlock = currentFlag
            ? `<div class="track-flag-preview" style="background-image:url('${esc(currentFlag)}')"></div>`
            : `<div class="track-flag-preview emoji">${flag(code)}</div>`;
          el.innerHTML = `
            <div class="track-flag-row">
              ${previewBlock}
              <div style="display:flex;flex-direction:column;gap:6px;flex:1">
                <label class="btn btn-ghost" style="cursor:pointer;text-align:center">
                  <input type="file" accept="image/*" style="display:none">
                  ${currentFlag ? '↻ REPLACE FLAG IMAGE' : '↥ UPLOAD CUSTOM FLAG'}
                </label>
                ${currentFlag ? '<button class="btn btn-ghost" data-clear style="color:var(--red)">× USE EMOJI INSTEAD</button>' : ''}
              </div>
            </div>`;
          el.querySelector('input[type="file"]').onchange = async (e) => {
            const f = e.target.files[0]; if (!f) return;
            try {
              const url = await fileToDataURL(f, 200);
              currentFlag = url;
              data.flagImage = url;
              renderFlag();
            } catch (err) { toast(err.message || 'Could not load image', 'error'); }
          };
          if (el.querySelector('[data-clear]')) {
            el.querySelector('[data-clear]').onclick = () => { currentFlag = ''; data.flagImage = ''; renderFlag(); };
          }
        };
        renderFlag();
        $('#pe-country', root).oninput = () => renderFlag();
      }

      $$('.pe-era-cb', root).forEach(cb => cb.onchange = () =>
        cb.closest('.era-chip').classList.toggle('active', cb.checked));
      $('[data-act="cancel"]', root).onclick = close;
      $('[data-act="ok"]', root).onclick = () => {
        const name = $('#pe-name', root).value.trim();
        const country = $('#pe-country', root).value.trim().toUpperCase();
        // A preset can span multiple decades. Keep the original `era` as the stable
        // primary (for the preset key); `eras` carries the full set.
        const eras = $$('.pe-era-cb', root).filter(cb => cb.checked).map(cb => cb.value);
        if (!eras.length) eras.push(isEdit ? (data.era || 'Current') : 'Current');
        const era = isEdit ? (data.era || eras[0]) : eras[0];
        if (!name) return toast('Name required', 'error');
        if (isDriver) {
          const number = Math.max(1, Math.min(99, Number($('#pe-number', root).value) || 1));
          const abbr = $('#pe-abbr', root).value.trim().toUpperCase().slice(0, 3);
          const photos = data.photos || [];
          const defaultPhoto = (photos.find(p => p.isDefault) || photos[0])?.url || '';
          const updated = { name, country, era, eras, number, abbr, photos, photo: defaultPhoto };
          if (isEdit) savePresetEdit('driver', originalKey, updated);
          else addCustomPreset('driver', updated);
        } else if (isTeam) {
          const short = $('#pe-short', root).value.trim().toUpperCase() || name.slice(0, 3).toUpperCase();
          const color = $('#pe-color-hex', root).value.trim() || '#e10600';
          const updated = { name, short, color, country, era, eras, logo: data.logo || '' };
          if (isEdit) savePresetEdit('team', originalKey, updated);
          else addCustomPreset('team', updated);
        } else { // track
          const circuit = $('#pe-circuit', root).value.trim();
          const length = Number($('#pe-length', root).value) || 0;
          const sprint = $('#pe-sprint', root).checked;
          const updated = { name, circuit, country, era, eras, length, sprint, flagImage: data.flagImage || '' };
          if (isEdit) savePresetEdit('track', originalKey, updated);
          else addCustomPreset('track', updated);
        }
        toast(`Preset ${isEdit ? 'updated' : 'added'}`, 'success');
        close();
        onSaved && onSaved();
      };
      const delBtn = $('[data-act="delete"]', root);
      if (delBtn) delBtn.onclick = () => {
        const builtin = isEdit && existing.isBuiltin;
        const msg = builtin
          ? 'Remove this preset from the library? It will no longer appear in the list (you can recreate it later with + NEW PRESET).'
          : 'Delete this custom preset? This cannot be undone.';
        if (!confirm(msg)) return;
        if (builtin) hideBuiltinPreset(kind, originalKey);
        else deleteCustomPreset(kind, originalKey);
        toast('Preset deleted', 'success');
        close();
        onSaved && onSaved();
      };
      const resetBtn = $('[data-act="reset"]', root);
      if (resetBtn) resetBtn.onclick = () => {
        if (!confirm('Reset this preset to its default values? Your edits will be lost.')) return;
        resetPresetOverride(kind, originalKey);
        toast('Preset reset to default', 'success');
        close();
        onSaved && onSaved();
      };
      setTimeout(() => $('#pe-name', root)?.focus(), 60);
    }
  });
}

let _presetEraFilter = 'All';
function openDriverPresetSearch() {
  const season = activeSeason();
  if (!season) return;
  if (!season.teams.length) {
    return toast('Create a team first so drivers can be assigned', 'warn');
  }

  let query = '';

  modal({
    title: `<span class="accent">Driver</span> Presets`,
    size: 'wide',
    body: `
      <div class="preset-search-bar">
        <input type="text" id="ps-q" placeholder="Search by name or country (e.g. 'hamilton', 'GBR', 'verstappen')" autocomplete="off">
        <button class="btn btn-primary" id="ps-new">+ NEW PRESET</button>
      </div>
      <div class="preset-filters" id="ps-filters">
        ${ERA_FILTERS.map(e => `<button class="preset-filter ${e === _presetEraFilter ? 'active' : ''}" data-era="${e}">${e}</button>`).join('')}
      </div>
      <div class="preset-list" id="ps-list"></div>`,
    footer: `<span style="font-family:var(--f-mono);font-size:10px;color:var(--text-muted);letter-spacing:0.1em;margin-right:auto">CLICK ROW TO SIGN · CLICK ✎ TO EDIT</span><button class="btn btn-ghost" data-act="cancel">Done</button>`,
    onMount: (root, close) => {
      const list = $('#ps-list', root);
      const qInp = $('#ps-q', root);
      setTimeout(() => qInp.focus(), 60);

      const renderList = () => {
        const q = (query || '').toLowerCase();
        const present = new Set(season.drivers.map(d => d.name.toLowerCase().trim()));
        const allPresets = getEffectiveDriverPresets();
        const items = allPresets.filter(p => {
          if (_presetEraFilter !== 'All' && !presetEras(p).includes(_presetEraFilter)) return false;
          if (!q) return true;
          return p.name.toLowerCase().includes(q) || (p.country || '').toLowerCase().includes(q) || presetEras(p).some(e => e.toLowerCase().includes(q));
        });
        if (!items.length) {
          list.innerHTML = `<div class="preset-empty">No presets match "${esc(q)}"</div>`;
          return;
        }
        list.innerHTML = items.map((p, i) => {
          const already = present.has(p.name.toLowerCase().trim());
          const portrait = p.photo
            ? `<div class="preset-portrait" style="background-image:url('${esc(p.photo)}')"></div>`
            : `<div class="preset-portrait preset-portrait-fallback preset-portrait-driver"></div>`;
          const badges = [];
          if (p.isCustom) badges.push('<span class="preset-badge custom">MINE</span>');
          else if (state.presetOverrides?.drivers?.[p.presetKey]) badges.push('<span class="preset-badge edited">EDITED</span>');
          return `<div class="preset-row ${already ? 'added' : ''}" data-idx="${i}">
            ${portrait}
            <div class="preset-num">${p.number}</div>
            <div class="preset-info">
              <div class="preset-name">${esc(p.name)} ${p.abbr ? `<span class="preset-abbr">${esc(p.abbr)}</span>` : ''} ${badges.join(' ')}</div>
              <div class="preset-meta">${esc(presetEraLabel(p))}${p.team ? ` · ${esc(p.team)}` : ''}</div>
            </div>
            <div class="preset-flag">${flagImg(p.country, 18)} <span>${esc(p.country || '')}</span></div>
            <button class="preset-edit-btn" data-edit="${i}" title="Edit preset" aria-label="Edit">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            </button>
            <button class="preset-add-btn ${already ? 'is-added' : ''}">
              <span class="preset-add-btn-label">${already ? '✓ ADDED' : '+ SIGN'}</span>
            </button>
          </div>`;
        }).join('');
        $$('.preset-row', list).forEach(row => {
          row.onclick = (ev) => {
            if (ev.target.closest('[data-edit]')) return;
            if (row.classList.contains('added')) return;
            const p = items[Number(row.dataset.idx)];
            const usedNums = new Set(season.drivers.map(d => d.number));
            let num = p.number || 2;
            while (usedNums.has(num)) num = num + 1 > 99 ? 2 : num + 1;
            // Prefer the driver's preset team (e.g. their 2026 constructor) when it
            // exists in this season; otherwise drop them in the first open seat.
            let targetTeam = null;
            if (p.team) {
              const want = p.team.toLowerCase().trim();
              targetTeam = season.teams.find(t => (t.name || '').toLowerCase().trim() === want)
                        || season.teams.find(t => (t.short || '').toLowerCase().trim() === want);
            }
            if (!targetTeam) {
              const teamCounts = {};
              season.teams.forEach(t => teamCounts[t.id] = 0);
              season.drivers.forEach(d => { if (d.teamId) teamCounts[d.teamId] = (teamCounts[d.teamId] || 0) + 1; });
              targetTeam = season.teams.find(t => teamCounts[t.id] < 2) || season.teams[0];
            }
            const sign = (photoUrl) => {
              addDriver({ name: p.name, number: num, country: p.country, teamId: targetTeam.id, photo: photoUrl || '', abbr: p.abbr || '' });
              toast(`${p.name} signed`, 'success');
              renderList();
              renderMain();
            };
            const photos = presetPhotosList(p);
            if (photos.length > 1) pickPresetPhoto(p, sign);
            else sign(photos[0]?.url || '');
          };
        });
        $$('[data-edit]', list).forEach(b => b.onclick = (ev) => {
          ev.stopPropagation();
          const p = items[Number(b.dataset.edit)];
          openPresetEditor('driver', p, () => renderList());
        });
      };

      qInp.oninput = (e) => { query = e.target.value; renderList(); };
      $$('[data-era]', root).forEach(b => b.onclick = () => {
        _presetEraFilter = b.dataset.era;
        $$('[data-era]', root).forEach(x => x.classList.toggle('active', x.dataset.era === _presetEraFilter));
        renderList();
      });
      $('#ps-new', root).onclick = () => openPresetEditor('driver', null, () => renderList());
      $('[data-act="cancel"]', root).onclick = close;
      renderList();
    }
  });
}

/* Team preset search — same UX as drivers but for constructors */
let _teamPresetEraFilter = 'All';
function openTeamPresetSearch() {
  const season = activeSeason();
  if (!season) return;
  let query = '';

  modal({
    title: `<span class="accent">Team</span> Presets`,
    size: 'wide',
    body: `
      <div class="preset-search-bar">
        <input type="text" id="tps-q" placeholder="Search by name or country (e.g. 'ferrari', 'GBR', 'lotus')" autocomplete="off">
        <button class="btn btn-primary" id="tps-new">+ NEW PRESET</button>
      </div>
      <div class="preset-filters" id="tps-filters">
        ${ERA_FILTERS.map(e => `<button class="preset-filter ${e === _teamPresetEraFilter ? 'active' : ''}" data-era="${e}">${e}</button>`).join('')}
      </div>
      <div class="preset-list" id="tps-list"></div>`,
    footer: `<span style="font-family:var(--f-mono);font-size:10px;color:var(--text-muted);letter-spacing:0.1em;margin-right:auto">CLICK ROW TO ADD · CLICK ✎ TO EDIT</span><button class="btn btn-ghost" data-act="cancel">Done</button>`,
    onMount: (root, close) => {
      const list = $('#tps-list', root);
      const qInp = $('#tps-q', root);
      setTimeout(() => qInp.focus(), 60);

      const renderList = () => {
        const q = (query || '').toLowerCase();
        const present = new Set(season.teams.map(t => t.name.toLowerCase().trim()));
        const allPresets = getEffectiveTeamPresets();
        const items = allPresets.filter(p => {
          if (_teamPresetEraFilter !== 'All' && !presetEras(p).includes(_teamPresetEraFilter)) return false;
          if (!q) return true;
          return p.name.toLowerCase().includes(q) || (p.country || '').toLowerCase().includes(q) || presetEras(p).some(e => e.toLowerCase().includes(q)) || (p.short || '').toLowerCase().includes(q);
        });
        if (!items.length) {
          list.innerHTML = `<div class="preset-empty">No presets match "${esc(q)}"</div>`;
          return;
        }
        list.innerHTML = items.map((p, i) => {
          const already = present.has(p.name.toLowerCase().trim());
          const swatch = p.logo
            ? `<div class="preset-portrait" style="background-image:url('${esc(p.logo)}');border-color:${p.color}"></div>`
            : `<div class="preset-portrait preset-portrait-fallback" style="border-color:${p.color};color:${p.color}">${esc((p.short || p.name).slice(0,3).toUpperCase())}</div>`;
          const badges = [];
          if (p.isCustom) badges.push('<span class="preset-badge custom">MINE</span>');
          else if (state.presetOverrides?.teams?.[p.presetKey]) badges.push('<span class="preset-badge edited">EDITED</span>');
          return `<div class="preset-row ${already ? 'added' : ''}" data-idx="${i}" style="--row-accent:${p.color}">
            ${swatch}
            <div class="preset-num" style="color:${p.color}">${esc(p.short)}</div>
            <div class="preset-info">
              <div class="preset-name">${esc(p.name)} ${badges.join(' ')}</div>
              <div class="preset-meta">${esc(presetEraLabel(p))}</div>
            </div>
            <div class="preset-flag">${flagImg(p.country, 18)} <span>${esc(p.country || '')}</span></div>
            <button class="preset-edit-btn" data-edit="${i}" title="Edit preset" aria-label="Edit">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            </button>
            <button class="preset-add-btn ${already ? 'is-added' : ''}">
              <span class="preset-add-btn-label">${already ? '✓ ADDED' : '+ ADD'}</span>
            </button>
          </div>`;
        }).join('');
        $$('.preset-row', list).forEach(row => {
          row.onclick = (ev) => {
            if (ev.target.closest('[data-edit]')) return;
            if (row.classList.contains('added')) return;
            const p = items[Number(row.dataset.idx)];
            // Logo and color copied onto the new team; presetKey links it back to
            // the preset so later image edits flow through automatically.
            addTeam({ name: p.name, short: p.short, color: p.color, country: p.country, logo: p.logo || '', presetKey: p.presetKey });
            toast(`${p.name} added`, 'success');
            renderList();
            renderMain();
          };
        });
        $$('[data-edit]', list).forEach(b => b.onclick = (ev) => {
          ev.stopPropagation();
          const p = items[Number(b.dataset.edit)];
          openPresetEditor('team', p, () => renderList());
        });
      };

      qInp.oninput = (e) => { query = e.target.value; renderList(); };
      $$('[data-era]', root).forEach(b => b.onclick = () => {
        _teamPresetEraFilter = b.dataset.era;
        $$('[data-era]', root).forEach(x => x.classList.toggle('active', x.dataset.era === _teamPresetEraFilter));
        renderList();
      });
      $('#tps-new', root).onclick = () => openPresetEditor('team', null, () => renderList());
      $('[data-act="cancel"]', root).onclick = close;
      renderList();
    }
  });
}

/* Track preset search — searchable circuit library, same pattern as drivers/teams */
let _trackPresetEraFilter = 'All';
function openTrackPresetSearch() {
  const season = activeSeason();
  if (!season) return;
  let query = '';

  modal({
    title: `<span class="accent">Track</span> Presets`,
    size: 'wide',
    body: `
      <div class="preset-search-bar">
        <input type="text" id="trps-q" placeholder="Search by name, circuit, or country (e.g. 'silverstone', 'GBR', 'monaco')" autocomplete="off">
        <button class="btn btn-primary" id="trps-new">+ NEW PRESET</button>
      </div>
      <div class="preset-filters" id="trps-filters">
        ${ERA_FILTERS.map(e => `<button class="preset-filter ${e === _trackPresetEraFilter ? 'active' : ''}" data-era="${e}">${e}</button>`).join('')}
      </div>
      <div class="preset-list" id="trps-list"></div>`,
    footer: `<span style="font-family:var(--f-mono);font-size:10px;color:var(--text-muted);letter-spacing:0.1em;margin-right:auto">CLICK ROW TO ADD TO CALENDAR · CLICK ✎ TO EDIT</span><button class="btn btn-ghost" data-act="cancel">Done</button>`,
    onMount: (root, close) => {
      const list = $('#trps-list', root);
      const qInp = $('#trps-q', root);
      setTimeout(() => qInp.focus(), 60);

      const renderList = () => {
        const q = (query || '').toLowerCase();
        // Mark a track as "added" if its name + country combo is already on the calendar
        const present = new Set(season.races.map(r => (r.name || '').toLowerCase().trim() + '|' + (r.country || '').toUpperCase()));
        const allPresets = getEffectiveTrackPresets();
        const items = allPresets.filter(p => {
          if (_trackPresetEraFilter !== 'All' && !presetEras(p).includes(_trackPresetEraFilter)) return false;
          if (!q) return true;
          return p.name.toLowerCase().includes(q)
            || (p.circuit || '').toLowerCase().includes(q)
            || (p.country || '').toLowerCase().includes(q)
            || presetEras(p).some(e => e.toLowerCase().includes(q));
        });
        if (!items.length) {
          list.innerHTML = `<div class="preset-empty">No presets match "${esc(q)}"</div>`;
          return;
        }
        list.innerHTML = items.map((p, i) => {
          const already = present.has(p.name.toLowerCase().trim() + '|' + (p.country || '').toUpperCase());
          const flagUrl = p.flagImage || flagSvgUrl(p.country);
          const flagBlock = flagUrl
            ? `<div class="preset-portrait preset-portrait-flag" style="background-image:url('${esc(flagUrl)}')"></div>`
            : `<div class="preset-portrait preset-portrait-flag preset-portrait-fallback">${esc((p.country || '?').slice(0,3))}</div>`;
          const badges = [];
          if (p.isCustom) badges.push('<span class="preset-badge custom">MINE</span>');
          else if (state.presetOverrides?.tracks?.[p.presetKey]) badges.push('<span class="preset-badge edited">EDITED</span>');
          if (p.sprint) badges.push('<span class="preset-badge sprint">SPR</span>');
          const lengthStr = p.length ? `${Number(p.length).toFixed(3)} km` : '';
          return `<div class="preset-row preset-row-track ${already ? 'added' : ''}" data-idx="${i}">
            ${flagBlock}
            <div class="preset-num preset-num-country">${esc(p.country || '')}</div>
            <div class="preset-info">
              <div class="preset-name">${esc(p.name)} ${badges.join(' ')}</div>
              <div class="preset-meta">${esc(p.circuit || '')}${lengthStr ? ' · ' + lengthStr : ''} · ${esc(presetEraLabel(p))}</div>
            </div>
            <button class="preset-edit-btn" data-edit="${i}" title="Edit preset" aria-label="Edit">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            </button>
            <button class="preset-add-btn ${already ? 'is-added' : ''}">
              <span class="preset-add-btn-label">${already ? '✓ ADDED' : '+ ADD'}</span>
            </button>
          </div>`;
        }).join('');
        $$('.preset-row', list).forEach(row => {
          row.onclick = (ev) => {
            if (ev.target.closest('[data-edit]')) return;
            if (row.classList.contains('added')) return;
            const p = items[Number(row.dataset.idx)];
            addRace({
              name: p.name,
              circuit: p.circuit || '',
              country: p.country || '',
              sprint: !!p.sprint,
              date: '',
              flagImage: p.flagImage || '',
            });
            toast(`${p.name} added to calendar`, 'success');
            renderList();
            renderMain();
          };
        });
        $$('[data-edit]', list).forEach(b => b.onclick = (ev) => {
          ev.stopPropagation();
          const p = items[Number(b.dataset.edit)];
          openPresetEditor('track', p, () => renderList());
        });
      };

      qInp.oninput = (e) => { query = e.target.value; renderList(); };
      $$('[data-era]', root).forEach(b => b.onclick = () => {
        _trackPresetEraFilter = b.dataset.era;
        $$('[data-era]', root).forEach(x => x.classList.toggle('active', x.dataset.era === _trackPresetEraFilter));
        renderList();
      });
      $('#trps-new', root).onclick = () => openPresetEditor('track', null, () => renderList());
      $('[data-act="cancel"]', root).onclick = close;
      renderList();
    }
  });
}

/* =====================================================
   ROSTER BUNDLES — "Class of 2025" style saves
   Each bundle stores a snapshot of drivers OR teams. Load
   it back into any season to recreate the roster.
   ===================================================== */
function saveDriverClass(name, note = '') {
  const s = activeSeason();
  if (!s) return null;
  const snapshot = (s.drivers || []).map(d => ({
    name: d.name,
    number: d.number,
    country: d.country,
    photo: d.photo || '',
    era: d.era || 'Current',
    // We can't preserve teamId — teams aren't part of this bundle — so we drop it
  }));
  const cls = {
    id: uid(),
    name: (name || '').trim() || `Class · ${new Date().toLocaleDateString()}`,
    savedAt: Date.now(),
    drivers: snapshot,
    note: (note || '').trim(),
  };
  state.driverClasses = state.driverClasses || [];
  state.driverClasses.unshift(cls);
  saveState();
  return cls;
}

function saveTeamClass(name, note = '') {
  const s = activeSeason();
  if (!s) return null;
  const snapshot = (s.teams || []).map(t => ({
    name: t.name,
    short: t.short,
    country: t.country,
    color: t.color,
    logo: t.logo || '',
    era: t.era || 'Current',
  }));
  const cls = {
    id: uid(),
    name: (name || '').trim() || `Class · ${new Date().toLocaleDateString()}`,
    savedAt: Date.now(),
    teams: snapshot,
    note: (note || '').trim(),
  };
  state.teamClasses = state.teamClasses || [];
  state.teamClasses.unshift(cls);
  saveState();
  return cls;
}

function deleteRosterClass(kind, id) {
  const field = kind === 'driver' ? 'driverClasses' : 'teamClasses';
  state[field] = (state[field] || []).filter(c => c.id !== id);
  saveState();
}

function loadDriverClass(cls, mode = 'add') {
  const s = activeSeason(); if (!s) return 0;
  if (mode === 'replace') {
    // Remove all existing drivers but keep team rooster intact
    s.drivers = [];
    // Also strip the drivers from any race results
    (s.races || []).forEach(r => {
      r.results = (r.results || []).filter(() => false); // wipe — they all referenced old IDs
      r.sprintResults = (r.sprintResults || []).filter(() => false);
      r.fastestLapDriverId = null;
      r.poleDriverId = null;
    });
  }
  let added = 0;
  cls.drivers.forEach(d => {
    s.drivers.push({
      id: uid(),
      name: d.name,
      number: d.number,
      country: d.country || '',
      photo: d.photo || '',
      teamId: null,
      dsq: false,
    });
    added++;
  });
  saveState();
  return added;
}

function loadTeamClass(cls, mode = 'add') {
  const s = activeSeason(); if (!s) return 0;
  if (mode === 'replace') {
    s.teams = [];
    // Drivers signed to old teams lose their teamId
    (s.drivers || []).forEach(d => { d.teamId = null; });
  }
  let added = 0;
  cls.teams.forEach(t => {
    s.teams.push({
      id: uid(),
      name: t.name,
      short: t.short || (t.name || '').slice(0, 3).toUpperCase(),
      country: t.country || '',
      color: t.color || '#666',
      logo: t.logo || '',
      dsq: false,
    });
    added++;
  });
  saveState();
  return added;
}

/* =====================================================
   CALENDAR PRESETS — snapshot a full season's race calendar, reload anywhere.
   Saves circuit info, country, sprint-weekend flag, custom flag image, and
   the round order. Drops dates + completion state — these are season-specific.
   ===================================================== */
function saveCalendarPreset(name, note = '') {
  const s = activeSeason(); if (!s) return null;
  const snapshot = (s.races || [])
    .slice()
    .sort((a, b) => (a.round || 0) - (b.round || 0))
    .map(r => ({
      name: r.name,
      circuit: r.circuit || '',
      country: r.country || '',
      flagImage: r.flagImage || '',
      sprint: !!r.sprint,
    }));
  const preset = {
    id: uid(),
    name: (name || '').trim() || `Calendar · ${new Date().toLocaleDateString()}`,
    savedAt: Date.now(),
    races: snapshot,
    note: (note || '').trim(),
  };
  state.calendarPresets = state.calendarPresets || [];
  state.calendarPresets.unshift(preset);
  saveState();
  return preset;
}

function deleteCalendarPreset(id) {
  state.calendarPresets = (state.calendarPresets || []).filter(c => c.id !== id);
  saveState();
}

function loadCalendarPreset(preset, mode = 'replace') {
  // `mode = 'replace'` wipes existing races (preserving results would be unsafe
  // since round numbers and driver IDs may not line up). `mode = 'append'` adds
  // at the end with continued round numbers.
  const s = activeSeason(); if (!s) return 0;
  if (mode === 'replace') {
    s.races = [];
  }
  const startRound = (s.races.length ? Math.max(...s.races.map(r => r.round || 0)) : 0) + 1;
  let added = 0;
  preset.races.forEach((r, i) => {
    s.races.push({
      id: uid(),
      round: startRound + i,
      name: r.name,
      circuit: r.circuit,
      country: r.country,
      flagImage: r.flagImage || '',
      sprint: !!r.sprint,
      date: '',
      completed: false,
      results: [],
      sprintResults: [],
      fastestLapDriverId: null,
      poleDriverId: null,
    });
    added++;
  });
  saveState();
  return added;
}

/* =====================================================
   FEATURE #5: BULK ROSTER IMPORT
   Parses pasted text into drivers in one go. Supports several common formats:
     - "Lewis Hamilton GBR"
     - "44 Lewis Hamilton GBR"
     - "Lewis Hamilton, GBR, 44"
     - "44 | Lewis Hamilton | GBR"
     - Just names (numbers auto-assigned)
   Each line becomes one driver.
   ===================================================== */
function parseBulkRosterText(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const drivers = [];
  for (const line of lines) {
    if (line.startsWith('#') || line.startsWith('//')) continue;  // skip comments
    // Try splitting on common delimiters
    const parts = line.split(/[,\t|]+|\s{2,}/).map(p => p.trim()).filter(Boolean);
    let name = null, number = null, country = null;
    // Pattern A: single space-separated (e.g. "44 Hamilton GBR" or "Hamilton GBR")
    if (parts.length === 1) {
      const tokens = line.trim().split(/\s+/);
      // If first token is a number, it's the racing number
      const numIdx = tokens.findIndex(t => /^\d+$/.test(t));
      if (numIdx === 0) {
        number = parseInt(tokens[0], 10);
        // Last 3-letter UPPERCASE token could be country
        const last = tokens[tokens.length - 1];
        if (/^[A-Z]{3}$/.test(last)) {
          country = last;
          name = tokens.slice(1, -1).join(' ');
        } else {
          name = tokens.slice(1).join(' ');
        }
      } else {
        const last = tokens[tokens.length - 1];
        if (/^[A-Z]{3}$/.test(last)) {
          country = last;
          name = tokens.slice(0, -1).join(' ');
        } else {
          name = tokens.join(' ');
        }
      }
    } else {
      // Pattern B: multi-part delimited
      for (const p of parts) {
        if (/^\d+$/.test(p) && number === null) number = parseInt(p, 10);
        else if (/^[A-Z]{3}$/.test(p.toUpperCase()) && country === null && p.length === 3) country = p.toUpperCase();
        else if (!name) name = p;
      }
    }
    if (!name) continue;
    drivers.push({ name, number, country });
  }
  return drivers;
}

/* =====================================================
   FEATURE #6: DRIVER & TEAM TRANSFERS ACROSS SEASONS
   "Copy" a driver/team into another season, optionally to a specific team there.
   ===================================================== */
function transferDriverToSeason(driverId, fromSeasonId, toSeasonId, toTeamId = null) {
  const save = activeSave(); if (!save) return null;
  const fromSeason = save.seasons[fromSeasonId];
  const toSeason   = save.seasons[toSeasonId];
  if (!fromSeason || !toSeason) return null;
  const src = fromSeason.drivers.find(d => d.id === driverId);
  if (!src) return null;
  const copy = {
    id: uid(),
    name: src.name,
    number: src.number,
    country: src.country,
    photo: src.photo || '',
    teamId: toTeamId,
    dsq: false,
  };
  toSeason.drivers.push(copy);
  saveState();
  return copy;
}

function openTransferDriverModal(driverId) {
  const save = activeSave(); if (!save) return;
  const driver = activeSeason()?.drivers.find(d => d.id === driverId);
  if (!driver) return;
  const otherSeasons = Object.values(save.seasons).filter(s => s.id !== state.activeSeasonId);
  if (!otherSeasons.length) {
    toast('Need at least one other season to transfer to', 'info');
    return;
  }
  modal({
    title: `<span class="accent">Transfer</span> ${esc(driver.name)}`,
    body: `
      <div class="field-help" style="margin-bottom:14px">
        Copy this driver into another season. They'll keep their name, number, country, and photo. You can choose which team they join in the target season.
      </div>
      <div class="field">
        <label>Target season</label>
        <select id="xfer-season">
          ${otherSeasons.sort((a,b)=>b.year-a.year).map(s => `<option value="${s.id}">${esc(s.year)} · ${esc(s.name)}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label>Target team</label>
        <select id="xfer-team"><option value="">— None / Free Agent —</option></select>
      </div>`,
    footer: `<button class="btn btn-ghost" data-act="cancel">Cancel</button><button class="btn btn-primary" data-act="ok">Transfer</button>`,
    onMount: (root, close) => {
      const seasonSel = $('#xfer-season', root);
      const teamSel = $('#xfer-team', root);
      const refreshTeams = () => {
        const sn = save.seasons[seasonSel.value];
        teamSel.innerHTML = `<option value="">— None / Free Agent —</option>` +
          (sn?.teams || []).map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('');
      };
      seasonSel.onchange = refreshTeams;
      refreshTeams();
      $('[data-act="cancel"]', root).onclick = close;
      $('[data-act="ok"]', root).onclick = () => {
        const r = transferDriverToSeason(driverId, state.activeSeasonId, seasonSel.value, teamSel.value || null);
        if (r) {
          toast(`${driver.name} transferred to ${save.seasons[seasonSel.value].year}`, 'success');
          close();
          renderMain();
        } else { toast('Transfer failed', 'error'); }
      };
    },
  });
}

/* =====================================================
   FEATURE #7: STANDINGS PREDICTIONS
   "If X happens in remaining races, who wins the championship?"
   ===================================================== */
function openPredictionsModal() {
  const season = activeSeason(); if (!season) return;
  const remaining = season.races.filter(r => !r.completed);
  if (!remaining.length) { toast('All races complete — no predictions to make', 'info'); return; }

  // For each remaining race, the user can pick a winner; we then auto-fill the rest
  // by current standings order and compute projected final standings.
  let picks = {}; // raceId -> driverId (the predicted winner)

  modal({
    title: `<span class="accent">Predict</span> Championship`,
    size: 'wide',
    body: `
      <div class="field-help" style="margin-bottom:14px">
        Pick a winner for each remaining race. The other positions are filled by current standings order. See who'd be champion at season's end.
      </div>
      <div id="pred-races"></div>
      <div id="pred-standings" style="margin-top:24px"></div>`,
    footer: `<button class="btn btn-ghost" data-act="cancel">Close</button>`,
    onMount: (root, close) => {
      $('[data-act="cancel"]', root).onclick = close;
      const racesEl = $('#pred-races', root);
      const stEl = $('#pred-standings', root);
      const driverById = Object.fromEntries(season.drivers.map(d => [d.id, d]));
      const recompute = () => {
        // Compute current standings to get an order for tiebreaks
        const current = calcDriverStandings(season);
        const orderedIds = current.map(s => s.driverId);
        // Clone the season — apply the predicted winners + auto-fill
        const cloned = JSON.parse(JSON.stringify(season));
        for (const race of cloned.races) {
          if (race.completed) continue;
          // Build a predicted result list
          const winnerId = picks[race.id];
          const ids = winnerId ? [winnerId, ...orderedIds.filter(id => id !== winnerId)] : orderedIds;
          race.results = ids.slice(0, 20).map((id, i) => ({ driverId: id, position: i + 1, dnf: false, dsq: false, dns: false }));
          race.completed = true;
        }
        const projected = calcDriverStandings(cloned);
        stEl.innerHTML = `
          <div class="members-head" style="margin-bottom:10px">PROJECTED FINAL STANDINGS</div>
          <table class="pred-table">
            <thead><tr><th>#</th><th>Driver</th><th>Now</th><th>Final</th><th>Δ</th></tr></thead>
            <tbody>
              ${projected.slice(0, 10).map((s, i) => {
                const nowIdx = current.findIndex(c => c.driverId === s.driverId);
                const delta = nowIdx === -1 ? 0 : (nowIdx - i);
                const arrow = delta > 0 ? `<span style="color:var(--green)">▲${delta}</span>`
                              : delta < 0 ? `<span style="color:var(--red)">▼${-delta}</span>`
                              : `<span style="color:var(--text-muted)">–</span>`;
                const drv = driverById[s.driverId];
                return `<tr ${i===0?'class="pred-champ"':''}><td>${i+1}</td><td>${esc(drv?.name || '—')}</td><td>${current[nowIdx]?.points || 0}</td><td><b>${s.points}</b></td><td>${arrow}</td></tr>`;
              }).join('')}
            </tbody>
          </table>`;
      };
      racesEl.innerHTML = remaining.map(r => `
        <div class="pred-race-row">
          <div class="pred-race-num">R${r.round}</div>
          <div class="pred-race-name">${esc(r.name)}</div>
          <select class="pred-winner" data-race="${r.id}">
            <option value="">— pick winner —</option>
            ${season.drivers.map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join('')}
          </select>
        </div>`).join('');
      $$('.pred-winner', racesEl).forEach(s => {
        s.onchange = () => { picks[s.dataset.race] = s.value; recompute(); };
      });
      recompute();
    },
  });
}

/* =====================================================
   FEATURE #8: SEASON TEMPLATES — save a season's setup as a reusable shell
   ===================================================== */
function saveSeasonTemplate(name, note = '') {
  const season = activeSeason(); if (!season) return null;
  const tpl = {
    id: uid(),
    name: (name || '').trim() || `${season.year} template`,
    savedAt: Date.now(),
    note: note.trim(),
    data: {
      pointsSystemId: season.pointsSystemId,
      polePointEnabled: season.polePointEnabled || false,
      polePointValue: season.polePointValue || 1,
      flEnabled: season.flEnabled !== false,
      teams: (season.teams || []).map(t => ({ ...t, id: uid() })),
      drivers: (season.drivers || []).map(d => ({ ...d, id: uid() })),
      races: (season.races || []).map(r => ({
        round: r.round, name: r.name, circuit: r.circuit, country: r.country,
        flagImage: r.flagImage || null, sprint: r.sprint || false,
      })),
    },
  };
  state.seasonTemplates = state.seasonTemplates || [];
  state.seasonTemplates.unshift(tpl);
  saveState();
  return tpl;
}
function deleteSeasonTemplate(id) {
  state.seasonTemplates = (state.seasonTemplates || []).filter(t => t.id !== id);
  saveState();
}
function instantiateSeasonTemplate(tplId, newYear, newName) {
  const tpl = (state.seasonTemplates || []).find(t => t.id === tplId);
  const save = activeSave(); if (!tpl || !save) return null;
  // Build a fresh season from the template, regenerating all IDs
  const teamMap = {};
  const newTeams = tpl.data.teams.map(t => {
    const id = uid(); teamMap[t.id] = id;
    return { ...t, id, dsq: false };
  });
  const newDrivers = tpl.data.drivers.map(d => ({
    ...d, id: uid(),
    teamId: d.teamId ? teamMap[d.teamId] : null,
    dsq: false,
  }));
  const newRaces = tpl.data.races.map(r => ({
    ...r, id: uid(),
    completed: false,
    results: [], sprintResults: [],
    poleDriverId: null, fastestLapDriverId: null,
    date: null,
  }));
  const newSeason = {
    id: uid(),
    name: (newName || '').trim() || tpl.name,
    year: newYear,
    pointsSystemId: tpl.data.pointsSystemId,
    polePointEnabled: tpl.data.polePointEnabled,
    polePointValue: tpl.data.polePointValue,
    flEnabled: tpl.data.flEnabled,
    teams: newTeams,
    drivers: newDrivers,
    races: newRaces,
  };
  save.seasons[newSeason.id] = newSeason;
  state.activeSeasonId = newSeason.id;
  state.view = 'dashboard';
  saveState();
  return newSeason;
}

function openSeasonTemplatesModal() {
  const save = activeSave(); if (!save) return;
  const season = activeSeason();
  const templates = state.seasonTemplates || [];

  modal({
    title: `<span class="accent">Season</span> Templates`,
    size: 'wide',
    body: `
      <div class="field-help" style="margin-bottom:18px">
        Save the current season's setup (calendar, teams, drivers, points system — no results) as a reusable template. Spin up a new season modeled on it in seconds.
      </div>
      ${season ? `
      <div class="share-section">
        <div class="share-section-head">SAVE CURRENT SEASON AS A TEMPLATE</div>
        <div class="roster-save-row" style="display:flex;gap:10px;align-items:flex-end">
          <div class="field" style="flex:1;margin:0"><label>Template name</label><input type="text" id="tpl-name" placeholder="e.g. ${esc(String(season.year))} season skeleton" maxlength="60"></div>
          <button class="btn btn-primary" id="tpl-save">★ SAVE TEMPLATE</button>
        </div>
      </div>` : ''}
      <div class="share-section">
        <div class="share-section-head">SAVED TEMPLATES · <span id="tpl-count">${templates.length}</span></div>
        <div id="tpl-list"></div>
      </div>`,
    footer: `<button class="btn btn-ghost" data-act="cancel">Done</button>`,
    onMount: (root, close) => {
      $('[data-act="cancel"]', root).onclick = close;
      const listEl = $('#tpl-list', root);
      const renderList = () => {
        const tpls = state.seasonTemplates || [];
        const countSpan = $('#tpl-count', root);
        if (countSpan) countSpan.textContent = tpls.length;
        if (!tpls.length) {
          listEl.innerHTML = `<div class="empty-row">No templates yet.</div>`;
          return;
        }
        listEl.innerHTML = tpls.map(t => `
          <div class="rc-row" data-id="${t.id}">
            <div class="rc-head">
              <div class="rc-name">${esc(t.name)}</div>
              <div class="rc-meta">${t.data.teams.length} teams · ${t.data.drivers.length} drivers · ${t.data.races.length} races</div>
            </div>
            <div class="rc-actions">
              <button class="btn btn-ghost" data-act="use">+ NEW SEASON FROM THIS</button>
              <button class="btn btn-ghost" data-act="del" style="color:var(--red)">× DELETE</button>
            </div>
          </div>`).join('');
        $$('[data-act="use"]', listEl).forEach(b => {
          b.onclick = () => {
            const row = b.closest('.rc-row'); const id = row.dataset.id;
            const yr = parseInt(prompt('New season year:', String(new Date().getFullYear() + 1)) || '0', 10);
            if (!yr) return;
            const nm = prompt('New season name (optional):', '') || '';
            const r = instantiateSeasonTemplate(id, yr, nm);
            if (r) { toast(`Created ${yr} season from template`, 'success'); close(); renderAll(); }
          };
        });
        $$('[data-act="del"]', listEl).forEach(b => {
          b.onclick = () => {
            const row = b.closest('.rc-row'); const id = row.dataset.id;
            if (!confirm('Delete this template?')) return;
            deleteSeasonTemplate(id);
            renderList();
            toast('Template deleted', 'success');
          };
        });
      };
      renderList();
      $('#tpl-save', root)?.addEventListener('click', () => {
        const name = $('#tpl-name', root).value;
        const tpl = saveSeasonTemplate(name);
        if (tpl) {
          toast(`Template "${tpl.name}" saved`, 'success');
          $('#tpl-name', root).value = '';
          renderList();
        }
      });
    },
  });
}

/* =====================================================
   FEATURE #10: RACE WEEKEND TIMELINE VIEW
   Shows a single race as a chronological flow: Qualifying → Sprint → Race
   ===================================================== */
function buildRaceTimelineHTML(race, season) {
  const driverById = Object.fromEntries(season.drivers.map(d => [d.id, d]));
  const sessions = [];
  // Qualifying — pole driver
  if (race.poleDriverId) {
    const drv = driverById[race.poleDriverId];
    sessions.push({
      title: 'QUALIFYING',
      icon: '⏱',
      highlight: drv ? `<b>${esc(drv.name)}</b> took pole position` : 'Pole position set',
      color: 'var(--sec-blue)',
    });
  } else if (race.completed) {
    sessions.push({ title: 'QUALIFYING', icon: '⏱', highlight: 'No pole recorded', color: 'var(--text-muted)' });
  }
  // Sprint
  if (race.sprint && race.sprintResults?.length) {
    const winner = race.sprintResults.find(r => r.position === 1);
    const drv = winner ? driverById[winner.driverId] : null;
    sessions.push({
      title: 'SPRINT',
      icon: '🏁',
      highlight: drv ? `<b>${esc(drv.name)}</b> won the sprint` : 'Sprint completed',
      color: '#f59e0b',
    });
  }
  // Race
  if (race.completed && race.results?.length) {
    const winner = race.results.find(r => r.position === 1);
    const flDrv = race.fastestLapDriverId ? driverById[race.fastestLapDriverId] : null;
    const drv = winner ? driverById[winner.driverId] : null;
    sessions.push({
      title: 'RACE',
      icon: '🏆',
      highlight: drv ? `<b>${esc(drv.name)}</b> took the win` : 'Race completed',
      sub: flDrv ? `Fastest lap: ${esc(flDrv.name)}` : '',
      color: 'var(--gold)',
    });
  } else if (!race.completed) {
    sessions.push({ title: 'RACE', icon: '🏆', highlight: '— upcoming —', color: 'var(--text-muted)' });
  }

  return `
    <div class="race-timeline">
      ${sessions.map((s, i) => `
        <div class="race-timeline-step" style="--ts-color:${s.color}">
          ${i > 0 ? '<div class="race-timeline-connector"></div>' : ''}
          <div class="race-timeline-icon">${s.icon}</div>
          <div class="race-timeline-body">
            <div class="race-timeline-title">${s.title}</div>
            <div class="race-timeline-highlight">${s.highlight}</div>
            ${s.sub ? `<div class="race-timeline-sub">${s.sub}</div>` : ''}
          </div>
        </div>
      `).join('')}
    </div>`;
}

/* =====================================================
   FEATURE #12: DRIVER STATS COMPARISON
   ===================================================== */
function openDriverComparison() {
  const save = activeSave(); if (!save) return;
  // Collect every (driver, season) combination across all seasons in this save.
  // calcDriverStandings returns an array of stat rows indexed by driverId.
  const allDrivers = [];
  for (const season of Object.values(save.seasons || {})) {
    const standings = calcDriverStandings(season);
    const statsByDriverId = Object.fromEntries(standings.map(s => [s.driverId, s]));
    for (const d of season.drivers || []) {
      const stats = statsByDriverId[d.id] || { points: 0, wins: 0, podiums: 0, polePositions: 0, fastestLaps: 0, races: 0, dnfs: 0 };
      allDrivers.push({
        key: `${d.id}::${season.id}`,
        label: `${d.name} (${season.year})`,
        driver: d, season, stats,
      });
    }
  }
  if (allDrivers.length < 2) { toast('Need at least 2 driver-seasons to compare', 'info'); return; }

  let pickA = null, pickB = null;

  const render = (root) => {
    const compare = $('#cmp-content', root);
    if (!pickA || !pickB) {
      compare.innerHTML = `<div class="empty-row" style="padding:40px 20px;text-align:center;color:var(--text-muted)">Pick two drivers above to compare them.</div>`;
      return;
    }
    const A = allDrivers.find(d => d.key === pickA);
    const B = allDrivers.find(d => d.key === pickB);
    if (!A || !B) return;
    const rows = [
      ['Points',      A.stats.points,         B.stats.points],
      ['Wins',        A.stats.wins,           B.stats.wins],
      ['Podiums',     A.stats.podiums,        B.stats.podiums],
      ['Poles',       A.stats.polePositions,  B.stats.polePositions],
      ['Fastest Laps',A.stats.fastestLaps,    B.stats.fastestLaps],
      ['Races',       A.stats.races,          B.stats.races],
      ['DNFs',        A.stats.dnfs,           B.stats.dnfs],
    ];
    compare.innerHTML = `
      <div class="cmp-grid">
        <div class="cmp-col">
          <div class="cmp-name">${esc(A.driver.name)}</div>
          <div class="cmp-sub">${esc(String(A.season.year))} · ${esc(A.season.name)}</div>
          <div class="cmp-flag">${flag(A.driver.country)} ${esc(A.driver.country || '')}</div>
        </div>
        <div class="cmp-mid">
          ${rows.map(([label, a, b]) => `
            <div class="cmp-row">
              <div class="cmp-val ${a > b ? 'win' : a < b ? 'lose' : ''}">${a}</div>
              <div class="cmp-lbl">${label}</div>
              <div class="cmp-val ${b > a ? 'win' : b < a ? 'lose' : ''}">${b}</div>
            </div>`).join('')}
        </div>
        <div class="cmp-col">
          <div class="cmp-name">${esc(B.driver.name)}</div>
          <div class="cmp-sub">${esc(String(B.season.year))} · ${esc(B.season.name)}</div>
          <div class="cmp-flag">${flag(B.driver.country)} ${esc(B.driver.country || '')}</div>
        </div>
      </div>`;
  };

  modal({
    title: `<span class="accent">Compare</span> Drivers`,
    size: 'wide',
    body: `
      <div style="display:flex;gap:12px;margin-bottom:18px">
        <div class="field" style="flex:1;margin:0">
          <label>Driver A</label>
          <select id="cmp-a">
            <option value="">— pick —</option>
            ${allDrivers.map(d => `<option value="${d.key}">${esc(d.label)}</option>`).join('')}
          </select>
        </div>
        <div class="field" style="flex:1;margin:0">
          <label>Driver B</label>
          <select id="cmp-b">
            <option value="">— pick —</option>
            ${allDrivers.map(d => `<option value="${d.key}">${esc(d.label)}</option>`).join('')}
          </select>
        </div>
      </div>
      <div id="cmp-content"></div>`,
    footer: `<button class="btn btn-ghost" data-act="cancel">Close</button>`,
    onMount: (root, close) => {
      $('[data-act="cancel"]', root).onclick = close;
      $('#cmp-a', root).onchange = (e) => { pickA = e.target.value; render(root); };
      $('#cmp-b', root).onchange = (e) => { pickB = e.target.value; render(root); };
      render(root);
    },
  });
}

function openBulkImportDrivers() {
  const season = activeSeason(); if (!season) return;
  let parsed = [];
  // Find next available numbers for any driver without one
  const usedNumbers = new Set(season.drivers.map(d => d.number).filter(n => typeof n === 'number'));
  const nextNumber = () => {
    for (let i = 1; i < 99; i++) if (!usedNumbers.has(i)) { usedNumbers.add(i); return i; }
    return null;
  };

  modal({
    title: `<span class="accent">Bulk Import</span> Drivers`,
    size: 'wide',
    body: `
      <div class="field-help" style="margin-bottom:14px">
        Paste a list of drivers, one per line. Each line can include name + 3-letter country code + race number, in any common format. Examples:
      </div>
      <pre style="background:var(--bg-elev);padding:10px 14px;border-radius:6px;font-size:11px;color:var(--text-soft);margin-bottom:14px;line-height:1.6">44 Lewis Hamilton GBR
Max Verstappen NED 1
Charles Leclerc, MON, 16
Carlos Sainz | ESP | 55
Lando Norris GBR</pre>
      <div class="field">
        <label>Paste your list</label>
        <textarea id="bulk-text" rows="10" placeholder="One driver per line…" style="font-family:var(--f-mono);font-size:12px"></textarea>
      </div>
      <div id="bulk-preview" style="margin-top:14px"></div>`,
    footer: `<button class="btn btn-ghost" data-act="cancel">Cancel</button><button class="btn btn-primary" data-act="ok" disabled>Import 0</button>`,
    onMount: (root, close) => {
      const ta = $('#bulk-text', root);
      const previewEl = $('#bulk-preview', root);
      const okBtn = $('[data-act="ok"]', root);
      const refresh = () => {
        parsed = parseBulkRosterText(ta.value);
        okBtn.disabled = !parsed.length;
        okBtn.textContent = `Import ${parsed.length}`;
        if (!parsed.length) { previewEl.innerHTML = ''; return; }
        previewEl.innerHTML = `
          <div class="members-head" style="margin:14px 0 8px">PREVIEW · ${parsed.length} DRIVER${parsed.length === 1 ? '' : 'S'}</div>
          <div class="bulk-preview-grid">
            ${parsed.map(d => `
              <div class="bulk-preview-row">
                <span class="bulk-preview-num">${d.number || '–'}</span>
                <span class="bulk-preview-name">${esc(d.name)}</span>
                <span class="bulk-preview-flag">${d.country ? flag(d.country) + ' ' + esc(d.country) : '<span style="color:var(--text-muted)">(no flag)</span>'}</span>
              </div>`).join('')}
          </div>`;
      };
      ta.addEventListener('input', refresh);
      $('[data-act="cancel"]', root).onclick = close;
      okBtn.onclick = () => {
        for (const d of parsed) {
          season.drivers.push({
            id: uid(),
            name: d.name,
            number: d.number ?? nextNumber(),
            country: d.country || '',
            photo: '',
            teamId: null,
            dsq: false,
          });
        }
        saveState();
        toast(`Imported ${parsed.length} driver${parsed.length === 1 ? '' : 's'}`, 'success');
        close();
        renderMain();
      };
    },
  });
}

function openRosterClasses(kind) {
  const isDriver = kind === 'driver';
  const season = activeSeason(); if (!season) return;
  const list = () => isDriver ? (state.driverClasses || []) : (state.teamClasses || []);
  const currentCount = isDriver ? (season.drivers || []).length : (season.teams || []).length;
  const noun = isDriver ? 'Driver' : 'Constructor';
  const nounPlural = isDriver ? 'drivers' : 'constructors';

  modal({
    title: `<span class="accent">${noun}</span> Roster Bundles`,
    size: 'wide',
    body: `
      <div class="roster-help" style="margin-bottom:18px;padding:12px 14px;background:var(--bg-elev);border:1px solid var(--border-dim);border-radius:var(--radius);font-size:13px;color:var(--text-soft);line-height:1.55">
        Save the current ${nounPlural} as a named bundle (e.g. "Class of 2025") to reload them into any season later. Saved ${nounPlural} carry their photos${isDriver ? ', numbers, and nationalities' : ', liveries, logos, and country flags'}.
      </div>
      <div class="roster-save-row" style="display:flex;gap:10px;align-items:flex-end;margin-bottom:24px;padding-bottom:24px;border-bottom:1px solid var(--border-dim)">
        <div class="field" style="flex:1;margin:0">
          <label>Bundle name</label>
          <input type="text" id="rc-name" placeholder="e.g. Class of 2025" maxlength="60">
        </div>
        <div class="field" style="flex:1;margin:0">
          <label>Note (optional)</label>
          <input type="text" id="rc-note" placeholder="e.g. Real-world current grid" maxlength="120">
        </div>
        <button class="btn btn-primary" id="rc-save" ${currentCount === 0 ? 'disabled' : ''}>
          ★ SAVE ${currentCount} ${(isDriver ? 'DRIVER' : 'TEAM').toUpperCase()}${currentCount === 1 ? '' : 'S'}
        </button>
      </div>
      <div class="rc-list-head" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;font-family:var(--f-mono);font-size:10px;letter-spacing:0.18em;color:var(--text-muted);text-transform:uppercase">
        <span>Saved bundles</span>
        <span id="rc-count">${list().length} bundle${list().length === 1 ? '' : 's'}</span>
      </div>
      <div id="rc-list"></div>
    `,
    footer: `<button class="btn btn-ghost" data-act="cancel">Done</button>`,
    onMount: (root, close) => {
      const listEl = $('#rc-list', root);
      const countEl = $('#rc-count', root);

      const renderList = () => {
        const all = list();
        countEl.textContent = `${all.length} bundle${all.length === 1 ? '' : 's'}`;
        if (!all.length) {
          listEl.innerHTML = `<div class="empty" style="padding:36px 20px"><div class="empty-headline">NO BUNDLES YET</div><div class="empty-sub">Save the current ${nounPlural} above to create your first one.</div></div>`;
          return;
        }
        listEl.innerHTML = all.map(c => {
          const count = isDriver ? c.drivers.length : c.teams.length;
          const dateStr = new Date(c.savedAt).toLocaleDateString();
          // Tiny preview chips
          const previewSrc = isDriver ? c.drivers : c.teams;
          const previewChips = previewSrc.slice(0, 6).map(item => {
            const initials = isDriver
              ? (item.name || '').split(/\s+/).map(s => s[0] || '').join('').slice(0, 2).toUpperCase()
              : (item.short || (item.name || '').slice(0, 3).toUpperCase());
            const tone = isDriver
              ? `style="border-color:var(--border-hi);color:var(--text-dim)"`
              : `style="border-color:${item.color || '#666'};color:${item.color || '#666'}"`;
            const img = isDriver ? item.photo : item.logo;
            if (img) return `<span class="rc-chip" ${tone} style="background-image:url('${esc(img)}')"></span>`;
            return `<span class="rc-chip" ${tone}>${esc(initials)}</span>`;
          }).join('');
          const overflow = previewSrc.length > 6 ? `<span class="rc-chip rc-more">+${previewSrc.length - 6}</span>` : '';
          return `
            <div class="rc-row" data-id="${c.id}">
              <div class="rc-head">
                <div class="rc-name">${esc(c.name)}</div>
                <div class="rc-meta">${count} ${nounPlural} · saved ${esc(dateStr)}</div>
              </div>
              ${c.note ? `<div class="rc-note">${esc(c.note)}</div>` : ''}
              <div class="rc-chips">${previewChips}${overflow}</div>
              <div class="rc-actions">
                <button class="btn btn-ghost" data-act="load">+ ADD TO SEASON</button>
                <button class="btn btn-ghost" data-act="replace" style="color:var(--sec-yellow)">↻ REPLACE ALL</button>
                <button class="btn btn-ghost" data-act="delete" style="color:var(--red)">× DELETE</button>
              </div>
            </div>`;
        }).join('');
        // Wire actions
        $$('.rc-row', listEl).forEach(row => {
          const id = row.dataset.id;
          const cls = list().find(x => x.id === id);
          if (!cls) return;
          $('[data-act="load"]', row).onclick = () => {
            const n = isDriver ? loadDriverClass(cls, 'add') : loadTeamClass(cls, 'add');
            toast(`Added ${n} ${nounPlural} from "${cls.name}"`, 'success');
            close(); renderMain();
          };
          $('[data-act="replace"]', row).onclick = () => {
            if (!confirm(`Replace ALL current ${nounPlural} with "${cls.name}"?\n\nThis will remove your existing ${currentCount} ${nounPlural}${isDriver ? ' AND wipe every race result' : ' and clear team assignments from all drivers'}. This cannot be undone.`)) return;
            const n = isDriver ? loadDriverClass(cls, 'replace') : loadTeamClass(cls, 'replace');
            toast(`Replaced with ${n} ${nounPlural} from "${cls.name}"`, 'success');
            close(); renderMain();
          };
          $('[data-act="delete"]', row).onclick = () => {
            if (!confirm(`Delete bundle "${cls.name}"?\n\nThis only deletes the saved bundle — it does not affect any season.`)) return;
            deleteRosterClass(kind, id);
            toast('Bundle deleted', 'success');
            renderList();
          };
        });
      };

      $('#rc-save', root)?.addEventListener('click', () => {
        const name = $('#rc-name', root).value;
        const note = $('#rc-note', root).value;
        const cls = isDriver ? saveDriverClass(name, note) : saveTeamClass(name, note);
        if (cls) {
          toast(`Bundle "${cls.name}" saved`, 'success');
          $('#rc-name', root).value = '';
          $('#rc-note', root).value = '';
          renderList();
        }
      });
      $('[data-act="cancel"]', root).onclick = close;
      renderList();
    }
  });
}

/* =====================================================
   CALENDAR PRESETS MODAL — same shape as roster bundles
   Save the current season's race calendar as a named preset,
   then reload it into any season (REPLACE wipes existing races,
   APPEND adds at the end with continued round numbering).
   ===================================================== */
function openCalendarPresets() {
  const season = activeSeason();
  const list = () => state.calendarPresets || [];
  const currentCount = season ? (season.races || []).length : 0;

  modal({
    title: `<span class="accent">Calendar</span> Presets`,
    size: 'wide',
    body: `
      <div class="roster-help" style="margin-bottom:18px;padding:12px 14px;background:var(--bg-elev);border:1px solid var(--border-dim);border-radius:var(--radius);font-size:13px;color:var(--text-soft);line-height:1.55">
        Save the current race calendar as a named preset to reload it into any season later. Saved calendars carry circuit info, country flags, sprint-weekend marks, and round order. Dates and completion state are not stored (those are per-season).
      </div>
      <div class="roster-save-row" style="display:flex;gap:10px;align-items:flex-end;margin-bottom:24px;padding-bottom:24px;border-bottom:1px solid var(--border-dim)">
        <div class="field" style="flex:1;margin:0">
          <label>Preset name</label>
          <input type="text" id="cp-name" placeholder="e.g. 2024 World Championship" maxlength="60">
        </div>
        <div class="field" style="flex:1;margin:0">
          <label>Note (optional)</label>
          <input type="text" id="cp-note" placeholder="e.g. 24-round modern calendar" maxlength="120">
        </div>
        <button class="btn btn-primary" id="cp-save" ${!season || currentCount === 0 ? 'disabled' : ''}>
          ★ SAVE ${currentCount} ROUND${currentCount === 1 ? '' : 'S'}
        </button>
      </div>
      <div class="rc-list-head" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;font-family:var(--f-mono);font-size:10px;letter-spacing:0.18em;color:var(--text-muted);text-transform:uppercase">
        <span>Saved presets</span>
        <span id="cp-count">${list().length} preset${list().length === 1 ? '' : 's'}</span>
      </div>
      <div id="cp-list"></div>
      ${!season ? `<div class="field-help" style="margin-top:14px;color:var(--sec-yellow,#f59e0b)">Open a season to save its calendar as a preset.</div>` : ''}
    `,
    footer: `<button class="btn btn-ghost" data-act="cancel">Done</button>`,
    onMount: (root, close) => {
      const listEl = $('#cp-list', root);
      const countEl = $('#cp-count', root);

      const renderList = () => {
        const all = list();
        countEl.textContent = `${all.length} preset${all.length === 1 ? '' : 's'}`;
        if (!all.length) {
          listEl.innerHTML = `<div class="empty" style="padding:36px 20px"><div class="empty-headline">NO PRESETS YET</div><div class="empty-sub">Save the current calendar above to create your first one.</div></div>`;
          return;
        }
        listEl.innerHTML = all.map(c => {
          const count = c.races.length;
          const sprints = c.races.filter(r => r.sprint).length;
          const dateStr = new Date(c.savedAt).toLocaleDateString();
          // Preview chips — first few rounds with flag/country
          const previewChips = c.races.slice(0, 8).map(r => {
            const code = (r.country || '???').slice(0, 3).toUpperCase();
            return `<span class="rc-chip" style="border-color:var(--border-hi);color:var(--text-dim);font-size:8px;letter-spacing:0.06em">${esc(code)}</span>`;
          }).join('');
          const overflow = c.races.length > 8 ? `<span class="rc-chip rc-more">+${c.races.length - 8}</span>` : '';
          return `
            <div class="rc-row" data-id="${c.id}">
              <div class="rc-head">
                <div class="rc-name">${esc(c.name)}</div>
                <div class="rc-meta">${count} round${count === 1 ? '' : 's'} · ${sprints} sprint${sprints === 1 ? '' : 's'} · saved ${dateStr}</div>
                ${c.note ? `<div class="rc-note">${esc(c.note)}</div>` : ''}
                <div class="rc-chips" style="margin-top:8px">${previewChips}${overflow}</div>
              </div>
              <div class="rc-actions">
                ${season ? `
                  <button class="btn btn-ghost btn-sm" data-act="append">+ APPEND</button>
                  <button class="btn btn-primary btn-sm" data-act="replace">⤴ REPLACE</button>
                ` : ''}
                <button class="btn btn-ghost btn-sm" data-act="del" style="color:var(--red)">× DELETE</button>
              </div>
            </div>`;
        }).join('');

        $$('[data-act="append"]', listEl).forEach(b => {
          b.onclick = () => {
            const id = b.closest('.rc-row').dataset.id;
            const preset = list().find(p => p.id === id); if (!preset) return;
            const added = loadCalendarPreset(preset, 'append');
            toast(`Added ${added} round${added === 1 ? '' : 's'}`, 'success');
            close();
            renderMain();
          };
        });
        $$('[data-act="replace"]', listEl).forEach(b => {
          b.onclick = () => {
            const id = b.closest('.rc-row').dataset.id;
            const preset = list().find(p => p.id === id); if (!preset) return;
            if (season.races?.length && !confirm(`Replace ${season.races.length} existing race${season.races.length === 1 ? '' : 's'} with ${preset.races.length} new round${preset.races.length === 1 ? '' : 's'}? Any unsaved results will be lost.`)) return;
            const added = loadCalendarPreset(preset, 'replace');
            toast(`Loaded ${added} round${added === 1 ? '' : 's'}`, 'success');
            close();
            renderMain();
          };
        });
        $$('[data-act="del"]', listEl).forEach(b => {
          b.onclick = () => {
            const id = b.closest('.rc-row').dataset.id;
            if (!confirm('Delete this preset? Saves using it won\'t be affected.')) return;
            deleteCalendarPreset(id);
            renderList();
            toast('Preset deleted', 'success');
          };
        });
      };

      $('#cp-save', root)?.addEventListener('click', () => {
        const name = $('#cp-name', root).value;
        const note = $('#cp-note', root).value;
        const preset = saveCalendarPreset(name, note);
        if (preset) {
          toast(`Saved "${preset.name}"`, 'success');
          $('#cp-name', root).value = '';
          $('#cp-note', root).value = '';
          renderList();
        }
      });
      $('[data-act="cancel"]', root).onclick = close;
      renderList();
    }
  });
}
/* =====================================================
   IMPORT FROM PASTE
   Parses tabular text copied from results pages and matches
   driver names against the active season's roster.
   ===================================================== */
function parseImportPaste(text, season, kind) {
  // Split into lines, drop empties + likely header rows
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const out = [];
  const drivers = season.drivers;

  // Build a name → driver lookup. Match by full name OR last name (case-insensitive).
  const byFull = new Map();
  const byLast = new Map();
  const byAbbr = new Map();
  drivers.forEach(d => {
    const lower = d.name.toLowerCase();
    byFull.set(lower, d);
    const parts = d.name.trim().split(/\s+/);
    const last = parts[parts.length - 1].toLowerCase();
    if (!byLast.has(last)) byLast.set(last, []);
    byLast.get(last).push(d);
    const a = driverMatchAbbr(d);
    if (a) { if (!byAbbr.has(a)) byAbbr.set(a, []); byAbbr.get(a).push(d); }
  });

  const findDriver = (line) => {
    const lower = line.toLowerCase();
    // Try full name
    for (const [full, drv] of byFull) {
      if (lower.includes(full)) return drv;
    }
    // User-assigned abbreviation as a standalone token (timing exports list the
    // 3-letter code) — honour it before surname matching to avoid conflicts.
    for (const tok of line.toUpperCase().split(/[^A-Z0-9]+/)) {
      const hit = tok && byAbbr.get(tok);
      if (hit && hit.length === 1) return hit[0];
    }
    // Then last name (must be unique among drivers, otherwise prefer match nearest start of line)
    let best = null, bestIdx = Infinity;
    for (const [last, list] of byLast) {
      const i = lower.indexOf(last);
      if (i >= 0 && i < bestIdx && list.length === 1) { best = list[0]; bestIdx = i; }
    }
    if (best) return best;
    // Tied last names: pick the one whose first name also appears
    for (const [last, list] of byLast) {
      if (lower.includes(last) && list.length > 1) {
        for (const d of list) {
          const first = d.name.split(/\s+/)[0].toLowerCase();
          if (lower.includes(first)) return d;
        }
      }
    }
    return null;
  };

  lines.forEach(rawLine => {
    // Strip tabs to spaces and collapse runs
    const line = rawLine.replace(/\t/g, ' ').replace(/\s+/g, ' ').trim();
    if (!line) return;
    // Skip header rows ("POS DRIVER..." etc)
    if (/^(pos|position|p|#|no|driver|car|team)\b/i.test(line) && !/\d/.test(line.split(' ')[0])) return;

    // Extract position — leading integer or status code
    let position = null, dnf = false, dsq = false, dns = false;
    const tokens = line.split(/\s+/);
    const first = tokens[0];
    if (/^\d+$/.test(first)) position = parseInt(first, 10);
    else if (/^(NC|DNF|DNS|DSQ|DQ|DSQ\.|RET|RETIRED)$/i.test(first)) {
      // Status as the first token (some sites do this)
      const s = first.toUpperCase();
      if (s === 'DNF' || s === 'RET' || s === 'RETIRED' || s === 'NC') dnf = true;
      else if (s === 'DNS') dns = true;
      else dsq = true;
    } else {
      return; // can't parse
    }

    // Detect status anywhere on the line (overrides position-based finishing)
    const upper = line.toUpperCase();
    if (/\bDNS\b/.test(upper)) { dns = true; position = null; }
    else if (/\bDSQ\b|\bDQ\b/.test(upper)) { dsq = true; position = null; }
    else if (/\bDNF\b|\bRETIRED?\b/.test(upper)) { dnf = true; position = null; }

    const drv = findDriver(line);
    out.push({ rawLine: line, position, dnf, dsq, dns, driverId: drv?.id || null, driverName: drv?.name || null });
  });

  return out;
}

function openImportModal(kind, race, onApply) {
  const season = activeSeason();
  if (!season) return;
  let parsed = [];

  const labelByKind = { qualifying: 'Qualifying', sprint: 'Sprint Race', race: 'Race' };
  const exampleByKind = {
    qualifying:
`POS  NO  DRIVER          CAR             TIME
1    1   Max Verstappen   Red Bull        1:23.456
2    44  Lewis Hamilton   Mercedes        1:23.789
3    16  Charles Leclerc  Ferrari         1:24.012`,
    sprint:
`POS  NO  DRIVER          CAR             PTS
1    1   Max Verstappen   Red Bull        8
2    44  Lewis Hamilton   Mercedes        7
3    16  Charles Leclerc  Ferrari         6
DNF  4   Lando Norris     McLaren         0`,
    race:
`POS  NO  DRIVER          CAR             TIME/RETIRED   PTS
1    1   Max Verstappen   Red Bull        1:30:34.123    25
2    44  Lewis Hamilton   Mercedes        +5.234         18
3    16  Charles Leclerc  Ferrari         +12.456        15
DNF  4   Lando Norris     McLaren         RETIRED        0`
  };

  modal({
    title: `Import <span class="accent">${labelByKind[kind] || 'Results'}</span>`,
    size: 'wide',
    body: `
      <div style="padding:20px">
        <div style="font-family:var(--f-mono);font-size:10px;letter-spacing:0.18em;color:var(--text-dim);text-transform:uppercase;margin-bottom:8px">PASTE TABLE BELOW</div>
        <textarea class="import-paste-area" id="imp-text" placeholder="Paste the results table here. Tab- or space-separated columns work. Most copy-pasted tables from results pages are accepted."></textarea>
        <div class="import-help">
          <b>How to import:</b> Open the results page on the F1 website (or any results source), select the results table, copy, then paste here.
          The parser reads the leading <b>position number</b> (or DNF/DSQ/DNS) and matches the <b>driver name</b> against your season's roster.<br>
          <b>Example:</b><pre style="margin:8px 0 0;font-family:var(--f-mono);font-size:10px;color:var(--text-muted);white-space:pre-wrap">${esc(exampleByKind[kind] || '')}</pre>
        </div>
        <div id="imp-preview" style="display:none">
          <div style="font-family:var(--f-mono);font-size:10px;letter-spacing:0.18em;color:var(--text-dim);text-transform:uppercase;margin-top:14px;margin-bottom:6px">PREVIEW · review before applying</div>
          <div class="import-preview" id="imp-preview-list"></div>
        </div>
      </div>`,
    footer: `<span id="imp-status" style="font-family:var(--f-mono);font-size:10px;color:var(--text-muted);letter-spacing:0.1em;margin-right:auto"></span><button class="btn btn-ghost" data-act="cancel">Cancel</button><button class="btn btn-ghost" id="imp-parse">PARSE</button><button class="btn btn-primary" id="imp-apply" disabled>APPLY</button>`,
    onMount: (root, close) => {
      const ta = $('#imp-text', root);
      const status = $('#imp-status', root);
      const previewWrap = $('#imp-preview', root);
      const previewList = $('#imp-preview-list', root);
      const applyBtn = $('#imp-apply', root);

      const parseAndPreview = () => {
        parsed = parseImportPaste(ta.value || '', season, kind);
        if (!parsed.length) {
          previewWrap.style.display = 'none';
          status.textContent = 'NO ROWS DETECTED';
          status.style.color = 'var(--red)';
          applyBtn.disabled = true;
          return;
        }
        const matched = parsed.filter(p => p.driverId).length;
        const unmatched = parsed.length - matched;
        status.innerHTML = `${parsed.length} ROWS · <span style="color:var(--sec-green)">${matched} MATCHED</span>${unmatched ? ` · <span style="color:var(--red)">${unmatched} UNMATCHED</span>` : ''}`;
        status.style.color = 'var(--text-muted)';
        previewWrap.style.display = 'block';
        previewList.innerHTML = parsed.map(p => {
          const cls = p.driverId ? 'matched' : 'unmatched';
          const status = p.dns ? 'DNS' : p.dsq ? 'DSQ' : p.dnf ? 'DNF' : (p.position ? `P${p.position}` : '?');
          return `<div class="import-preview-row ${cls}">
            <div class="pos">${status}</div>
            <div>${esc(p.driverName || `Unmatched: "${p.rawLine.slice(0,60)}"`)}</div>
            <div class="status">${p.driverId ? '✓' : 'NO MATCH'}</div>
          </div>`;
        }).join('');
        applyBtn.disabled = matched === 0;
      };

      $('#imp-parse', root).onclick = parseAndPreview;
      ta.oninput = () => { applyBtn.disabled = true; previewWrap.style.display = 'none'; status.textContent = ''; };

      applyBtn.onclick = () => {
        const valid = parsed.filter(p => p.driverId);
        onApply(valid);
        close();
      };
      $('[data-act="cancel"]', root).onclick = close;
      setTimeout(() => ta.focus(), 50);
    }
  });
}

function openSeasonSettings() {
  const season = activeSeason();
  if (!season) return;
  // initialise toggle defaults if loaded from older save
  if (season.polePointEnabled === undefined) season.polePointEnabled = false;
  if (season.flPointEnabled === undefined) season.flPointEnabled = true;
  if (!season.polePointValue) season.polePointValue = 1;
  if (!season.flPointValue)   season.flPointValue = 1;
  modal({
    title: `Season <span class="accent">Settings</span>`,
    body: `
      <div class="field-row">
        <div class="field"><label>Year</label><input type="number" id="ss-year" value="${season.year}"></div>
        <div class="field"><label>Season Name</label><input type="text" id="ss-name" value="${esc(season.name)}"></div>
      </div>
      <div class="field">
        <label>Points System</label>
        <select id="ss-points">
          ${POINTS_SYSTEMS.map(p => `<option value="${p.id}" ${p.id === (season.pointsSystemId || DEFAULT_POINTS_SYSTEM_ID) ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
        </select>
        <span class="field-help">Changing this recalculates standings instantly.</span>
      </div>

      <div class="divider" style="margin:18px 0"></div>
      <div style="font-family:var(--f-mono);font-size:10px;letter-spacing:0.2em;color:var(--text-dim);text-transform:uppercase;margin-bottom:10px">BONUS POINTS</div>

      <label class="settings-toggle-row">
        <input type="checkbox" id="ss-pole-enabled" ${season.polePointEnabled ? 'checked' : ''}>
        <div class="settings-toggle-text">
          <div class="settings-toggle-title">Pole position bonus</div>
          <div class="settings-toggle-sub">Award a bonus point to the pole-sitter</div>
        </div>
        <input type="number" id="ss-pole-value" min="0" max="10" step="1" value="${season.polePointValue}" class="settings-num">
      </label>

      <label class="settings-toggle-row">
        <input type="checkbox" id="ss-fl-enabled" ${season.flPointEnabled ? 'checked' : ''}>
        <div class="settings-toggle-text">
          <div class="settings-toggle-title">Fastest lap bonus</div>
          <div class="settings-toggle-sub">Award a bonus point for the race fastest lap (top-10 only in modern era)</div>
        </div>
        <input type="number" id="ss-fl-value" min="0" max="10" step="1" value="${season.flPointValue}" class="settings-num">
      </label>`,
    footer: `<button class="btn btn-ghost" data-act="cancel">Cancel</button><button class="btn btn-primary" data-act="ok">Save</button>`,
    onMount: (root, close) => {
      $('[data-act="cancel"]', root).onclick = close;
      $('[data-act="ok"]', root).onclick = () => {
        season.year = Number($('#ss-year', root).value) || season.year;
        season.name = $('#ss-name', root).value.trim() || season.name;
        season.pointsSystemId = $('#ss-points', root).value;
        season.polePointEnabled = $('#ss-pole-enabled', root).checked;
        season.flPointEnabled   = $('#ss-fl-enabled', root).checked;
        season.polePointValue = Math.max(0, Number($('#ss-pole-value', root).value) || 0);
        season.flPointValue   = Math.max(0, Number($('#ss-fl-value', root).value) || 0);
        saveState(); close(); renderAll(); toast('Season updated', 'success');
      };
    }
  });
}

/* Build a CSV string for one season in the exact format the CSV importer reads,
   straight from stored data — so re-importing reproduces the same points exactly.
   Encodes position, pole (P), sprint points (/N), fastest lap (F), and per-race
   half/double multipliers as a header suffix (CODE*0.5 / CODE*2). */
function buildSeasonCSVText(season) {
  const ps = POINTS_SYSTEMS.find(p => p.id === season.pointsSystemId) || POINTS_SYSTEMS[0];
  const sprintPts = ps.sprintPoints || [];
  const races = (season.races || []).slice().sort((a, b) => (a.round || 0) - (b.round || 0));
  const standings = calcDriverStandings(season);

  const csvEsc = v => {
    const s = String(v == null ? '' : v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const codeFor = r => {
    let code = (r.country || r.circuit || r.name || 'RND').toUpperCase().trim();
    const m = racePointsMultiplier(r);
    if (m === 0.5) code += '*0.5'; else if (m === 2) code += '*2';
    return code;
  };
  const cellFor = (driverId, race) => {
    const r = (race.results || []).find(x => x.driverId === driverId);
    const sr = (race.sprintResults || []).find(x => x.driverId === driverId);
    if (!r && !sr) return '';
    let cell = '';
    if (r) {
      if (r.dns) cell = 'DNS'; else if (r.dsq) cell = 'DSQ'; else if (r.dnf) cell = 'DNF';
      else if (r.position) cell = String(r.position);
    }
    if (race.poleDriverId === driverId) cell += 'P';
    if (sr && sr.position && !sr.dnf && !sr.dsq && !sr.dns && sprintPts[sr.position - 1] != null) {
      cell += '/' + sprintPts[sr.position - 1];
    }
    if (race.fastestLapDriverId === driverId) cell += 'F';
    return cell;
  };

  const header = ['Position', 'Driver', 'Team', 'Points', ...races.map(codeFor)];
  const rows = standings.map((d, i) => {
    const drv = (season.drivers || []).find(x => x.id === (d.driverId || d.id));
    const team = drv && (season.teams || []).find(t => t.id === drv.teamId);
    const cells = races.map(r => cellFor(drv ? drv.id : null, r));
    return [i + 1, csvEsc(drv ? drv.name : ''), csvEsc(team ? team.name : ''), d.points, ...cells].join(',');
  });
  return [header.map(csvEsc).join(','), ...rows].join('\n');
}

function exportSeasonCSV(seasonId) {
  const save = activeSave();
  const season = save && (save.seasons[seasonId] || save.seasons[state.activeSeasonId]);
  if (!season) return toast('Open a season first', 'warn');
  const csv = buildSeasonCSVText(season);
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const safe = (season.name || 'season').replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '').toLowerCase() || 'season';
  a.href = url; a.download = `${safe}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  toast('Season CSV exported', 'success');
}

/* ---------- import / export ---------- */
function exportData() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `p1-save-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  toast('Export downloaded', 'success');
}
function importData() {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = '.json,application/json';
  inp.onchange = (e) => {
    const f = e.target.files[0]; if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      try {
        const parsed = JSON.parse(r.result);
        if (!parsed.saves) throw new Error('Bad file');
        confirmModal({
          title: 'Replace current data?',
          message: 'This will overwrite your current saves with the imported file. Export first if you want to keep what you have.',
          danger: true,
          onConfirm: () => {
            state = parsed; saveState(); renderAll(); toast('Data imported', 'success');
          }
        });
      } catch (err) {
        toast('Invalid file', 'error');
      }
    };
    r.readAsText(f);
  };
  inp.click();
}

/* ---------- top-level render ---------- */
function renderAll() {
  renderTopbar();
  renderTabs();
  renderMain();
  // Keep presence channel in sync with the active save
  if (CLOUD.enabled && currentUser) {
    const desiredKey = state.activeSaveId ? `presence:save:${state.activeSaveId}` : null;
    const currentKey = presenceChannel?.topic || null;
    if (desiredKey !== currentKey) {
      if (presenceChannel) {
        CLOUD.client.removeChannel(presenceChannel);
        presenceChannel = null;
        presenceState = {};
      }
      if (state.activeSaveId) cloudSubscribePresence(state.activeSaveId);
    }
    renderPresenceDots();
  }
}

/* ---------- init ---------- */
(async () => {
  if (CLOUD.enabled) {
    const signedIn = await cloudInit();
    if (isPublicView) return; // Public view took over — skip normal app render
    if (!signedIn) {
      // Build the shell first so signin screen can target #app
      renderTopbar(); renderTabs();
      // Guest mode persists across reloads — skip the sign-in wall.
      if (isGuest()) { backfillTeamLogosFromPresets(); backfillDriverPhotosFromPresets(); renderAll(); }
      else { renderSignInScreen(); }
      return;
    }
  }
  backfillTeamLogosFromPresets(); backfillDriverPhotosFromPresets();
  renderAll();
})();

// First-run friendly: if no saves at all and we're in 'home' view, leave hero visible.
// If saves exist but user closed without active selection, that's fine.

/* =====================================================
   P1 ENHANCEMENT LAYER v4.0 — Cinematic micro-interactions
   Purely additive. Runs after the app boots and re-attaches
   on every #app / #modal-root mutation.
   ===================================================== */
(function P1Enhance() {
  'use strict';
  if (window.__p1Enhanced) return;
  window.__p1Enhanced = true;

  // Motion removed — all decorative animations are disabled unconditionally.
  const reduced = true;

  const aura = document.createElement('div');
  aura.className = 'p1-aura';
  aura.setAttribute('aria-hidden', 'true');
  document.body.appendChild(aura);

  if (!reduced) {
    const sparks = document.createElement('div');
    sparks.className = 'p1-sparks';
    sparks.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < 14; i++) {
      const s = document.createElement('span');
      s.className = 'p1-spark';
      s.style.left = (Math.random() * 100) + 'vw';
      s.style.animationDelay = (Math.random() * 12) + 's';
      s.style.animationDuration = (10 + Math.random() * 12) + 's';
      sparks.appendChild(s);
    }
    document.body.appendChild(sparks);
  }

  const SPOT_SEL = '.universe-card, .season-card, .driver-card, .team-card, .save-card, ' +
                   '.stat-leader-card, .record-tile, .dash-stat-card.leader, .signin-card, ' +
                   '.charts-section, .dash-block, .dash-hero';
  function onSpotMove(e) {
    const el = e.currentTarget;
    const r = el.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * 100;
    const y = ((e.clientY - r.top) / r.height) * 100;
    el.style.setProperty('--mx', x + '%');
    el.style.setProperty('--my', y + '%');
  }
  function onSpotLeave(e) {
    const el = e.currentTarget;
    el.style.setProperty('--mx', '50%');
    el.style.setProperty('--my', '-100%');
    el.style.removeProperty('--tx');
    el.style.removeProperty('--ty');
  }
  function attachSpotlight(root) {
    root.querySelectorAll(SPOT_SEL).forEach(el => {
      if (el.dataset.p1Spot) return;
      el.dataset.p1Spot = '1';
      el.addEventListener('pointermove', onSpotMove, { passive: true });
      el.addEventListener('pointerleave', onSpotLeave, { passive: true });
    });
  }

  function onTiltMove(e) {
    const el = e.currentTarget;
    const r = el.getBoundingClientRect();
    const dx = ((e.clientX - r.left) / r.width)  - 0.5;
    const dy = ((e.clientY - r.top)  / r.height) - 0.5;
    el.style.setProperty('--tx', (dy * -5).toFixed(2) + 'deg');
    el.style.setProperty('--ty', (dx *  5).toFixed(2) + 'deg');
  }
  function attachTilt(root) {
    if (reduced) return;
    root.querySelectorAll('.driver-card').forEach(el => {
      if (el.dataset.p1Tilt) return;
      el.dataset.p1Tilt = '1';
      el.addEventListener('pointermove', onTiltMove, { passive: true });
    });
  }

  // Number tickers disabled — caused flicker when pages re-rendered quickly
  // (e.g. after importing a season). Numbers display statically.
  const TICK_SEL = '.dash-stat-num, .save-stat-num, .record-tile-value, .stat-leader-bignum-num, ' +
                   '.driver-card .driver-stat-num';
  let tickersAllowed = false;
  function tickNumbers(root) {
    if (reduced || !tickersAllowed) return;
    root.querySelectorAll(TICK_SEL).forEach(el => {
      if (el.dataset.p1Ticked) return;
      const raw = (el.textContent || '').trim();
      const match = raw.match(/^(-?\d+(?:[.,]\d+)?)(.*)$/);
      if (!match) return;
      const target = parseFloat(match[1].replace(',', ''));
      const suffix = match[2] || '';
      if (!isFinite(target) || Math.abs(target) < 1) return;
      const r = el.getBoundingClientRect();
      if (r.bottom < 0 || r.top > (window.innerHeight || 0)) return;
      el.dataset.p1Ticked = '1';
      const isFloat = /[.,]/.test(match[1]);
      const dur = Math.min(700, 260 + Math.min(Math.abs(target), 400) * 1.1);
      const start = performance.now();
      el.textContent = (isFloat ? '0.0' : '0') + suffix;
      el.classList.add('p1-tick-active');
      function step(now) {
        const p = Math.min(1, (now - start) / dur);
        const eased = 1 - Math.pow(1 - p, 3);
        const v = target * eased;
        el.textContent = (isFloat ? v.toFixed(1) : Math.round(v)) + suffix;
        if (p < 1) requestAnimationFrame(step);
        else {
          el.textContent = raw;
          setTimeout(() => el.classList.remove('p1-tick-active'), 350);
        }
      }
      requestAnimationFrame(step);
    });
  }

  // Scroll-reveal disabled — caused page-wide flicker when cloud realtime
  // sync re-rendered card/row content. Cards now appear immediately.
  const REVEAL_SEL = '';
  const revealObs = null;
  function attachReveal(root) { /* no-op */ }

  document.addEventListener('pointerdown', (e) => {
    if (reduced) return;
    const btn = e.target.closest('.btn, .tab, .race-session-tab');
    if (!btn) return;
    if (getComputedStyle(btn).position === 'static') btn.style.position = 'relative';
    const r = btn.getBoundingClientRect();
    const dot = document.createElement('span');
    dot.className = 'p1-ripple';
    dot.style.left = (e.clientX - r.left) + 'px';
    dot.style.top  = (e.clientY - r.top)  + 'px';
    btn.appendChild(dot);
    setTimeout(() => dot.remove(), 700);
  }, { passive: true });

  // Page swap fade — only fires on actual tab changes. Cloud realtime sync
  // can call renderAll() repeatedly with no view change; firing the fade
  // each time visibly flickers the records / stats pages.
  let fadeTimer = null;
  let lastFadeViewKey = null;
  function flashFade() {
    const app = document.getElementById('app');
    if (!app) return;
    const activeTab = document.querySelector('.tab.active');
    const viewName = activeTab?.dataset?.tab || '';
    const backBtn = document.getElementById('race-back');
    const raceId = backBtn ? (app.querySelector('[data-race]')?.dataset?.race || 'race') : '';
    const viewKey = `${viewName}|${raceId}`;
    if (viewKey === lastFadeViewKey) return;
    lastFadeViewKey = viewKey;
    app.classList.add('p1-just-rendered');
    clearTimeout(fadeTimer);
    fadeTimer = setTimeout(() => app.classList.remove('p1-just-rendered'), 480);
  }

  function refresh(root) {
    const r = root || document;
    attachSpotlight(r);
    attachTilt(r);
    attachReveal(r);
    tickNumbers(r);
  }

  function bootstrap() {
    refresh();

    const app = document.getElementById('app');
    if (app) {
      let pendingFade = false;
      new MutationObserver(() => {
        if (pendingFade) return;
        pendingFade = true;
        requestAnimationFrame(() => {
          pendingFade = false;
          flashFade();
        });
      }).observe(app, { childList: true, subtree: false });

      let pendingRefresh = false;
      new MutationObserver(() => {
        if (pendingRefresh) return;
        pendingRefresh = true;
        requestAnimationFrame(() => {
          pendingRefresh = false;
          refresh(app);
        });
      }).observe(app, { childList: true, subtree: true });
    }
    const modalRoot = document.getElementById('modal-root');
    if (modalRoot) {
      new MutationObserver(() => requestAnimationFrame(() => refresh(modalRoot)))
        .observe(modalRoot, { childList: true, subtree: true });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }
})();
