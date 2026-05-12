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
async function cloudPullAllSaves() {
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
      polePointValue: sn.pole_point_value,
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

  // Merge cloud saves into state — keep activeSaveId if it still exists, else clear it
  state.saves = newSaves;
  if (state.activeSaveId && !newSaves[state.activeSaveId]) state.activeSaveId = null;
  if (state.activeSeasonId && state.activeSaveId && !newSaves[state.activeSaveId].seasons[state.activeSeasonId]) state.activeSeasonId = null;

  // Reset the push-hash cache: whatever we just pulled is now our up-to-date baseline.
  cloudLastPushHashes = {};

  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch {}
}

/* ---------- CLOUD PUSH: serialize the active save tree and upsert into cloud ----------
   Called from saveState() after every local change. Debounced to avoid hammering the API.
*/
async function cloudPushActive() {
  if (!CLOUD.enabled || !currentUser) return;
  // Upgrade any legacy short IDs to proper UUIDs before pushing — Supabase rejects non-UUID strings
  upgradeIdsToUuids();
  const save = state.saves[state.activeSaveId];
  if (!save) return;

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
      fl_enabled: season.flEnabled !== false,
    };
    const sh = hash(seasonRow);
    if (cloudLastPushHashes[`season:${season.id}`] !== sh) {
      const { error: eSn } = await CLOUD.client.from('seasons').upsert(seasonRow);
      if (eSn) { console.warn('[P1] season sync failed', eSn); continue; }
      cloudLastPushHashes[`season:${season.id}`] = sh;
    }

    // Teams — only push changed rows
    if (season.teams?.length) {
      const teamRows = season.teams.map(t => ({
        id: t.id, season_id: season.id, name: t.name, short: t.short,
        country: t.country, color: t.color, logo: t.logo || null, dsq: t.dsq || false,
      }));
      const changed = teamRows.filter(r => cloudLastPushHashes[`team:${r.id}`] !== hash(r));
      if (changed.length) {
        const { error } = await CLOUD.client.from('teams').upsert(changed);
        if (!error) changed.forEach(r => cloudLastPushHashes[`team:${r.id}`] = hash(r));
      }
    }
    // Drivers
    if (season.drivers?.length) {
      const drvRows = season.drivers.map(d => ({
        id: d.id, season_id: season.id, name: d.name, number: d.number,
        country: d.country, photo: d.photo || null, team_id: d.teamId || null,
        dsq: d.dsq || false,
      }));
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
      }));
      const changedRaces = raceRows.filter(r => cloudLastPushHashes[`race:${r.id}`] !== hash(r));
      if (changedRaces.length) {
        const { error } = await CLOUD.client.from('races').upsert(changedRaces);
        if (!error) changedRaces.forEach(r => cloudLastPushHashes[`race:${r.id}`] = hash(r));
      }
      // Results — only re-push for races whose results array changed
      for (const race of season.races) {
        const resultsHash = hash(race.results || []);
        if (race.results?.length && cloudLastPushHashes[`results:${race.id}`] !== resultsHash) {
          await CLOUD.client.from('race_results').delete().eq('race_id', race.id);
          const rows = race.results.map(rr => ({
            race_id: race.id, driver_id: rr.driverId,
            position: rr.position || null, time: rr.time || null,
            dnf: rr.dnf || false, dsq: rr.dsq || false, dns: rr.dns || false,
          }));
          const { error } = await CLOUD.client.from('race_results').insert(rows);
          if (!error) cloudLastPushHashes[`results:${race.id}`] = resultsHash;
        }
        const sprintHash = hash(race.sprintResults || []);
        if (race.sprintResults?.length && cloudLastPushHashes[`sprint:${race.id}`] !== sprintHash) {
          await CLOUD.client.from('sprint_results').delete().eq('race_id', race.id);
          const rows = race.sprintResults.map(rr => ({
            race_id: race.id, driver_id: rr.driverId,
            position: rr.position || null,
            dnf: rr.dnf || false, dsq: rr.dsq || false, dns: rr.dns || false,
          }));
          const { error } = await CLOUD.client.from('sprint_results').insert(rows);
          if (!error) cloudLastPushHashes[`sprint:${race.id}`] = sprintHash;
        }
      }
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
function scheduleCloudSync() {
  if (!CLOUD.enabled || !currentUser) return;
  pendingCloudWrites++;
  clearTimeout(cloudSyncTimer);
  cloudSyncTimer = setTimeout(() => {
    const n = pendingCloudWrites;
    pendingCloudWrites = 0;
    cloudPushActive().catch(e => {
      console.warn('[P1] cloud push failed', e);
      // Don't toast on every failure — just log. Local save still worked.
    });
  }, 800);
}

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
  // Ignore changes we just pushed (avoids feedback loops). Heuristic: if we have pending writes, skip.
  if (pendingCloudWrites > 0) return;
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
    await cloudPullAllSaves();
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
        flEnabled: sn.fl_enabled,
        polePointEnabled: sn.pole_point_enabled,
        polePointValue: sn.pole_point_value,
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
  // CURRENT ERA
  { name: 'Max Verstappen',       country: 'NED', number: 1,  era: 'Current' },
  { name: 'Lewis Hamilton',       country: 'GBR', number: 44, era: 'Current' },
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

const ERA_FILTERS = ['All', 'Current', '2010s', '2000s', '1990s', '1980s', '1970s', '1960s', '1950s'];

/* =====================================================
   TEAM PRESETS — searchable library of well-known constructors.
   Brand colours are approximations; users can edit after signing.
   ===================================================== */
