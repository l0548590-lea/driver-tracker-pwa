'use strict';

/* ============================================================
   הגדרות — שנה לפני פריסה
   ============================================================ */
const ADMIN_PASSWORD  = 'admin123';   // ← שנה לסיסמה חזקה!
const SUPABASE_URL    = 'https://djklzeiwasevjatfasnl.supabase.co';
const SUPABASE_KEY    = 'sb_publishable_NPMNAXMEzN_61lpHI0MyhQ_90Dz0D49';

/* ============================================================
   אתחול
   ============================================================ */
const { createClient } = window.supabase;
const db = createClient(SUPABASE_URL, SUPABASE_KEY);

let selectedRouteId   = null;
let selectedRouteName = null;
let stationMap        = null;
let stationMarker     = null;
let editingStationId  = null;

/* ============================================================
   כניסה
   ============================================================ */
document.getElementById('btn-login').addEventListener('click', login);
document.getElementById('password-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') login();
});

function login() {
  const pwd = document.getElementById('password-input').value;
  if (pwd === ADMIN_PASSWORD) {
    document.getElementById('login-screen').classList.add('hidden');
    document.getElementById('admin-screen').classList.remove('hidden');
    initAdmin();
  } else {
    document.getElementById('login-error').textContent = 'סיסמה שגויה';
  }
}

document.getElementById('btn-logout').addEventListener('click', () => {
  document.getElementById('login-screen').classList.remove('hidden');
  document.getElementById('admin-screen').classList.add('hidden');
  document.getElementById('password-input').value = '';
});

/* ============================================================
   טאבים
   ============================================================ */
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach((c) => c.classList.add('hidden'));
    tab.classList.add('active');
    document.getElementById(`tab-${tab.dataset.tab}`).classList.remove('hidden');
    if (tab.dataset.tab === 'history') loadHistory();
    if (tab.dataset.tab === 'live')    initLiveMap();
  });
});

/* ============================================================
   אתחול ראשי
   ============================================================ */
function initAdmin() {
  loadDrivers();
  loadRoutes();
}

/* ============================================================
   נהגים
   ============================================================ */