const TEAM_PRESETS = [
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
const flagAndCode = (code) => code ? `${flag(code)} ${esc(code)}` : '???';
// Returns HTML for a track flag — uses custom flagImage if set, otherwise emoji.
function raceFlagHTML(race, size = 18) {
  if (race?.flagImage) {
    return `<span class="race-flag-img" style="background-image:url('${esc(race.flagImage)}');width:${size + 8}px;height:${Math.round((size + 8) * 0.65)}px"></span>`;
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
// Roster bundles — saved groups of drivers or teams that can be loaded into any season as a class.
// Each: { id, name, savedAt, drivers: [{ name, number, country, photo, era }], note }
if (!state.driverClasses) state.driverClasses = [];
if (!state.teamClasses)   state.teamClasses   = [];
// Calendar presets — saved race calendars, available across all saves (like roster bundles).
if (!state.calendarPresets) state.calendarPresets = [];
// FEATURE #8: Season templates — full snapshots of a season (calendar + teams + drivers, no results)
if (!state.seasonTemplates) state.seasonTemplates = [];
let standingsTab = 'drivers';
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
function saveState() {
  try {
    state.saves[state.activeSaveId] && (state.saves[state.activeSaveId].updatedAt = Date.now());
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
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
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch {}
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
    // Sample 20 drivers — two per team
    let n = 2;
    season.teams.forEach((team, ti) => {
      for (let i = 0; i < 2; i++) {
        const first = SAMPLE_FIRSTS[(ti*2+i) % SAMPLE_FIRSTS.length];
        const last  = SAMPLE_LASTS[(ti*2+i + 5) % SAMPLE_LASTS.length];
        season.drivers.push({
          id: uid(),
          name: `${first} ${last}`,
          number: n++,
          country: SAMPLE_COUNTRIES[(ti*2+i) % SAMPLE_COUNTRIES.length],
          teamId: team.id,
        });
      }
    });
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
function addDriver({ name, number, country, teamId, photo }) {
  const s = activeSeason(); if (!s) return;
  s.drivers.push({
    id: uid(),
    name: name.trim(),
    number: Number(number) || 0,
    country: (country || '').toUpperCase().slice(0,3),
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
function addTeam({ name, short, color, country, logo }) {
  const s = activeSeason(); if (!s) return;
  s.teams.push({
    id: uid(),
    name: name.trim(),
    short: (short || '').toUpperCase().slice(0,4),
    color: color || '#666',
    country: (country || '').toUpperCase().slice(0,3),
    logo: logo || ''
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
        tot.points += ps.points[res.position - 1];
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
          tot.points += ps.sprintPoints[sr.position - 1];
        }
        if (sr.position === 1) tot.sprintWins++;
      });
    }
    // pole
    if (race.poleDriverId && totals[race.poleDriverId] && !totals[race.poleDriverId].championshipDsq) {
      totals[race.poleDriverId].polePositions++;
      // pole-point bonus when enabled per-season
      if (season.polePointEnabled && Number(season.polePointValue) > 0) {
        totals[race.poleDriverId].points += Number(season.polePointValue);
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
            tot.points += flValue;
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
      // aggregate per driver
      dStandings.forEach(d => {
        const drv = season.drivers.find(x => x.id === d.driverId);
        if (!drv) return;
        const key = drv.name.toLowerCase().trim();
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
      // championship counts only if season has completed races
      const hasResults = season.races.some(r => r.completed);
      if (hasResults) {
        if (dStandings.length) {
          // skip champ-DSQd
          const winner = dStandings.find(d => !d.championshipDsq);
          if (winner) {
            const champD = season.drivers.find(x => x.id === winner.driverId);
            if (champD) ensureD(champD.name.toLowerCase().trim(), champD.name).championships++;
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
  act += `<button class="btn btn-ghost btn-sm" id="btn-export">⇣ EXPORT</button>
          <button class="btn btn-ghost btn-sm" id="btn-import">⇡ IMPORT</button>`;
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
  actions.innerHTML = act;

  $('#btn-export') && ($('#btn-export').onclick = exportData);
  $('#btn-import') && ($('#btn-import').onclick = importData);
  $('#btn-new-save') && ($('#btn-new-save').onclick = openNewSaveModal);
  $('#btn-new-season') && ($('#btn-new-season').onclick = openNewSeasonModal);
  $('#btn-share') && ($('#btn-share').onclick = openShareModal);
  $('#btn-account') && ($('#btn-account').onclick = openAccountModal);
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
              : `<div class="dash-leader-portrait" style="border-color:${tc};color:${tc}">${esc(driverInitials(drv?.name || ''))}</div>`;
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
              <div class="next-race-meta-item"><div class="lbl">DATE</div><div class="val">${next.date ? fmtDate(new Date(next.date).getTime()) : 'TBD'}</div></div>
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
                  : `<div class="standings-portrait" style="--team-color:${color}">${esc(driverInitials(drv.name))}</div>`;
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
                    : `<div class="podium-portrait" style="color:${color}"><span style="color:${color}">${esc(driverInitials(drv.name))}</span></div>`;
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
                  : `<div class="driver-photo driver-photo-empty">${esc(driverInitials(d.name))}</div>`}
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
  modal({
    title: editing ? `Edit Driver` : `<span class="accent">Sign</span> a Driver`,
    body: `
      <div class="field">
        <label>Photo</label>
        <div id="d-photo-mount"></div>
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
      const placeholder = editing ? driverInitials(editing.name) : '?';
      mountPhotoUpload($('#d-photo-mount', root), {
        initial: photoValue,
        shape: 'circle',
        placeholder,
        onChange: (v) => { photoValue = v; }
      });
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
          const stripeClass = t.logo ? 'team-stripe-with-logo' : 'team-stripe';
          return `
            <div class="team-card ${t.dsq ? 'champ-dsq' : ''}">
              <div class="team-card-actions">
                <button class="btn btn-sm btn-ghost btn-icon ${t.dsq ? 'active-dsq' : ''}" data-dsq-team="${t.id}" title="${t.dsq ? 'Reinstate to championship' : 'Disqualify from championship'}">${t.dsq ? '✓' : '⊘'}</button>
                <button class="btn btn-sm btn-ghost btn-icon" data-edit-team="${t.id}" title="Edit">✎</button>
                <button class="btn btn-sm btn-danger btn-icon" data-del-team="${t.id}" title="Delete">✕</button>
              </div>
              <div class="${stripeClass}" style="--team-color:${t.color};background:${t.color}">
                ${t.logo ? `<div class="team-logo" style="background-image:url('${esc(t.logo)}')"></div>` : ''}
                <div class="team-short">${esc(t.short || '?')}</div>
              </div>
              <div class="team-card-body">
                <div class="team-name">${esc(t.name)}</div>
                <div class="team-country">${flagAndCode(t.country)}</div>
                ${drivers.length ? `
                  <div class="team-drivers-list">
                    ${drivers.map(d => `
                      <div class="team-driver-row" style="--team-color:${t.color}">
                        <span class="team-driver-num">${d.number}</span>
                        <span class="team-driver-name">${esc(d.name)}</span>
                        <span class="team-driver-pts">${ptsMap[d.id] || 0} PTS</span>
                      </div>`).join('')}
                  </div>` : `<div style="margin-top:12px;font-family:var(--f-mono);font-size:10px;color:var(--text-muted);letter-spacing:0.1em">NO DRIVERS ASSIGNED</div>`}
                ${lastEditedBadge(t)}
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
  const upcomingDate = (() => {
    const next = races.find(r => !r.completed);
    if (!next || !next.date) return '';
    const d = new Date(next.date);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString('en-US', { day: '2-digit', month: 'short' }).toUpperCase();
  })();

  // Build the inner content based on the active filter pill
  let inner = '';
  if (_calFilter === 'races') {
    inner = races.length ? `
      <div class="f1-table-shell">
        <div class="f1-table">
          <div class="f1-table-head">
            <div>GRAND PRIX</div>
            <div>DATE</div>
            <div>WINNER</div>
            <div>TEAM</div>
            <div class="num">LAPS</div>
            <div class="num">TIME</div>
            <div></div>
          </div>
          ${races.map(r => {
            const winner = r.completed && r.results?.length
              ? r.results.find(x => x.position === 1)
              : null;
            const winnerDrv = winner ? season.drivers.find(d => d.id === winner.driverId) : null;
            const winnerTeam = winnerDrv ? season.teams.find(t => t.id === winnerDrv.teamId) : null;
            const teamColor = winnerTeam?.color || '#6b7280';
            const dateLabel = r.date
              ? new Date(r.date).toLocaleDateString('en-US', { day: '2-digit', month: 'short' }).toUpperCase()
              : 'TBD';
            const laps = winner ? (r.totalLaps || '—') : '—';
            const time = winner && winner.time ? winner.time : (winnerDrv ? '—' : '');
            return `
              <div class="f1-table-row ${r.completed ? '' : 'pending'}" data-race="${r.id}">
                <div class="f1-gp">
                  <span class="f1-flag-pill">${raceFlagHTML(r, 22)}</span>
                  <span class="f1-gp-name">${esc(shortGrandPrixName(r))}</span>
                </div>
                <div class="f1-date">${dateLabel}</div>
                <div class="f1-winner">
                  ${winnerDrv
                    ? `<span class="f1-team-mark" style="background:${teamColor}"></span><span class="f1-winner-name">${esc(winnerDrv.name)}</span>`
                    : `<span style="color:var(--text-muted);font-family:var(--f-serif);font-style:italic">awaiting lights-out</span>`}
                </div>
                <div class="f1-team">
                  ${winnerTeam
                    ? `<span class="f1-team-mark" style="background:${teamColor}"></span><span>${esc(winnerTeam.name)}</span>`
                    : `<span style="color:var(--text-muted)">—</span>`}
                </div>
                <div class="f1-num">${laps}</div>
                <div class="f1-num">${esc(time || '—')}</div>
                <div class="f1-row-actions">
                  ${r.sprint ? '<span class="f1-tag sprint">SPR</span>' : ''}
                  <button class="f1-row-btn" data-edit-race="${r.id}" title="Edit info">✎</button>
                  <button class="f1-row-btn danger" data-del-race="${r.id}" title="Remove">✕</button>
                </div>
              </div>`;
          }).join('')}
        </div>
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

        if (!r) return { html: '<span class="mx-cell empty">—</span>' + sprintBadge };
        if (r.dns) return { html: `<span class="mx-cell mx-dns">DNS</span>${sprintBadge}` };
        if (r.dsq) return { html: `<span class="mx-cell mx-dsq">DSQ</span>${sprintBadge}` };
        if (r.dnf) return { html: `<span class="mx-cell mx-dnf">RET</span>${sprintBadge}` };
        if (!r.position) return { html: '<span class="mx-cell empty">—</span>' + sprintBadge };

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
                    : `<div class="f1-portrait small" style="border-color:${tc};color:${tc}">${esc(driverInitials(drv.name))}</div>`;
                  const teamMark = team?.logo
                    ? `<div class="team-logo small" style="background-image:url('${esc(team.logo)}');border-color:${tc}"></div>`
                    : `<span class="team-dot" style="--team-color:${tc}"></span>`;
                  return `
                    <tr class="f1-matrix-row" data-driver="${drv.id}">
                      <td class="f1-matrix-rank">${i + 1}.</td>
                      <td class="f1-matrix-driver">
                        <div class="f1-matrix-driver-cell">
                          ${portrait}
                          <div>
                            <div class="f1-matrix-driver-name">${esc(drv.name)}${row.championshipDsq ? ' <span class="f1-tag dsq">DSQ</span>' : ''}</div>
                            <div class="f1-matrix-driver-meta">${flag(drv.country)} ${esc(drv.country || '')} · #${drv.number}</div>
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
      <div class="f1-table-shell">
        <div class="f1-table f1-team-table">
          <div class="f1-table-head">
            <div class="num">POS</div>
            <div>TEAM</div>
            <div>NATIONALITY</div>
            <div class="num">PTS</div>
            <div></div>
          </div>
          ${stand.map((row, i) => {
            const team = season.teams.find(t => t.id === row.teamId); if (!team) return '';
            return `
              <div class="f1-table-row" data-team="${team.id}">
                <div class="f1-num pos">${i+1}</div>
                <div class="f1-gp">
                  <span class="f1-team-mark large" style="background:${team.color}"></span>
                  <span class="f1-gp-name">${esc(team.name)}${row.championshipDsq ? ' <span class="f1-tag dsq">DSQ</span>' : ''}</span>
                </div>
                <div class="f1-date">${flag(team.country)} ${esc(team.country || '')}</div>
                <div class="f1-num pts">${row.points}</div>
                <div></div>
              </div>`;
          }).join('')}
        </div>
      </div>` : `<div class="empty"><div class="empty-headline">NO TEAMS</div><div class="empty-sub">Add constructors via the team preset library or "+ NEW CONSTRUCTOR".</div></div>`;
  }

  wrap.innerHTML = `
    <div class="f1-results-head">
      <div class="f1-round-strip">
        ${lastCompleted
          ? `<span class="f1-round-pill">R${String(lastCompleted.round).padStart(2,'0')}</span>
             <span class="f1-round-meta">${raceFlagHTML(lastCompleted, 14)} ${esc(shortGrandPrixName(lastCompleted))}</span>`
          : `<span class="f1-round-pill upcoming">R${String((races.find(r => !r.completed)?.round) || 1).padStart(2,'0')}</span>
             <span class="f1-round-meta">${upcomingDate || 'TBD'} · NEXT ROUND</span>`}
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
      if (e.target.closest('[data-edit-race]') || e.target.closest('[data-del-race]')) return;
      state.view = 'race'; state.raceId = row.dataset.race; renderAll();
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

      <div class="field-row">
        <div class="field"><label>Date</label><input type="date" id="r-date" value="${editing?.date || ''}"></div>
        <div class="field" style="justify-content:flex-end">
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
            <input type="checkbox" id="r-sprint" ${editing?.sprint ? 'checked' : ''} style="width:18px;height:18px;accent-color:var(--red)">
            <span>Sprint format weekend</span>
          </label>
        </div>
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
        const date = $('#r-date', root).value;
        const sprint = $('#r-sprint', root).checked;
        if (editing) updateRace(editing.id, { name, circuit, country, date, sprint, flagImage });
        else addRace({ name, circuit, country, date, sprint, flagImage });
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

  wrap.innerHTML = `
    <button class="race-back-btn" id="race-back">‹ ‹ BACK TO CALENDAR</button>
    <div class="race-header" style="margin-top:12px">
      <div class="race-header-left">
        <div class="race-round-big ${race.completed ? '' : 'muted'}">${String(race.round).padStart(2,'0')}</div>
        <div class="race-title-block">
          <div class="eyebrow">${race.completed ? '✓ COMPLETED' : '▸ UPCOMING'} · ${esc(race.country)}</div>
          <div class="name">${esc(race.name)}</div>
          <div class="circuit">${esc(race.circuit || '')}</div>
        </div>
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        ${lastEditedBadge(race)}
        <button class="btn btn-ghost" id="race-edit">✎ EDIT INFO</button>
        ${race.completed ? `<button class="btn btn-danger" id="race-reset">RESET RESULTS</button>` : ''}
      </div>
    </div>

    <div class="race-meta-strip">
      <div class="race-meta-item"><div class="lbl">DATE</div><div class="val">${race.date ? fmtDate(new Date(race.date).getTime()) : 'TBD'}</div></div>
      <div class="race-meta-item"><div class="lbl">FORMAT</div><div class="val">${race.sprint ? 'SPRINT WEEKEND' : 'STANDARD'}</div></div>
      <div class="race-meta-item"><div class="lbl">ENTRIES</div><div class="val">${season.drivers.length}</div></div>
      <div class="race-meta-item"><div class="lbl">POLE</div><div class="val">${race.poleDriverId ? esc(driverName(season, race.poleDriverId)) : '—'}</div></div>
      <div class="race-meta-item"><div class="lbl">FASTEST LAP</div><div class="val">${race.fastestLapDriverId ? esc(driverName(season, race.fastestLapDriverId)) : '—'}</div></div>
    </div>

    ${buildRaceTimelineHTML(race, season)}

    <div id="race-content"></div>
  `;

  setTimeout(() => {
    $('#race-back', wrap).onclick = () => { state.view = 'calendar'; state.raceId = null; renderAll(); };
    $('#race-edit', wrap).onclick = () => openRaceModal(race.id);
    $('#race-reset', wrap)?.addEventListener('click', () => {
      confirmModal({
        title: 'Reset results?',
        message: 'Wipe all positions and stats for this race?',
        danger: true,
        onConfirm: () => {
          updateRace(race.id, { results: [], sprintResults: [], fastestLapDriverId: null, poleDriverId: null, completed: false });
          toast('Results reset', 'warn'); renderMain();
        }
      });
    });

    if (race.completed) renderRaceReadout($('#race-content', wrap), race);
    else renderRaceEditor($('#race-content', wrap), race);
  }, 0);
  return wrap;
}

// Race editor session tab state ('quali' | 'sprint' | 'race')
let _raceEditorTab = 'race';

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
      return `
        <div class="result-row ${champDsq ? 'champ-dsq' : ''}" data-driver="${r.driverId}" style="grid-template-columns: 60px 1fr 70px 70px 60px 60px 60px">
          <input class="result-pos-input" data-key="${key}-pos" type="number" min="1" max="${MAX_POS}" value="${r.position}" placeholder="—" ${champDsq ? 'disabled' : ''}>
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
      return `
        <div class="quali-row ${champDsq ? 'champ-dsq' : ''}" data-driver="${r.driverId}">
          <input class="result-pos-input" data-key="quali-pos" type="number" min="1" max="${MAX_POS}" value="${r.position}" placeholder="—" ${champDsq ? 'disabled' : ''}>
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
        <span class="tag" style="color:var(--sec-purple);border-color:var(--sec-purple)">QUALI</span>
      </div>
      <div class="results-editor">
        <div class="results-editor-head" style="grid-template-columns: 60px 1fr 90px">
          <div>POS</div><div>DRIVER</div><div>BEST TIME</div>
        </div>
        <div id="quali-rows">${qualiRowHTML()}</div>
        <div class="results-editor-foot">
          <span class="results-help">Up to ${MAX_POS} slots. Saves independently.</span>
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
        <span class="tag" style="color:var(--sec-yellow);border-color:var(--sec-yellow)">SPRINT</span>
      </div>
      <div class="results-editor">
        <div class="results-editor-head" style="grid-template-columns: 60px 1fr 70px 70px 60px 60px 60px">
          <div>POS</div><div>DRIVER</div><div></div><div></div><div>DNF</div><div>DSQ</div><div>DNS</div>
        </div>
        <div id="sprint-rows">${rowHTML(sprintWorking, 'sprint')}</div>
        <div class="results-editor-foot">
          <span class="results-help">Sprint saves independently of the main race.</span>
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
        <span class="tag red">RACE</span>
      </div>
      <div class="results-editor">
        <div class="results-editor-head" style="grid-template-columns: 60px 1fr 70px 70px 60px 60px 60px">
          <div>POS</div><div>DRIVER</div><div>POLE</div><div>FL</div><div>DNF</div><div>DSQ</div><div>DNS</div>
        </div>
        <div id="gp-rows">${rowHTML(working, 'gp')}</div>
        <div class="results-editor-foot">
          <span class="results-help">Positions 1–${MAX_POS}. DNF = retired, DSQ = disqualified, DNS = did not start. POLE & FL must be unique.</span>
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
    updateRace(race.id, { qualifyingResults: qualiResults });
    toast(`Qualifying saved · ${qualiResults.length} entries`, 'success');
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
    updateRace(race.id, {
      results: cleaned,
      completed: true,
      fastestLapDriverId: fl,
      poleDriverId: pole,
    });
    toast('Race results saved & marked complete', 'success');
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

function renderRaceReadout(container, race) {
  const season = activeSeason();
  const ps = getPointsSystem(season.pointsSystemId || DEFAULT_POINTS_SYSTEM_ID);
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
  container.innerHTML = `
    <div class="podium" style="max-width:620px;margin-bottom:32px">
      ${[1,0,2].map(idx => {
        const r = podium[idx];
        if (!r) return '<div></div>';
        const drv = season.drivers.find(d => d.id === r.driverId);
        if (!drv) return '<div></div>';
        const color = teamColor(season, drv.teamId);
        const portrait = drv.photo
          ? `<div class="podium-portrait" style="color:${color};background-image:url('${esc(drv.photo)}')"></div>`
          : `<div class="podium-portrait" style="color:${color}"><span style="color:${color}">${esc(driverInitials(drv.name))}</span></div>`;
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
          : `<div class="standings-portrait" style="--team-color:${color}">${esc(driverInitials(drv.name))}</div>`;
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
        return `<div class="result-row" style="grid-template-columns: 60px 44px 1fr 80px 80px 80px">
          <div style="font-family:var(--f-display);font-weight:800;font-size:${posSize};letter-spacing:0.05em;color:${posColor}">${posDisplay}</div>
          <div>${portrait}</div>
          <div class="result-driver">
            <span class="driver-cell-num" style="color:${color};font-family:var(--f-display);font-weight:700;width:28px">${drv.number}</span>
            <div><div class="driver-cell-name">${esc(drv.name)}</div><div class="driver-cell-team">${flag(drv.country)} ${esc(teamName(season, drv.teamId))}</div></div>
          </div>
          <div style="font-family:var(--f-display);font-weight:800;font-size:18px">${pts || '—'}</div>
          <div style="font-family:var(--f-mono);font-size:11px;letter-spacing:0.1em">${statusLabel}</div>
          <div style="display:flex;gap:4px;flex-wrap:wrap">${isPole ? '<span class="tag" style="color:var(--sec-yellow);border-color:var(--sec-yellow)">POLE</span>' : ''}${isFL ? '<span class="tag" style="color:var(--sec-purple);border-color:var(--sec-purple)">FL</span>' : ''}</div>
        </div>`;
      }).join('')}
    </div>
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
                : `<div class="standings-portrait" style="--team-color:${color}">${esc(driverInitials(drv.name))}</div>`;
              const team = season.teams.find(t => t.id === drv.teamId);
              const teamMark = team?.logo
                ? `<div class="team-logo small" style="background-image:url('${esc(team.logo)}');border-color:${color}"></div>`
                : `<span class="team-dot" style="--team-color:${color}"></span>`;
              return `<tr class="standings-row p${i+1}">
                <td class="pos-cell">${i+1}</td>
                <td><div class="driver-cell">
                  ${photo}
                  <span class="driver-cell-num" style="--driver-color:${color};color:${color}">${drv.number}</span>
                  <div><div class="driver-cell-name">${esc(drv.name)}${row.championshipDsq ? ' <span class="tag" style="color:var(--red);border-color:var(--red);font-size:8px">DSQ</span>' : ''}</div><div class="driver-cell-team">${flag(drv.country)} ${esc(drv.country || '')}</div></div>
                </div></td>
                <td><span class="team-pill">${teamMark}${esc(teamName(season, drv.teamId))}</span></td>
                <td class="points-cell">${row.points}</td>
                <td class="gap-cell">${i === 0 ? '—' : '−' + (leaderPts - row.points)}</td>
                <td class="num">${row.wins}</td>
                <td class="num">${row.podiums}</td>
                <td class="num">${row.polePositions}</td>
                <td class="num">${row.fastestLaps}</td>
                <td class="num">${row.dnfs}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table></div>` : `<div class="empty-state"><p>No drivers yet.</p></div>`;
    } else {
      root.innerHTML = tStand.length ? `
        <div class="f1-table-shell">
        <table class="standings-table">
          <thead><tr><th></th><th>CONSTRUCTOR</th><th class="num">PTS</th><th class="num">GAP</th><th class="num">W</th><th class="num">POD</th><th class="num">POLE</th><th class="num">FL</th></tr></thead>
          <tbody>
            ${tStand.map((row, i) => {
              const t = season.teams.find(x => x.id === row.teamId); if (!t) return '';
              const teamMark = t.logo
                ? `<div class="team-logo" style="background-image:url('${esc(t.logo)}');border-color:${t.color}"></div>`
                : `<div class="team-logo" style="border-color:${t.color};color:${t.color}">${esc(t.short || t.name.slice(0,3).toUpperCase())}</div>`;
              return `<tr class="standings-row p${i+1}">
                <td class="pos-cell">${i+1}</td>
                <td><div class="driver-cell">${teamMark}<div><div class="driver-cell-name">${esc(t.name)}</div><div class="driver-cell-team">${esc(t.short)} · ${flagAndCode(t.country)}</div></div></div></td>
                <td class="points-cell">${row.points}</td>
                <td class="gap-cell">${i === 0 ? '—' : '−' + (tLeaderPts - row.points)}</td>
                <td class="num">${row.wins}</td>
                <td class="num">${row.podiums}</td>
                <td class="num">${row.polePositions}</td>
                <td class="num">${row.fastestLaps}</td>
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
        <div class="stat-leader-card stat-leader-empty" style="--accent:#6b7280">
          <div class="stat-leader-bar"></div>
          <div class="stat-leader-head">
            <span class="stat-leader-icon">${cat.icon}</span>
            <span class="stat-leader-title">${esc(cat.label)}</span>
          </div>
          <div class="stat-leader-body">
            <div class="stat-leader-portrait">?</div>
            <div>
              <div class="stat-leader-name"><span class="last">No data</span></div>
              <div class="stat-leader-team">—</div>
              <div class="stat-leader-country">—</div>
            </div>
          </div>
          <div class="stat-leader-bignum">
            <span class="stat-leader-bignum-num">—</span>
            <span class="stat-leader-bignum-unit">${esc(cat.unit)}</span>
          </div>
          <div class="stat-leader-foot">
            <span>POS: <b>—</b></span>
            <span>RACES: <b>—</b></span>
          </div>
        </div>`;
    }
    const drv = leader.driver;
    const team = leader.team;
    const accent = leader.teamColor || '#e10600';
    const { first, last } = splitName(drv.name);
    const photo = drv.photo
      ? `<div class="stat-leader-portrait" style="background-image:url('${esc(drv.photo)}')"></div>`
      : `<div class="stat-leader-portrait">${esc(driverInitials(drv.name))}</div>`;
    const teamMark = team
      ? (team.logo
        ? `<div class="stat-leader-team-mark" style="background-image:url('${esc(team.logo)}')"></div>`
        : `<div class="stat-leader-team-mark">${esc(team.short || '?')}</div>`)
      : '';
    const val = cat.read(leader);
    return `
      <div class="stat-leader-card" data-cat="${cat.id}" style="--accent:${accent}">
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
            <div class="stat-leader-country">${flag(drv.country)} ${esc(drv.country || '')}</div>
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
                : `<div class="h2h-portrait" style="--team-color:${s.teamColor};width:36px;height:36px;font-size:11px">${esc(driverInitials(drv.name))}</div>`;
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
      : `<div class="last5-portrait" style="border-color:${s.teamColor};color:${s.teamColor}">${esc(driverInitials(drv.name))}</div>`;
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
    : `<div class="h2h-portrait" style="--team-color:${teamColor}">${esc(driverInitials(drv.name))}</div>`;

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
            : `<div class="h2h-portrait" style="--team-color:${s.teamColor}">${esc(driverInitials(s.driver.name))}</div>`;
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
  { id: 'driver_fl',           label: 'Most Fastest Laps',      scope: 'drivers', key: 'fastestLaps',   unit: 'FLs' },
  { id: 'driver_dnfs',         label: 'Most DNFs',              scope: 'drivers', key: 'dnfs',          unit: 'DNFs' },
  { id: 'driver_points',       label: 'Most Career Points',     scope: 'drivers', key: 'points',        unit: 'PTS' },
  { id: 'driver_sprint_wins',  label: 'Most Sprint Wins',       scope: 'drivers', key: 'sprintWins',    unit: 'WINS' },
  { id: 'driver_starts',       label: 'Most Race Starts',       scope: 'drivers', key: 'starts',        unit: 'STARTS' },
];

function renderRecords() {
  const recs = calcAllTimeRecords();
  const wrap = document.createElement('div');

  wrap.innerHTML = `
    <div class="f1-results-head">
      <div class="f1-round-strip">
        <span class="f1-round-pill">ALL TIME</span>
        <span class="f1-round-meta">ALL SAVES · ALL SEASONS</span>
      </div>
    </div>

    <h1 class="f1-page-title">RECORD <span style="font-weight:300;color:var(--text-dim)">BOOK</span></h1>

    <div class="records-grid">
      ${RECORD_CATEGORIES.map(cat => {
        const pool = cat.scope === 'drivers' ? recs.drivers : recs.teams;
        const sorted = pool.slice().sort((a,b) => (b[cat.key] || 0) - (a[cat.key] || 0)).filter(x => (x[cat.key] || 0) > 0);
        const leader = sorted[0];
        const accent = leader
          ? (cat.scope === 'drivers' ? (leader.latestTeamColor || '#e10600') : (leader.latestColor || '#e10600'))
          : '#3a3a4a';
        let portraitHTML = '';
        if (leader) {
          if (cat.scope === 'drivers') {
            const initials = leader.name.split(/\s+/).map(s => s[0] || '').join('').slice(0, 2).toUpperCase();
            portraitHTML = leader.photo
              ? `<div class="record-portrait" style="background-image:url('${esc(leader.photo)}');border-color:${accent}"></div>`
              : `<div class="record-portrait" style="border-color:${accent};color:${accent}">${esc(initials)}</div>`;
          } else {
            const short = leader.name.slice(0, 3).toUpperCase();
            portraitHTML = leader.logo
              ? `<div class="record-portrait" style="background-image:url('${esc(leader.logo)}');border-color:${accent}"></div>`
              : `<div class="record-portrait" style="border-color:${accent};color:${accent}">${esc(short)}</div>`;
          }
        } else {
          portraitHTML = `<div class="record-portrait empty">?</div>`;
        }
        return `
          <div class="record-tile" data-cat="${cat.id}" style="--accent:${accent}">
            <div class="record-tile-bar"></div>
            <div class="record-tile-label">${esc(cat.label)} · ${esc(cat.unit)}</div>
            <div class="record-tile-leader-row">
              ${portraitHTML}
              ${leader
                ? `<div class="record-tile-leader-text">
                    <div class="record-tile-value">${leader[cat.key]}</div>
                    <div class="record-tile-leader">${esc(leader.name)}</div>
                  </div>`
                : `<div class="record-tile-leader-text record-tile-empty">
                    <div class="record-tile-empty-mark">—</div>
                    <div class="record-tile-empty-label">No data yet</div>
                  </div>`}
            </div>
            <div class="record-tile-cta">VIEW FULL LIST →</div>
          </div>`;
      }).join('')}
    </div>
  `;

  setTimeout(() => {
    $$('[data-cat]', wrap).forEach(tile => tile.onclick = () => openRecordDetail(tile.dataset.cat, recs));
  }, 0);
  return wrap;
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
          <option value="default" selected>Default — 20 sample drivers (paired to default teams)</option>
          <option value="">— None — empty grid</option>
          ${driverBundles.length ? `<optgroup label="Your saved bundles">${driverBundles.map(b => `<option value="${esc(b.id)}">${esc(b.name)} · ${b.drivers.length} driver${b.drivers.length === 1 ? '' : 's'}</option>`).join('')}</optgroup>` : ''}
        </select>
        <span class="field-help">${driverBundles.length ? `${driverBundles.length} saved bundle${driverBundles.length === 1 ? '' : 's'} available. Saved drivers come without team assignments — sign them after.` : 'Save a driver bundle from the Drivers tab to reuse it here.'}</span>
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
      <button class="btn btn-ghost" id="ns-import-real" style="width:100%;display:flex;flex-direction:column;gap:2px;padding:14px;align-items:flex-start;text-align:left">
        <div style="font-weight:700;font-family:var(--f-display);font-size:14px;letter-spacing:0.02em">⇡ IMPORT REAL SEASON FROM F1.COM PASTE</div>
        <div style="font-family:var(--f-mono);font-size:10px;color:var(--text-muted);letter-spacing:0.04em;text-transform:none">Skip the form — paste the full standings table and we'll build the season for you</div>
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
        createSeason({ year, name, pointsSystemId, teamBundleId, driverBundleId, calendarPresetId });
        close(); renderAll(); toast('Season opened', 'success');
      };
      $('[data-act="ok"]', root).onclick = submit;
      $('[data-act="cancel"]', root).onclick = close;
      $('#ns-import-real', root).onclick = () => { close(); openImportRealSeasonModal(); };
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

  // 1. Build teams — one per unique team name in driver rows, deduplicated through normalizer
  const teamByKey = {}; // normalized lowercase team string -> team object
  for (const d of parsed.drivers) {
    const key = d.team.toLowerCase().trim();
    if (teamByKey[key]) continue;
    const canonical = F1_TEAM_NORMALIZER[key];
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

  // 2. Build drivers — assign a number based on import position. Country left blank.
  const driverIdByImportName = {};
  let nextNum = 1;
  for (const d of parsed.drivers) {
    const teamObj = teamByKey[d.team.toLowerCase().trim()];
    const driverObj = {
      id: uid(),
      name: d.name,
      number: nextNum++,
      country: '',
      teamId: teamObj?.id || null,
      photo: '',
      dsq: false,
    };
    driverIdByImportName[d.name] = driverObj.id;
    season.drivers.push(driverObj);
  }

  // 3. Build races — one per header code (or per raceCodes override).
  // Resolution priority for each race code:
  //   (a) Selected calendar preset's country-code index (if user picked one in modal)
  //   (b) Any other saved calendar preset's index
  //   (c) Track preset library (user customs first, then built-in TRACK_PRESETS)
  //   (d) Hardcoded F1_RACE_CODE_MAP (legacy fallback)
  //   (e) Generic "{CODE} Grand Prix"
  const headerCodes = (opts.raceCodes && opts.raceCodes.length === parsed.headers.length)
    ? opts.raceCodes
    : parsed.headers;

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
    // Step 1: calendar-preset country index
    let meta = codeIndex[codeKey];
    // Step 2: track preset library (user customs + built-in TRACK_PRESETS)
    if (!meta) {
      const tp = matchTrackPresetForCode(codeKey);
      if (tp) meta = { name: tp.name, circuit: tp.circuit, country: tp.country, sprint: !!tp.sprint };
    }
    // Step 3: hardcoded F1 map (legacy)
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
      date: '',
      completed: false,
      results: [],
      sprintResults: [],
      fastestLapDriverId: null,
      poleDriverId: null,
    };
  });
  season.races = raceObjs;

  // 4. Apply results per race
  // F1 sprint scoring (modern era): 8-7-6-5-4-3-2-1 for top 8.
  // We reverse-engineer the sprint finishing position from the sprint points scored.
  const SPRINT_POINT_TO_POS = { 8: 1, 7: 2, 6: 3, 5: 4, 4: 5, 3: 6, 2: 7, 1: 8 };
  for (let ri = 0; ri < raceObjs.length; ri++) {
    const race = raceObjs[ri];
    let anyResults = false;
    let poleDrvId = null;
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
    }
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
        <span class="field-help">Resolution order: (1) selected calendar preset above, (2) any saved calendar preset, (3) your custom track presets, (4) built-in track library, (5) generic "R1, R2…". F1.com code translations applied automatically (SAU→KSA, MON→MCO, SIN→SGP, MXC→MEX, SAP→BRA, ABU→UAE).</span>
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

        // If user supplied race codes AND count matches, use those for the preview header
        const userCodes = racesInp.value.trim().split(/\s+/).filter(Boolean);
        const previewHeaders = (userCodes.length === r.headers.length) ? userCodes : r.headers;

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

        // For each preview code, work out where it resolved
        const resolutions = previewHeaders.map(code => {
          const k = (code || '').toUpperCase().trim();
          // Step 1: calendar preset
          if (codeIndex[k]) return { code, name: codeIndex[k].name, source: `calendar preset: ${codeIndex[k].source}` };
          // Step 2: track preset library (user customs + built-in)
          const tp = matchTrackPresetForCode(k);
          if (tp) return { code, name: tp.name, source: tp.source };
          // Step 3: F1 hardcoded map
          if (F1_RACE_CODE_MAP[k]) return { code, name: F1_RACE_CODE_MAP[k].name, source: 'F1 hardcoded map' };
          // Step 4: generic fallback
          return { code, name: `${code} Grand Prix`, source: 'fallback' };
        });
        const fromCalPreset = resolutions.filter(x => x.source.startsWith('calendar preset')).length;
        const fromCustomTrack = resolutions.filter(x => x.source === 'custom track preset').length;
        const fromBuiltinTrack = resolutions.filter(x => x.source.startsWith('track preset')).length;
        const fromF1Map = resolutions.filter(x => x.source === 'F1 hardcoded map').length;
        const fallback = resolutions.filter(x => x.source === 'fallback').length;

        const completedRaces = r.headers.length;
        const totalResults = r.drivers.reduce((sum, d) => sum + d.cells.filter(Boolean).length, 0);
        const totalSprintPoints = r.drivers.reduce((sum, d) => sum + d.cells.reduce((s, c) => s + (c?.sprintPoints || 0), 0), 0);
        const totalPoles = r.drivers.reduce((sum, d) => sum + d.cells.filter(c => c?.pole).length, 0);

        // Resolution status line — tells the user how many codes matched where
        const statusParts = [];
        if (fromCalPreset)    statusParts.push(`<span style="color:var(--green,#10b981)">● ${fromCalPreset} from calendar preset</span>`);
        if (fromCustomTrack)  statusParts.push(`<span style="color:var(--sec-purple,#a78bfa)">● ${fromCustomTrack} from your custom track presets</span>`);
        if (fromBuiltinTrack) statusParts.push(`<span style="color:var(--sec-blue,#60a5fa)">● ${fromBuiltinTrack} from built-in track library</span>`);
        if (fromF1Map)        statusParts.push(`<span style="color:var(--sec-blue,#60a5fa)">● ${fromF1Map} from F1 map</span>`);
        if (fallback)         statusParts.push(`<span style="color:var(--sec-yellow,#f59e0b)">● ${fallback} fell back to generic "Grand Prix" name</span>`);
        const resolutionStatus = previewHeaders.length ? `
          <div style="font-family:var(--f-mono);font-size:10px;color:var(--text-muted);margin-bottom:10px;padding:8px 12px;background:var(--bg-elev);border-radius:6px;border:1px solid var(--border-dim)">
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
                  ${r.drivers.map(d => `
                    <tr style="border-bottom:1px solid var(--border-dim)">
                      <td style="padding:6px 10px;color:var(--text-muted)">${d.pos}</td>
                      <td style="padding:6px 10px;font-weight:600">${esc(d.name)}</td>
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
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
            <div class="field-help" style="margin-top:10px">
              Teams will be auto-created (with default colors you can edit). Driver countries will be blank — fill in via driver edit. ${userCodes.length === r.headers.length ? 'Race codes mapped to real circuits.' : 'Optionally fill the race calendar field above to get real circuit names.'}
            </div>
          </div>`;
      };

      $('[data-act="parse"]', root).onclick = doParse;
      $('[data-act="cancel"]', root).onclick = close;
      ta.oninput = () => { if (parsed) { parsed = null; okBtn.disabled = true; } };
      racesInp.oninput = () => { if (parsed) doParse(); };  // re-render preview with codes
      okBtn.onclick = () => {
        if (!parsed) return doParse();
        try {
          const year = $('#imp-year', root).value;
          const name = $('#imp-name', root).value;
          const pointsSystemId = $('#imp-points', root).value;
          const userCodes = racesInp.value.trim().split(/\s+/).filter(Boolean);
          const raceCodes = (userCodes.length === parsed.headers.length) ? userCodes : null;
          const calendarPresetId = calSel.value || null;
          buildSeasonFromImport(parsed, { year, name, pointsSystemId, raceCodes, calendarPresetId });
          close();
          renderAll();
          toast(`Imported ${parsed.drivers.length} driver${parsed.drivers.length === 1 ? '' : 's'} across ${parsed.headers.length} race${parsed.headers.length === 1 ? '' : 's'}`, 'success');
        } catch (e) {
          toast('Import failed: ' + e.message, 'error');
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

function getEffectiveDriverPresets() {
  const overrides = state.presetOverrides?.drivers || {};
  const merged = DRIVER_PRESETS.map(p => {
    const k = presetKey(p);
    const ov = overrides[k];
    return ov ? { ...p, ...ov, presetKey: k, isBuiltin: true } : { ...p, presetKey: k, isBuiltin: true };
  });
  const customs = (state.customDriverPresets || []).map(p => ({ ...p, presetKey: presetKey(p), isCustom: true }));
  return [...customs, ...merged];
}

function getEffectiveTeamPresets() {
  const overrides = state.presetOverrides?.teams || {};
  const merged = TEAM_PRESETS.map(p => {
    const k = presetKey(p);
    const ov = overrides[k];
    return ov ? { ...p, ...ov, presetKey: k, isBuiltin: true } : { ...p, presetKey: k, isBuiltin: true };
  });
  const customs = (state.customTeamPresets || []).map(p => ({ ...p, presetKey: presetKey(p), isCustom: true }));
  return [...customs, ...merged];
}

function getEffectiveTrackPresets() {
  const overrides = state.presetOverrides?.tracks || {};
  const merged = TRACK_PRESETS.map(p => {
    const k = presetKey(p);
    const ov = overrides[k];
    return ov ? { ...p, ...ov, presetKey: k, isBuiltin: true } : { ...p, presetKey: k, isBuiltin: true };
  });
  const customs = (state.customTrackPresets || []).map(p => ({ ...p, presetKey: presetKey(p), isCustom: true }));
  return [...customs, ...merged];
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
  if (customIdx >= 0) {
    customs[customIdx] = { ...customs[customIdx], ...updated };
    state[customField] = customs;
  } else {
    state.presetOverrides[target][originalKey] = updated;
  }
  saveState();
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
    data = { name: '', country: '', number: 1, photo: '', era: 'Current' };
  } else if (isTeam) {
    data = { name: '', short: '', color: '#e10600', country: '', logo: '', era: 'Current' };
  } else { // track
    data = { name: '', circuit: '', country: '', length: '', sprint: false, flagImage: '', era: 'Current' };
  }
  const originalKey = existing ? presetKey(existing) : null;

  const eraOptions = ERA_FILTERS.filter(e => e !== 'All').map(e =>
    `<option value="${e}" ${data.era === e ? 'selected' : ''}>${e}</option>`).join('');

  const driverFields = `
    <div class="field-row">
      <div class="field"><label>Driver Name</label><input type="text" id="pe-name" value="${esc(data.name)}" placeholder="e.g. Lewis Hamilton"></div>
      <div class="field" style="max-width:120px"><label>Number</label><input type="number" id="pe-number" min="1" max="99" value="${data.number || 1}"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Country (3-letter code)</label><input type="text" id="pe-country" value="${esc(data.country)}" placeholder="GBR" maxlength="3" style="text-transform:uppercase"></div>
      <div class="field"><label>Era</label><select id="pe-era">${eraOptions}</select></div>
    </div>
    <div class="field">
      <label>Driver Photo</label>
      <div id="pe-photo-mount"></div>
      <span class="field-help">Photo is saved with the preset and copied onto every driver signed from it.</span>
    </div>`;

  const teamFields = `
    <div class="field-row">
      <div class="field"><label>Team Name</label><input type="text" id="pe-name" value="${esc(data.name)}" placeholder="e.g. Williams Racing"></div>
      <div class="field" style="max-width:120px"><label>Short</label><input type="text" id="pe-short" value="${esc(data.short)}" placeholder="WIL" maxlength="4" style="text-transform:uppercase"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Country (3-letter code)</label><input type="text" id="pe-country" value="${esc(data.country)}" placeholder="GBR" maxlength="3" style="text-transform:uppercase"></div>
      <div class="field"><label>Era</label><select id="pe-era">${eraOptions}</select></div>
    </div>
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
    <div class="field-row">
      <div class="field"><label>Country code</label><input type="text" id="pe-country" value="${esc(data.country)}" placeholder="GBR" maxlength="3" style="text-transform:uppercase"></div>
      <div class="field"><label>Era</label><select id="pe-era">${eraOptions}</select></div>
    </div>
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
    footer: `${isEdit && existing.isCustom ? '<button class="btn btn-ghost" data-act="delete" style="color:var(--red);margin-right:auto">Delete preset</button>' : (isEdit && existing.isBuiltin ? '<button class="btn btn-ghost" data-act="reset" style="margin-right:auto">Reset to default</button>' : '')}<button class="btn btn-ghost" data-act="cancel">Cancel</button><button class="btn btn-primary" data-act="ok">Save preset</button>`,
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
        mountUpload('pe-photo-mount', data.photo || '', (v) => { data.photo = v; });
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

      $('[data-act="cancel"]', root).onclick = close;
      $('[data-act="ok"]', root).onclick = () => {
        const name = $('#pe-name', root).value.trim();
        const country = $('#pe-country', root).value.trim().toUpperCase();
        const era = $('#pe-era', root).value;
        if (!name) return toast('Name required', 'error');
        if (isDriver) {
          const number = Math.max(1, Math.min(99, Number($('#pe-number', root).value) || 1));
          const updated = { name, country, era, number, photo: data.photo || '' };
          if (isEdit) savePresetEdit('driver', originalKey, updated);
          else addCustomPreset('driver', updated);
        } else if (isTeam) {
          const short = $('#pe-short', root).value.trim().toUpperCase() || name.slice(0, 3).toUpperCase();
          const color = $('#pe-color-hex', root).value.trim() || '#e10600';
          const updated = { name, short, color, country, era, logo: data.logo || '' };
          if (isEdit) savePresetEdit('team', originalKey, updated);
          else addCustomPreset('team', updated);
        } else { // track
          const circuit = $('#pe-circuit', root).value.trim();
          const length = Number($('#pe-length', root).value) || 0;
          const sprint = $('#pe-sprint', root).checked;
          const updated = { name, circuit, country, era, length, sprint, flagImage: data.flagImage || '' };
          if (isEdit) savePresetEdit('track', originalKey, updated);
          else addCustomPreset('track', updated);
        }
        toast(`Preset ${isEdit ? 'updated' : 'added'}`, 'success');
        close();
        onSaved && onSaved();
      };
      const delBtn = $('[data-act="delete"]', root);
      if (delBtn) delBtn.onclick = () => {
        if (!confirm('Delete this custom preset? This cannot be undone.')) return;
        deleteCustomPreset(kind, originalKey);
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
          if (_presetEraFilter !== 'All' && p.era !== _presetEraFilter) return false;
          if (!q) return true;
          return p.name.toLowerCase().includes(q) || (p.country || '').toLowerCase().includes(q) || (p.era || '').toLowerCase().includes(q);
        });
        if (!items.length) {
          list.innerHTML = `<div class="preset-empty">No presets match "${esc(q)}"</div>`;
          return;
        }
        list.innerHTML = items.map((p, i) => {
          const already = present.has(p.name.toLowerCase().trim());
          const portrait = p.photo
            ? `<div class="preset-portrait" style="background-image:url('${esc(p.photo)}')"></div>`
            : `<div class="preset-portrait preset-portrait-fallback">${esc(driverInitials(p.name))}</div>`;
          const badges = [];
          if (p.isCustom) badges.push('<span class="preset-badge custom">MINE</span>');
          else if (state.presetOverrides?.drivers?.[p.presetKey]) badges.push('<span class="preset-badge edited">EDITED</span>');
          return `<div class="preset-row ${already ? 'added' : ''}" data-idx="${i}">
            ${portrait}
            <div class="preset-num">${p.number}</div>
            <div>
              <div class="preset-name">${esc(p.name)} ${badges.join(' ')}</div>
              <div class="preset-meta">${esc(p.era)}</div>
            </div>
            <div class="preset-flag">${flag(p.country)} ${esc(p.country || '')}</div>
            <button class="preset-edit-btn" data-edit="${i}" title="Edit preset">✎</button>
            <button class="preset-add-btn">${already ? '✓ ADDED' : '+ SIGN'}</button>
          </div>`;
        }).join('');
        $$('.preset-row', list).forEach(row => {
          row.onclick = (ev) => {
            // Edit click handled separately
            if (ev.target.closest('[data-edit]')) return;
            if (row.classList.contains('added')) return;
            const p = items[Number(row.dataset.idx)];
            const usedNums = new Set(season.drivers.map(d => d.number));
            let num = p.number || 2;
            while (usedNums.has(num)) num = num + 1 > 99 ? 2 : num + 1;
            const teamCounts = {};
            season.teams.forEach(t => teamCounts[t.id] = 0);
            season.drivers.forEach(d => { if (d.teamId) teamCounts[d.teamId] = (teamCounts[d.teamId] || 0) + 1; });
            const freeTeam = season.teams.find(t => teamCounts[t.id] < 2) || season.teams[0];
            // Photo from preset is copied onto the new driver
            addDriver({ name: p.name, number: num, country: p.country, teamId: freeTeam.id, photo: p.photo || '' });
            toast(`${p.name} signed`, 'success');
            renderList();
            renderMain();
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
          if (_teamPresetEraFilter !== 'All' && p.era !== _teamPresetEraFilter) return false;
          if (!q) return true;
          return p.name.toLowerCase().includes(q) || (p.country || '').toLowerCase().includes(q) || (p.era || '').toLowerCase().includes(q) || (p.short || '').toLowerCase().includes(q);
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
          return `<div class="preset-row ${already ? 'added' : ''}" data-idx="${i}">
            ${swatch}
            <div class="preset-num" style="color:${p.color};font-size:13px">${esc(p.short)}</div>
            <div>
              <div class="preset-name">${esc(p.name)} ${badges.join(' ')}</div>
              <div class="preset-meta">${esc(p.era)}</div>
            </div>
            <div class="preset-flag">${flag(p.country)} ${esc(p.country || '')}</div>
            <button class="preset-edit-btn" data-edit="${i}" title="Edit preset">✎</button>
            <button class="preset-add-btn">${already ? '✓ ADDED' : '+ ADD'}</button>
          </div>`;
        }).join('');
        $$('.preset-row', list).forEach(row => {
          row.onclick = (ev) => {
            if (ev.target.closest('[data-edit]')) return;
            if (row.classList.contains('added')) return;
            const p = items[Number(row.dataset.idx)];
            // Logo and color copied onto the new team
            addTeam({ name: p.name, short: p.short, color: p.color, country: p.country, logo: p.logo || '' });
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
          if (_trackPresetEraFilter !== 'All' && p.era !== _trackPresetEraFilter) return false;
          if (!q) return true;
          return p.name.toLowerCase().includes(q)
            || (p.circuit || '').toLowerCase().includes(q)
            || (p.country || '').toLowerCase().includes(q)
            || (p.era || '').toLowerCase().includes(q);
        });
        if (!items.length) {
          list.innerHTML = `<div class="preset-empty">No presets match "${esc(q)}"</div>`;
          return;
        }
        list.innerHTML = items.map((p, i) => {
          const already = present.has(p.name.toLowerCase().trim() + '|' + (p.country || '').toUpperCase());
          const flagBlock = p.flagImage
            ? `<div class="preset-portrait" style="background-image:url('${esc(p.flagImage)}');border-color:var(--border-hi);background-size:cover"></div>`
            : `<div class="preset-portrait preset-portrait-fallback" style="font-size:20px;line-height:1">${flag(p.country)}</div>`;
          const badges = [];
          if (p.isCustom) badges.push('<span class="preset-badge custom">MINE</span>');
          else if (state.presetOverrides?.tracks?.[p.presetKey]) badges.push('<span class="preset-badge edited">EDITED</span>');
          if (p.sprint) badges.push('<span class="preset-badge sprint">SPR</span>');
          const lengthStr = p.length ? `${Number(p.length).toFixed(3)} km` : '';
          return `<div class="preset-row ${already ? 'added' : ''}" data-idx="${i}">
            ${flagBlock}
            <div class="preset-num" style="font-size:10px;font-family:var(--f-mono);color:var(--text-dim)">${esc(p.country || '')}</div>
            <div>
              <div class="preset-name">${esc(p.name)} ${badges.join(' ')}</div>
              <div class="preset-meta">${esc(p.circuit || '')}${lengthStr ? ' · ' + lengthStr : ''} · ${esc(p.era)}</div>
            </div>
            <div class="preset-flag"></div>
            <button class="preset-edit-btn" data-edit="${i}" title="Edit preset">✎</button>
            <button class="preset-add-btn">${already ? '✓ ADDED' : '+ ADD'}</button>
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
  drivers.forEach(d => {
    const lower = d.name.toLowerCase();
    byFull.set(lower, d);
    const parts = d.name.trim().split(/\s+/);
    const last = parts[parts.length - 1].toLowerCase();
    if (!byLast.has(last)) byLast.set(last, []);
    byLast.get(last).push(d);
  });

  const findDriver = (line) => {
    const lower = line.toLowerCase();
    // Try full name
    for (const [full, drv] of byFull) {
      if (lower.includes(full)) return drv;
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
      renderSignInScreen();
      return;
    }
  }
  renderAll();
})();

// First-run friendly: if no saves at all and we're in 'home' view, leave hero visible.
// If saves exist but user closed without active selection, that's fine.