async function loadDrivers() {
  const { data, error } = await db.from('drivers').select('*').order('name');
  if (error) { showToast('שגיאה בטעינת נהגים'); return; }

  const tbody = document.getElementById('drivers-tbody');
  tbody.innerHTML = '';
  data.forEach((d) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${d.name}</td>
      <td>
        <div style="display:flex;gap:.4rem;align-items:center">
          <input type="text" class="pwd-input" value="${d.password || ''}" data-id="${d.id}"
            style="width:110px;padding:.3rem .5rem;border:1px solid #d1d5db;border-radius:6px;font-size:.85rem">
          <button class="btn-secondary" data-id="${d.id}" data-action="save-password"
            style="padding:.3rem .6rem;font-size:.8rem">שמור</button>
        </div>
      </td>
      <td><input type="checkbox" class="toggle" ${d.is_active ? 'checked' : ''} data-id="${d.id}"></td>
      <td><button class="btn-danger" data-id="${d.id}" data-action="delete-driver">מחק</button></td>
    `;
    tbody.appendChild(tr);
  });

  // שמירת סיסמה
  tbody.querySelectorAll('[data-action="save-password"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const input = tbody.querySelector(`.pwd-input[data-id="${btn.dataset.id}"]`);
      const pwd   = input.value.trim();
      if (!pwd) { showToast('נא להזין סיסמה'); return; }
      const { error } = await db.from('drivers').update({ password: pwd }).eq('id', btn.dataset.id);
      if (error) showToast('שגיאה בשמירה');
      else showToast('סיסמה עודכנה');
    });
  });

  // Toggle פעיל/לא פעיל
  tbody.querySelectorAll('.toggle').forEach((chk) => {
    chk.addEventListener('change', async () => {
      await db.from('drivers').update({ is_active: chk.checked }).eq('id', chk.dataset.id);
      showToast(chk.checked ? 'נהג הופעל' : 'נהג הושבת');
    });
  });

  // מחיקה
  tbody.querySelectorAll('[data-action="delete-driver"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('למחוק נהג זה?')) return;
      const { error } = await db.from('drivers').delete().eq('id', btn.dataset.id);
      if (error) showToast('שגיאה במחיקה');
      else { showToast('נהג נמחק'); loadDrivers(); }
    });
  });
}

document.getElementById('btn-add-driver').addEventListener('click', () => {
  document.getElementById('add-driver-form').classList.toggle('hidden');
});

document.getElementById('btn-cancel-driver').addEventListener('click', () => {
  document.getElementById('add-driver-form').classList.add('hidden');
  document.getElementById('new-driver-name').value = '';
});

document.getElementById('btn-save-driver').addEventListener('click', async () => {
  const name     = document.getElementById('new-driver-name').value.trim();
  const password = document.getElementById('new-driver-password').value;
  if (!name)     { showToast('נא להזין שם'); return; }
  if (!password) { showToast('נא להזין סיסמה'); return; }
  const { error } = await db.from('drivers').insert({ name, password, is_active: true });
  if (error) showToast('שגיאה בשמירה');
  else {
    showToast('נהג נוסף');
    document.getElementById('new-driver-name').value     = '';
    document.getElementById('new-driver-password').value = '';
    document.getElementById('add-driver-form').classList.add('hidden');
    loadDrivers();
  }
});

/* ============================================================
   מסלולים
   ============================================================ */
async function loadRoutes() {
  const { data, error } = await db.from('routes').select('*').order('route_name');
  if (error) { showToast('שגיאה בטעינת מסלולים'); return; }

  const list = document.getElementById('routes-list');
  list.innerHTML = '';
  data.forEach((r) => {
    const li = document.createElement('li');
    li.dataset.id   = r.id;
    li.dataset.name = r.route_name;
    li.innerHTML = `
      <span>${r.route_name}</span>
      <button class="btn-danger" data-id="${r.id}" data-action="delete-route">מחק</button>
    `;
    li.addEventListener('click', () => selectRoute(r.id, r.route_name));
    li.querySelector('[data-action="delete-route"]').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`למחוק את מסלול "${r.route_name}"? כל התחנות יימחקו.`)) return;
      const { error } = await db.from('routes').delete().eq('id', r.id);
      if (error) showToast('שגיאה במחיקה');
      else { showToast('מסלול נמחק'); loadRoutes(); clearStations(); }
    });
    list.appendChild(li);
  });
}

function selectRoute(id, name) {
  selectedRouteId   = id;
  selectedRouteName = name;
  document.querySelectorAll('#routes-list li').forEach((li) => {
    li.classList.toggle('selected', li.dataset.id === id);
  });
  document.getElementById('stations-title').textContent = `תחנות — ${name}`;
  document.getElementById('btn-add-station').classList.remove('hidden');
  loadStations(id);
}

function clearStations() {
  selectedRouteId   = null;
  selectedRouteName = null;
  document.getElementById('stations-title').textContent = 'בחר מסלול';
  document.getElementById('btn-add-station').classList.add('hidden');
  document.getElementById('stations-tbody').innerHTML = '';
}

document.getElementById('btn-add-route').addEventListener('click', () => {
  document.getElementById('add-route-form').classList.toggle('hidden');
});

document.getElementById('btn-cancel-route').addEventListener('click', () => {
  document.getElementById('add-route-form').classList.add('hidden');
  document.getElementById('new-route-name').value = '';
});

document.getElementById('btn-save-route').addEventListener('click', async () => {
  const name = document.getElementById('new-route-name').value.trim();
  if (!name) { showToast('נא להזין שם מסלול'); return; }
  const { error } = await db.from('routes').insert({ route_name: name });
  if (error) showToast('שגיאה בשמירה');
  else {
    showToast('מסלול נוסף');
    document.getElementById('new-route-name').value = '';
    document.getElementById('add-route-form').classList.add('hidden');
    loadRoutes();
  }
});

/* ============================================================
   תחנות
   ============================================================ */
async function loadStations(routeId) {
  const { data, error } = await db
    .from('stations')
    .select('*')
    .eq('route_id', routeId)
    .order('order_index');
  if (error) { showToast('שגיאה בטעינת תחנות'); return; }

  const tbody = document.getElementById('stations-tbody');
  tbody.innerHTML = '';
  data.forEach((s) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${s.order_index}</td>
      <td>${s.station_name}</td>
      <td>${s.station_type || 'צומת'}</td>
      <td>${s.lat?.toFixed(4) ?? ''}</td>
      <td>${s.lon?.toFixed(4) ?? ''}</td>
      <td style="display:flex;gap:.4rem">
        <button class="btn-secondary" data-id="${s.id}" data-action="edit-station" style="padding:.3rem .6rem;font-size:.8rem">עריכה</button>
        <button class="btn-danger"    data-id="${s.id}" data-action="delete-station">מחק</button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('[data-action="edit-station"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const s = data.find((x) => x.id === btn.dataset.id);
      openStationModal(s);
    });
  });

  tbody.querySelectorAll('[data-action="delete-station"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('למחוק תחנה זו?')) return;
      const { error } = await db.from('stations').delete().eq('id', btn.dataset.id);
      if (error) showToast('שגיאה במחיקה');
      else { showToast('תחנה נמחקה'); loadStations(selectedRouteId); }
    });
  });
}

/* ============================================================
   מודל תחנה + מפה
   ============================================================ */
document.getElementById('btn-add-station').addEventListener('click', () => openStationModal(null));

function openStationModal(station) {
  editingStationId = station?.id || null;
  document.getElementById('modal-title').textContent = station ? 'עריכת תחנה' : 'הוסף תחנה';
  document.getElementById('st-name').value  = station?.station_name || '';
  document.getElementById('st-type').value  = station?.station_type || 'צומת';
  document.getElementById('st-lat').value   = station?.lat  || '';
  document.getElementById('st-lon').value   = station?.lon  || '';
  document.getElementById('station-modal').classList.remove('hidden');

  setTimeout(() => {
    if (!stationMap) {
      stationMap = L.map('station-map').setView([31.5, 34.85], 8);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(stationMap);
      stationMap.on('click', (e) => {
        const { lat, lng } = e.latlng;
        document.getElementById('st-lat').value = lat.toFixed(6);
        document.getElementById('st-lon').value = lng.toFixed(6);
        if (stationMarker) stationMap.removeLayer(stationMarker);
        stationMarker = L.marker([lat, lng]).addTo(stationMap);
      });
    } else {
      stationMap.invalidateSize();
    }

    if (station?.lat && station?.lon) {
      if (stationMarker) stationMap.removeLayer(stationMarker);
      stationMarker = L.marker([station.lat, station.lon]).addTo(stationMap);
      stationMap.setView([station.lat, station.lon], 14);
    }
  }, 100);
}

document.getElementById('btn-cancel-station').addEventListener('click', closeStationModal);

function closeStationModal() {
  document.getElementById('station-modal').classList.add('hidden');
  editingStationId = null;
}

document.getElementById('btn-save-station').addEventListener('click', async () => {
  const name = document.getElementById('st-name').value.trim();
  const type = document.getElementById('st-type').value;
  const lat  = parseFloat(document.getElementById('st-lat').value);
  const lon  = parseFloat(document.getElementById('st-lon').value);

  if (!name)            { showToast('נא להזין שם תחנה'); return; }
  if (isNaN(lat) || isNaN(lon)) { showToast('נא לבחור מיקום על המפה'); return; }

  if (editingStationId) {
    const { error } = await db.from('stations').update({
      station_name: name, station_type: type, lat, lon,
    }).eq('id', editingStationId);
    if (error) { showToast('שגיאה בשמירה'); return; }
  } else {
    // חשב order_index
    const { data: existing } = await db
      .from('stations').select('order_index').eq('route_id', selectedRouteId).order('order_index', { ascending: false }).limit(1);
    const nextOrder = (existing?.[0]?.order_index || 0) + 1;

    const { error } = await db.from('stations').insert({
      route_id: selectedRouteId, station_name: name, station_type: type, lat, lon, order_index: nextOrder,
    });
    if (error) { showToast('שגיאה בשמירה'); return; }
  }

  showToast('תחנה נשמרה');
  closeStationModal();
  loadStations(selectedRouteId);
});

/* ============================================================
   היסטוריה
   ============================================================ */
async function loadHistory() {
  // סגור נסיעות שלא עודכנו יותר מ-30 דקות
  const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  await db.from('trips')
    .update({ status: 'completed' })
    .eq('status', 'active')
    .lt('last_update', cutoff);

  const { data, error } = await db
    .from('trips')
    .select('*, drivers(name), routes(route_name)')
    .order('start_time', { ascending: false })
    .limit(50);

  if (error) { showToast('שגיאה בטעינת היסטוריה'); return; }

  const tbody = document.getElementById('history-tbody');
  tbody.innerHTML = '';
  data.forEach((t) => {
    const tr = document.createElement('tr');
    const start = t.start_time ? new Date(t.start_time).toLocaleString('he-IL') : '—';
    const last  = t.last_update ? new Date(t.last_update).toLocaleString('he-IL') : '—';
    const badge = t.status === 'active'
      ? '<span class="badge badge-active">פעיל</span>'
      : '<span class="badge badge-completed">הסתיים</span>';
    tr.innerHTML = `
      <td>${t.drivers?.name || '—'}</td>
      <td>${t.routes?.route_name || '—'}</td>
      <td>${start}</td>
      <td>${last}</td>
      <td>${badge}</td>
    `;
    tbody.appendChild(tr);
  });
}

/* ============================================================
   מעקב חי
   ============================================================ */
let liveMap         = null;
let liveMarkers     = {};
let liveRefreshId   = null;

function initLiveMap() {
  if (!liveMap) {
    liveMap = L.map('admin-live-map').setView([31.5, 34.85], 8);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(liveMap);
  } else {
    liveMap.invalidateSize();
  }

  refreshLiveMap();
  clearInterval(liveRefreshId);
  liveRefreshId = setInterval(refreshLiveMap, 30_000);
}

async function refreshLiveMap() {
  // נסיעות פעילות
  const { data: trips, error } = await db
    .from('trips')
    .select('id, driver_id, route_id, drivers(name), routes(route_name)')
    .eq('status', 'active');

  if (error || !trips?.length) {
    document.getElementById('live-drivers-list').innerHTML =
      '<p class="no-active">אין נהגים פעילים כרגע</p>';
    return;
  }

  const listEl = document.getElementById('live-drivers-list');
  listEl.innerHTML = '';

  for (const trip of trips) {
    const { data: loc } = await db
      .from('location_logs')
      .select('lat, lng, created_at')
      .eq('driver_id', trip.driver_id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!loc) continue;

    const driverName = trip.drivers?.name || '—';
    const routeName  = trip.routes?.route_name || '—';
    const updated    = new Date(loc.created_at).toLocaleTimeString('he-IL');

    // עדכן / צור מרקר
    if (liveMarkers[trip.driver_id]) {
      liveMarkers[trip.driver_id].setLatLng([loc.lat, loc.lng]);
      liveMarkers[trip.driver_id].setTooltipContent(`${driverName} | ${routeName}`);
    } else {
      const icon = L.divIcon({
        className: '',
        html: `<div style="
          width:26px;height:26px;background:#2563eb;
          border:3px solid #fff;border-radius:50%;
          box-shadow:0 2px 8px rgba(0,0,0,0.4);
          display:flex;align-items:center;justify-content:center;
          color:#fff;font-size:11px;font-weight:bold;
        ">${driverName.charAt(0)}</div>`,
        iconSize: [26, 26], iconAnchor: [13, 13],
      });
      liveMarkers[trip.driver_id] = L.marker([loc.lat, loc.lng], { icon })
        .addTo(liveMap)
        .bindTooltip(`${driverName} | ${routeName}`, { permanent: true, direction: 'top', offset: [0, -10] });
    }

    // כרטיסיית נהג
    const card = document.createElement('div');
    card.className = 'live-driver-card';
    card.innerHTML = `
      <strong>${driverName}</strong>
      <span>${routeName}</span>
      <span class="live-time">עדכון: ${updated}</span>
    `;
    card.addEventListener('click', () => liveMap.setView([loc.lat, loc.lng], 15));
    listEl.appendChild(card);
  }

  // הסר מרקרים של נהגים שסיימו
  const activeIds = new Set(trips.map((t) => t.driver_id));
  for (const id of Object.keys(liveMarkers)) {
    if (!activeIds.has(id)) {
      liveMap.removeLayer(liveMarkers[id]);
      delete liveMarkers[id];
    }
  }

  document.getElementById('live-status').textContent =
    `עודכן: ${new Date().toLocaleTimeString('he-IL')}`;
}

/* ============================================================
   Toast
   ============================================================ */
let toastTimer;
function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
}
