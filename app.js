'use strict';

/* ============================================================
   CONFIGURATION
   Keys come from config.js (gitignored).  Fallbacks here are
   used only in demo / local dev without a config.js file.
   ============================================================ */
const CONFIG = Object.assign(
  {
    SUPABASE_URL:   'https://djklzeiwasevjatfasnl.supabase.co',
    SUPABASE_KEY:   'sb_publishable_NPMNAXMEzN_61lpHI0MyhQ_90Dz0D49',
    WEBHOOK_URL:    '',
    API_KEY:        '',

    /** How often to insert a row into location_logs (ms) */
    SEND_INTERVAL:  30_000,

    /** Radius in metres within which a driver is "at" a station */
    STATION_RADIUS: 150,

    /** Auto-shutdown after this many ms with no GPS movement */
    SAFETY_TIMEOUT: 30 * 60 * 1000,
  },
  window.APP_CONFIG || {},
);


/* ============================================================
   APPLICATION STATE
   ============================================================ */
const state = {
  // Data fetched from Supabase
  drivers: [],
  routes: {},
  driverMap: {},   // name → uuid
  routeMap:  {},   // name → uuid
  tripId: null,    // uuid of the current active trip

  // Current trip selections
  driver: null,
  route: null,
  stations: [],

  // Station tracking
  currentStationIdx: -1,  // index of the last station passed; -1 = none yet
  lastStationTime: null,  // Date.now() when the last station was detected
  lastMovementTime: null, // Date.now() on every GPS position update
  skippedStations: new Set(), // indices of stations muted for this trip

  // GPS
  watchId: null,
  lastPosition: null,     // { lat, lon, timestamp }

  // Map (Leaflet)
  map: null,
  driverMarker: null,
  nextStationMarker: null,
  routeLine: null,
  stationMarkers: [],

  // Timers
  sendIntervalId: null,
  countdownId: null,
  safetyCheckId: null,
  sendCountdown: 0,

  // Wake Persistence handles
  wakeLock: null,         // Screen Wake Lock object
  audioCtx: null,        // AudioContext for silent audio session
  audioSource: null,     // BufferSourceNode (silent loop)
  videoStream: null,     // MediaStream fed to the <video> element

  // Flag — prevents double-stop
  tracking: false,

  // תחנה סופית
  finalStationReached: false,
  autoEndTimerId: null,
};


/* ============================================================
   DOM REFERENCES
   ============================================================ */
const $ = (id) => document.getElementById(id);

const dom = {
  // Screens
  screenLoading:   $('screen-loading'),
  screenDriver:    $('screen-driver'),
  screenRoute:     $('screen-route'),
  screenStations:  $('screen-stations'),
  screenTracking:  $('screen-tracking'),
  screenEnded:     $('screen-ended'),

  // Driver screen
  driverUsername:   $('driver-username'),
  driverPassword:   $('driver-password'),
  driverLoginError: $('driver-login-error'),
  btnDriverNext:    $('btn-driver-next'),

  // Route screen
  routeDriverLabel: $('route-driver-label'),
  routeSelect:     $('route-select'),
  btnRouteNext:    $('btn-route-next'),
  btnRouteBack:    $('btn-route-back'),

  // Stations screen
  stationsRouteLabel: $('stations-route-label'),
  stationsList:    $('stations-list'),
  btnStartTrip:    $('btn-start-trip'),
  btnStationsBack: $('btn-stations-back'),

  // Tracking screen
  trackDriverLabel: $('track-driver-label'),
  trackRouteLabel:  $('track-route-label'),
  currentStation:   $('current-station'),
  nextStation:      $('next-station'),
  gpsStatus:        $('gps-status'),
  nextSendLabel:    $('next-send-label'),
  wakeIcon:         $('wake-icon'),
  wakeStatus:       $('wake-status'),
  btnEndTrip:       $('btn-end-trip'),

  // Ended screen
  endReason:       $('end-reason'),
  btnRestart:      $('btn-restart'),

  // Misc
  nosleepVideo:    $('nosleep-video'),
  errorToast:      $('error-toast'),
};


/* ============================================================
   SUPABASE CLIENT
   ============================================================ */
const { createClient } = window.supabase;
const db = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY);


/* ============================================================
   ENTRY POINT
   ============================================================ */
document.addEventListener('DOMContentLoaded', () => {
  registerServiceWorker();
  bindEvents();
  loadData();
});


/* ============================================================
   SERVICE WORKER REGISTRATION
   ============================================================ */
function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker
      .register('./sw.js')
      .then(() => console.log('[SW] Registered'))
      .catch((err) => console.warn('[SW] Registration failed:', err));
  }
}


/* ============================================================
   SCREEN MANAGEMENT
   ============================================================ */
const SCREENS = ['loading', 'driver', 'route', 'stations', 'tracking', 'ended'];

function showScreen(name) {
  SCREENS.forEach((s) => {
    const el = dom[`screen${s.charAt(0).toUpperCase() + s.slice(1)}`];
    if (el) el.classList.toggle('active', s === name);
  });
}


/* ============================================================
   DATA LOADING
   ============================================================ */
/* נתוני הדגמה — מוצגים כאשר ה-API עדיין לא מוגדר */
const DEMO_DATA = {
  drivers: ['ישראל ישראלי', 'אבי כהן', 'מרים לוי', 'דוד דהן'],
  routes: {
    'מסלול צפון — בוקר': [
      { name: 'תחנה מרכזית', lat: 32.0853, lon: 34.7818 },
      { name: 'רחוב הרצל 5',  lat: 32.0900, lon: 34.7850 },
      { name: 'בית הספר א\'',  lat: 32.0950, lon: 34.7900 },
      { name: 'פארק העיר',    lat: 32.1000, lon: 34.7950 },
      { name: 'קצה המסלול',   lat: 32.1050, lon: 34.8000 },
    ],
    'מסלול דרום — צהריים': [
      { name: 'תחנה מרכזית', lat: 32.0853, lon: 34.7818 },
      { name: 'שוק הכרמל',   lat: 32.0800, lon: 34.7770 },
      { name: 'גן ילדים ב\'',  lat: 32.0750, lon: 34.7720 },
      { name: 'מרכז קהילתי', lat: 32.0700, lon: 34.7680 },
    ],
    'מסלול מזרח — ערב': [
      { name: 'תחנה מרכזית',  lat: 32.0853, lon: 34.7818 },
      { name: 'בית חולים',    lat: 32.0870, lon: 34.7900 },
      { name: 'אוניברסיטה',   lat: 32.0890, lon: 34.8000 },
      { name: 'תחנת רכבת',   lat: 32.0910, lon: 34.8100 },
    ],
  },
};

function isDemoMode() {
  return !CONFIG.SUPABASE_URL || CONFIG.SUPABASE_URL.includes('YOUR_SUPABASE');
}


async function loadData() {
  showScreen('loading');

  if (isDemoMode()) {
    await new Promise((r) => setTimeout(r, 800));
    state.drivers = DEMO_DATA.drivers;
    state.routes  = DEMO_DATA.routes;
    populateDriverSelect();
    showScreen('driver');
    showToast('מצב הדגמה — נתונים מדומים', 4000);
    return;
  }

  try {
    // טעינת נהגים פעילים
    const { data: driversData, error: driversErr } = await db
      .from('drivers')
      .select('id, name')
      .eq('is_active', true)
      .order('name');
    if (driversErr) throw driversErr;

    // טעינת מסלולים + תחנות
    const { data: routesData, error: routesErr } = await db
      .from('routes')
      .select('id, route_name, stations(id, station_name, lat, lon, order_index, station_type)')
      .order('route_name');
    if (routesErr) throw routesErr;

    state.driverMap = {};
    state.drivers = driversData.map((d) => {
      state.driverMap[d.name] = d.id;
      return d.name;
    });

    state.routeMap = {};
    state.routes   = {};
    for (const route of routesData) {
      state.routeMap[route.route_name] = route.id;
      const sorted = (route.stations || []).sort((a, b) => a.order_index - b.order_index);
      state.routes[route.route_name] = sorted.map((s) => ({
        id:   s.id,
        name: s.station_name,
        lat:  s.lat,
        lon:  s.lon,
        סוג:  s.station_type || 'צומת',
      }));
    }

    if (state.drivers.length === 0) throw new Error('לא נמצאו נהגים בבסיס הנתונים');

    populateDriverSelect();
    showScreen('driver');
  } catch (err) {
    console.error('[loadData]', err);
    showToast(`שגיאה בטעינה: ${err.message}`);
    setTimeout(() => { showScreen('loading'); setTimeout(loadData, 1000); }, 4000);
  }
}


/* ============================================================
   STEP 1 — DRIVER SELECTION
   ============================================================ */
function populateDriverSelect() {
  dom.btnDriverNext.disabled = true;
}


/* ============================================================
   DRIVER LOGIN
   ============================================================ */
async function validateDriverLogin(username, password) {
  if (isDemoMode()) {
    state.driver = username;
    return true;
  }
  const { data, error } = await db
    .from('drivers')
    .select('id, name')
    .eq('name', username)
    .eq('password', password)
    .eq('is_active', true)
    .maybeSingle();
  if (error || !data) return false;
  state.driver = data.name;
  state.driverMap[data.name] = data.id;
  return true;
}


/* ============================================================
   STEP 2 — ROUTE SELECTION
   ============================================================ */
function populateRouteSelect() {
  dom.routeSelect.innerHTML = '<option value="">— בחר מסלול —</option>';
  Object.keys(state.routes).forEach((routeName) => {
    const opt = document.createElement('option');
    opt.value = routeName;
    opt.textContent = routeName;
    dom.routeSelect.appendChild(opt);
  });
  dom.btnRouteNext.disabled = true;
}


/* ============================================================
   STEP 3 — STATIONS LIST (read-only display)
   ============================================================ */
function renderStationsList() {
  const stations = state.routes[state.route] || [];
  state.stations = stations;
  state.skippedStations.clear();

  dom.stationsRouteLabel.textContent = `מסלול: ${state.route}`;
  dom.stationsList.innerHTML = '';

  if (stations.length === 0) {
    dom.stationsList.innerHTML =
      '<div class="station-item" style="color:var(--text-muted)">אין תחנות מוגדרות</div>';
    return;
  }

  stations.forEach((st, i) => {
    const name = typeof st === 'string' ? st : (st.name || `תחנה ${i + 1}`);
    const item = document.createElement('div');
    item.className = 'station-item';
    item.dataset.index = i;
    item.innerHTML = `
      <div class="station-num">${i + 1}</div>
      <div class="station-item-name">${name}</div>
      <button class="btn-skip-station" data-index="${i}" title="דלג על תחנה זו">דלג</button>
    `;
    dom.stationsList.appendChild(item);
  });
}


/* ============================================================
   STEP 4 — START TRIP
   ============================================================ */
async function startTrip() {
  state.tracking = true;
  state.currentStationIdx = -1;
  state.lastStationTime = Date.now();
  state.lastMovementTime = Date.now();
  state.lastPosition = null;
  state.sendCountdown = CONFIG.SEND_INTERVAL / 1000;

  // Update tracking screen meta labels
  dom.trackDriverLabel.textContent = state.driver;
  dom.trackRouteLabel.textContent  = state.route;

  // Show first non-skipped station immediately
  const firstIdx     = nextNonSkippedIdx(0);
  const firstStation = firstIdx >= 0 ? state.stations[firstIdx] : null;
  dom.currentStation.textContent = 'ממתין למיקום...';
  dom.nextStation.textContent    = firstStation
    ? (typeof firstStation === 'string' ? firstStation : firstStation.name)
    : '--';

  showScreen('tracking');

  // --- יצירת נסיעה ב-Supabase ---
  if (!isDemoMode()) {
    const { data: tripData, error: tripErr } = await db
      .from('trips')
      .insert({
        driver_id:             state.driverMap?.[state.driver] || null,
        route_id:              state.routeMap?.[state.route]   || null,
        status:                'active',
        current_station_index: -1,
        start_time:            new Date().toISOString(),
        last_update:           new Date().toISOString(),
      })
      .select()
      .single();
    if (!tripErr) {
      state.tripId = tripData.id;
      logEvent('trip_start');
    }
  }

  // --- אתחול המפה (השהייה קצרה כדי שה-DOM יתרנדר לפני Leaflet) ---
  setTimeout(initMap, 50);

  // --- Wake Persistence (must be called inside a user-gesture handler) ---
  await WakePersistence.enable();

  // --- GPS ---
  if (!navigator.geolocation) {
    showToast('הדפדפן אינו תומך ב-GPS. נסה Chrome במכשיר אנדרואיד.');
    return;
  }

  state.watchId = navigator.geolocation.watchPosition(
    onPositionUpdate,
    onPositionError,
    {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 20_000,
    }
  );

  // --- Location send interval (every 30 s) ---
  state.sendIntervalId = setInterval(sendLocation, CONFIG.SEND_INTERVAL);

  // --- Countdown display (updates every second) ---
  state.countdownId = setInterval(() => {
    if (!state.tracking) return;
    state.sendCountdown = Math.max(0, state.sendCountdown - 1);
    dom.nextSendLabel.textContent =
      state.sendCountdown > 0
        ? `שולח בעוד: ${state.sendCountdown} שנ'`
        : 'שולח...';
    if (state.sendCountdown === 0) {
      state.sendCountdown = CONFIG.SEND_INTERVAL / 1000;
    }
  }, 1000);

  // --- Safety timeout check (runs every minute) ---
  state.safetyCheckId = setInterval(() => {
    if (!state.tracking) return;
    const elapsed = Date.now() - state.lastMovementTime;
    if (elapsed > CONFIG.SAFETY_TIMEOUT) {
      endTrip('סיום אוטומטי — לא זוהה תנועה במשך 30 דקות');
    }
  }, 60_000);
}


/* ============================================================
   GPS — POSITION UPDATE
   ============================================================ */
function onPositionUpdate(position) {
  const { latitude: lat, longitude: lon, accuracy } = position.coords;

  state.lastPosition = {
    lat,
    lon,
    timestamp: new Date().toISOString(),
  };
  state.lastMovementTime = Date.now();

  dom.gpsStatus.textContent = `GPS פעיל \u00B1${Math.round(accuracy)}\u05DE`;

  // עדכון מיקום על המפה
  updateMapDriver(lat, lon);

  // Auto-detect station proximity if coordinates are available
  detectCurrentStation(lat, lon);
}

function onPositionError(err) {
  const msgs = {
    1: 'הרשאת GPS נדחתה. אנא אפשר גישה למיקום.',
    2: 'מיקום אינו זמין. בדוק שה-GPS מופעל.',
    3: 'פסק זמן GPS. מנסה שנית...',
  };
  const msg = msgs[err.code] || `שגיאת GPS: ${err.message}`;
  dom.gpsStatus.textContent = msg;
  console.warn('[GPS error]', err.code, err.message);
}


/* ============================================================
   STATION AUTO-DETECTION
   ============================================================ */
/**
 * Compares the driver's current position against all stations that
 * come AFTER the last confirmed station. The first one within
 * STATION_RADIUS meters is marked as "reached".
 *
 * Stations without lat/lon coordinates are skipped — auto-detection
 * simply won't fire for those routes.
 */
function detectCurrentStation(lat, lon) {
  const { stations, currentStationIdx } = state;
  if (!stations.length) return;

  for (let i = currentStationIdx + 1; i < stations.length; i++) {
    if (state.skippedStations.has(i)) continue;
    const st = stations[i];
    if (st == null || st.lat == null || st.lon == null) continue;

    const dist = haversineMeters(lat, lon, st.lat, st.lon);
    if (dist <= CONFIG.STATION_RADIUS) {
      state.currentStationIdx = i;
      state.lastStationTime = Date.now();

      updateStationDisplay();
      notifyStationArrival(i, st);

      console.log(`[Station] Reached: ${st.name || i} (${Math.round(dist)}m)`);

      // תחנה סופית — הצג שאלה, אל תסיים אוטומטית
      if (i === stations.length - 1 && !state.finalStationReached) {
        state.finalStationReached = true;
        showFinalStationPrompt();
      }
      break;
    }
  }
}

function showFinalStationPrompt() {
  document.getElementById('final-station-prompt').classList.remove('hidden');
  // אחרי 30 דקות — סיום אוטומטי
  state.autoEndTimerId = setTimeout(() => {
    endTrip('סיום אוטומטי — 30 דקות לאחר הגעה לתחנה הסופית');
  }, 30 * 60 * 1000);
}

function hideFinalStationPrompt() {
  document.getElementById('final-station-prompt').classList.add('hidden');
}

function nextNonSkippedIdx(fromIdx) {
  let i = fromIdx;
  while (i < state.stations.length && state.skippedStations.has(i)) i++;
  return i < state.stations.length ? i : -1;
}

function updateStationDisplay() {
  const { stations, currentStationIdx } = state;
  const current = stations[currentStationIdx];

  const nextIdx = nextNonSkippedIdx(currentStationIdx + 1);
  const next    = nextIdx >= 0 ? stations[nextIdx] : null;

  const name = (st) =>
    st == null ? null : (typeof st === 'string' ? st : st.name);

  dom.currentStation.textContent = name(current) ?? 'ממתין...';
  dom.nextStation.textContent    = name(next) ?? '\u2705 תחנה סופית';

  updateNextStationMarker();
}


/* ============================================================
   SEND LOCATION — INSERT row into location_logs (single pipeline)
   Supabase Database Webhook fires on every INSERT and notifies n8n.
   ============================================================ */
async function sendLocation() {
  if (!state.lastPosition || !state.tracking) return;

  if (isDemoMode()) {
    console.log('[DEMO] מיקום:', state.lastPosition);
    return;
  }

  const { lat, lon, timestamp } = state.lastPosition;

  const driverId = state.driverMap?.[state.driver] || null;
  const routeId  = state.routeMap?.[state.route]   || null;

  const [{ error: logErr }, { error: tripErr }] = await Promise.all([
    db.from('location_logs').insert({
      driver_id: driverId,
      route_id:  routeId,
      lat,
      lng:       lon,
      timestamp,
      status:    'active',
    }),
    state.tripId
      ? db.from('trips').update({ last_update: timestamp }).eq('id', state.tripId)
      : Promise.resolve({ error: null }),
  ]);

  if (logErr)  console.warn('[Supabase] location_logs insert failed:', logErr.message);
  if (tripErr) console.warn('[Supabase] trips update failed:', tripErr.message);
}


/* ============================================================
   EVENT LOG — כתיבה ישירה ל-Supabase
   ============================================================ */
async function logEvent(eventType, extra = {}) {
  if (isDemoMode()) return;
  try {
    await db.from('events_log').insert({
      trip_id:           state.tripId   || null,
      driver_id:         state.driverMap?.[state.driver] || null,
      route_id:          state.routeMap?.[state.route]   || null,
      event_type:        eventType,
      lat:               state.lastPosition?.lat || null,
      lon:               state.lastPosition?.lon || null,
      ...extra,
    });
  } catch (err) {
    console.warn('[events_log]', err.message);
  }
}


/* ============================================================
   STATION ARRIVAL — כתיבה ל-events_log
   n8n מקבל את האירוע דרך Supabase Database Webhook על location_logs.
   ============================================================ */
async function notifyStationArrival(stationIdx, station) {
  await logEvent('station_arrival', {
    station_name:      station.name,
    announcement_text: station.name,
  });
}


/* ============================================================
   MAP — Leaflet
   ============================================================ */
function initMap() {
  // אם המפה כבר קיימת — הסר אותה קודם
  if (state.map) {
    state.map.remove();
    state.map = null;
    state.driverMarker = null;
    state.nextStationMarker = null;
    state.routeLine = null;
    state.stationMarkers = [];
  }

  // מרכז ברירת מחדל — ישראל
  const defaultCenter = [31.5, 34.85];
  const defaultZoom  = 9;

  state.map = L.map('map', {
    center: defaultCenter,
    zoom: defaultZoom,
    zoomControl: true,
    attributionControl: false,
  });

  // שכבת מפה — OpenStreetMap בחינם
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
  }).addTo(state.map);

  // ציור כל התחנות על המפה
  drawStationsOnMap();
}

function drawStationsOnMap() {
  if (!state.map) return;
  const stations = state.stations;
  if (!stations.length) return;

  // סמן לכל תחנה שיש לה קואורדינטות
  const latlngs = [];
  stations.forEach((st, i) => {
    if (st.lat == null || st.lon == null) return;
    latlngs.push([st.lat, st.lon]);

    const isSkipped = state.skippedStations.has(i);
    const dot = L.circleMarker([st.lat, st.lon], {
      radius:      isSkipped ? 5 : 7,
      fillColor:   isSkipped ? '#6b7280' : '#2563eb',
      color:       '#fff',
      weight:      2,
      fillOpacity: isSkipped ? 0.4 : 0.9,
    }).addTo(state.map);

    dot.bindTooltip(st.name || `תחנה ${i + 1}`, {
      permanent: false,
      direction: 'top',
    });

    state.stationMarkers.push(dot);
  });

  // קו המסלול
  if (latlngs.length > 1) {
    state.routeLine = L.polyline(latlngs, {
      color: '#3b82f6',
      weight: 4,
      opacity: 0.7,
      dashArray: '8, 6',
    }).addTo(state.map);

    // מרכז המפה על המסלול
    state.map.fitBounds(state.routeLine.getBounds(), { padding: [50, 50] });
  }
}

function updateMapDriver(lat, lon) {
  if (!state.map) return;

  // אייקון כחול לנהג
  const driverIcon = L.divIcon({
    className: '',
    html: `<div style="
      width:22px;height:22px;
      background:#2563eb;
      border:3px solid #fff;
      border-radius:50%;
      box-shadow:0 2px 8px rgba(0,0,0,0.4);
    "></div>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });

  if (!state.driverMarker) {
    state.driverMarker = L.marker([lat, lon], { icon: driverIcon, zIndexOffset: 1000 })
      .addTo(state.map)
      .bindTooltip('הנהג', { permanent: false, direction: 'top' });
    // עקוב אחרי הנהג בפעם הראשונה
    state.map.setView([lat, lon], 15);
  } else {
    state.driverMarker.setLatLng([lat, lon]);
    // מרכז את המפה על הנהג בעדינות
    state.map.panTo([lat, lon], { animate: true, duration: 1 });
  }

  // עדכן סמן התחנה הבאה
  updateNextStationMarker();
}

function updateNextStationMarker() {
  if (!state.map) return;
  const nextIdx = nextNonSkippedIdx(state.currentStationIdx + 1);
  const next = nextIdx >= 0 ? state.stations[nextIdx] : null;

  // הסר סמן קודם
  if (state.nextStationMarker) {
    state.map.removeLayer(state.nextStationMarker);
    state.nextStationMarker = null;
  }

  if (!next || next.lat == null || next.lon == null) return;

  // אייקון ירוק לתחנה הבאה
  const nextIcon = L.divIcon({
    className: '',
    html: `<div style="
      width:28px;height:28px;
      background:#16a34a;
      border:3px solid #fff;
      border-radius:50%;
      box-shadow:0 2px 10px rgba(0,0,0,0.5);
      display:flex;align-items:center;justify-content:center;
      font-size:14px;color:#fff;font-weight:bold;
    ">&#9193;</div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });

  state.nextStationMarker = L.marker([next.lat, next.lon], { icon: nextIcon, zIndexOffset: 900 })
    .addTo(state.map)
    .bindTooltip(`הבאה: ${next.name || ''}`, { permanent: true, direction: 'top', offset: [0, -10] });
}

/* ============================================================
   END TRIP
   ============================================================ */
/**
 * Cleans up all resources: GPS watch, timers, wake locks.
 * Safe to call multiple times (guarded by state.tracking flag).
 */
function endTrip(reason = 'הנסיעה הסתיימה') {
  if (!state.tracking) return;
  state.tracking = false;

  console.log('[endTrip]', reason);

  // Stop GPS
  if (state.watchId !== null) {
    navigator.geolocation.clearWatch(state.watchId);
    state.watchId = null;
  }

  // Clear all timers
  clearInterval(state.sendIntervalId);
  clearInterval(state.countdownId);
  clearInterval(state.safetyCheckId);
  clearTimeout(state.autoEndTimerId);
  state.sendIntervalId  = null;
  state.countdownId     = null;
  state.safetyCheckId   = null;
  state.autoEndTimerId  = null;
  hideFinalStationPrompt();

  // Release wake persistence
  WakePersistence.disable();

  // ניקוי המפה
  if (state.map) {
    state.map.remove();
    state.map = null;
    state.driverMarker = null;
    state.nextStationMarker = null;
    state.routeLine = null;
    state.stationMarkers = [];
  }

  // סגירת נסיעה ב-Supabase
  if (state.tripId && !isDemoMode()) {
    logEvent('trip_end');
    db.from('trips')
      .update({ status: 'completed', last_update: new Date().toISOString() })
      .eq('id', state.tripId)
      .then(({ error }) => { if (error) console.warn('[Supabase] Trip close failed:', error.message); });
    state.tripId = null;
  }

  dom.endReason.textContent = reason;
  showScreen('ended');
}


/* ============================================================
   WAKE PERSISTENCE — Background Keep-Alive
   ============================================================
   Mobile browsers suspend background tabs/PWAs to save battery.
   When the driver switches to Waze, this app moves to the
   background. We use THREE complementary strategies to prevent
   the browser from throttling or killing our GPS tracking:

   1. SCREEN WAKE LOCK API (Chrome 84+, Edge 84+, Firefox 126+)
      navigator.wakeLock.request('screen') prevents the screen
      from dimming and keeps the CPU active. Must be re-acquired
      after visibility changes (e.g. incoming call).

   2. SILENT AUDIO CONTEXT (iOS Safari, older Chrome)
      An AudioContext with a looping silent buffer creates an
      active "audio session". Browsers treat pages with active
      audio sessions as foreground media players, significantly
      reducing throttling of timers and GPS callbacks.

   3. CANVAS MEDIA STREAM → <video> (iOS Safari fallback)
      Playing a MediaStream in a <video> element signals active
      media playback. We feed it a 1×1 canvas drawn at 1 fps —
      near-zero battery cost, but enough to maintain the signal.
      Browsers hesitate to suspend pages with active media.

   All three are activated simultaneously for maximum coverage.
   On OS-forced release of the Wake Lock (battery saver mode,
   incoming call), it is automatically re-acquired when the tab
   regains visibility while tracking is still active.
   ============================================================ */
const WakePersistence = {

  async enable() {
    await Promise.allSettled([
      this._acquireWakeLock(),
      this._startSilentAudio(),
    ]);
    this._startCanvasVideo();

    // Re-acquire wake lock on tab visibility restore
    document.addEventListener('visibilitychange', this._onVisibilityChange);
  },

  disable() {
    // Release Screen Wake Lock
    if (state.wakeLock) {
      state.wakeLock.release().catch(() => {});
      state.wakeLock = null;
    }

    // Stop silent audio
    if (state.audioSource) {
      try { state.audioSource.stop(); } catch { /* already stopped */ }
      state.audioSource = null;
    }
    if (state.audioCtx) {
      state.audioCtx.close().catch(() => {});
      state.audioCtx = null;
    }

    // Stop canvas video stream
    if (state.videoStream) {
      state.videoStream.getTracks().forEach((t) => t.stop());
      state.videoStream = null;
    }
    dom.nosleepVideo.srcObject = null;

    document.removeEventListener('visibilitychange', this._onVisibilityChange);

    dom.wakeIcon.textContent    = '\u{1F513}';
    dom.wakeStatus.textContent  = 'Wake Lock: לא פעיל';
  },

  // --- Strategy 1: Screen Wake Lock API ---
  async _acquireWakeLock() {
    if (!('wakeLock' in navigator)) return;
    try {
      state.wakeLock = await navigator.wakeLock.request('screen');
      state.wakeLock.addEventListener('release', () => {
        console.log('[WakeLock] Released by OS');
        dom.wakeStatus.textContent = 'Wake Lock: שוחרר ע"י המערכת';
      });
      dom.wakeIcon.textContent   = '\u{1F512}';
      dom.wakeStatus.textContent = 'Wake Lock: פעיל';
      console.log('[WakeLock] Acquired');
    } catch (err) {
      console.warn('[WakeLock] Failed:', err.message);
      dom.wakeStatus.textContent = 'Wake Lock: לא זמין';
    }
  },

  // --- Strategy 2: Silent AudioContext ---
  _startSilentAudio() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;

      state.audioCtx = new AudioCtx();

      // Create a 1-second buffer of silence (all zero samples)
      const sampleRate = state.audioCtx.sampleRate;
      const buffer     = state.audioCtx.createBuffer(1, sampleRate, sampleRate);
      // The buffer is already all zeros — no need to fill it

      const source  = state.audioCtx.createBufferSource();
      source.buffer = buffer;
      source.loop   = true;
      // Connect to destination so the audio session is active,
      // but the GainNode keeps volume at 0
      const gain    = state.audioCtx.createGain();
      gain.gain.value = 0;
      source.connect(gain);
      gain.connect(state.audioCtx.destination);
      source.start(0);
      state.audioSource = source;
      console.log('[WakeLock] Silent AudioContext started');
    } catch (err) {
      console.warn('[WakeLock] AudioContext failed:', err.message);
    }
  },

  // --- Strategy 3: Canvas → MediaStream → <video> ---
  _startCanvasVideo() {
    try {
      if (typeof document.createElement('canvas').captureStream !== 'function') return;

      const canvas = document.createElement('canvas');
      canvas.width  = 1;
      canvas.height = 1;
      const ctx = canvas.getContext('2d');
      let bit = 0;

      // We must draw alternating frames — a truly static canvas stream
      // may be optimised away by the browser, losing the "media active" signal.
      const draw = () => {
        if (!state.tracking && state.videoStream == null) return;
        ctx.fillStyle = bit ? '#000001' : '#000002';
        ctx.fillRect(0, 0, 1, 1);
        bit ^= 1;
        setTimeout(draw, 800); // ~1.25 fps — negligible CPU
      };
      draw();

      const stream = canvas.captureStream(1);
      state.videoStream = stream;
      dom.nosleepVideo.srcObject = stream;
      dom.nosleepVideo.play().catch(() => {});
      console.log('[WakeLock] Canvas video stream started');
    } catch (err) {
      console.warn('[WakeLock] Canvas stream failed:', err.message);
    }
  },

  // Bound as an event listener — re-acquires wake lock when tab regains focus
  _onVisibilityChange() {
    if (document.visibilityState === 'visible' && state.tracking) {
      if (!state.wakeLock || state.wakeLock.released) {
        console.log('[WakeLock] Re-acquiring after visibility restore');
        WakePersistence._acquireWakeLock();
      }
    }
  },
};


/* ============================================================
   EVENT LISTENERS
   ============================================================ */
function bindEvents() {
  // DRIVER screen
  // בחירה מהרשימה הקיימת
  const checkDriverInputs = () => {
    const u = dom.driverUsername.value.trim();
    const p = dom.driverPassword.value;
    dom.btnDriverNext.disabled = !(u && p);
  };
  dom.driverUsername.addEventListener('input', checkDriverInputs);
  dom.driverPassword.addEventListener('input', checkDriverInputs);
  dom.driverPassword.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !dom.btnDriverNext.disabled) dom.btnDriverNext.click();
  });

  dom.btnDriverNext.addEventListener('click', async () => {
    const username = dom.driverUsername.value.trim();
    const password = dom.driverPassword.value;
    dom.driverLoginError.textContent = '';
    dom.btnDriverNext.disabled = true;
    dom.btnDriverNext.textContent = 'מתחבר...';

    const ok = await validateDriverLogin(username, password);

    dom.btnDriverNext.disabled = false;
    dom.btnDriverNext.textContent = 'כניסה ←';

    if (!ok) {
      dom.driverLoginError.textContent = 'שם משתמש או סיסמה שגויים';
      return;
    }
    dom.routeDriverLabel.textContent = `נהג: ${state.driver} — שלב 2 מתוך 3`;
    populateRouteSelect();
    showScreen('route');
  });

  // ROUTE screen
  dom.routeSelect.addEventListener('change', (e) => {
    state.route = e.target.value || null;
    dom.btnRouteNext.disabled = !state.route;
  });

  dom.btnRouteBack.addEventListener('click', () => showScreen('driver'));

  dom.btnRouteNext.addEventListener('click', () => {
    if (!state.route) return;
    renderStationsList();
    showScreen('stations');
  });

  // STATIONS screen
  dom.btnStationsBack.addEventListener('click', () => showScreen('route'));

  // Station skip toggle — event delegation on the list container
  dom.stationsList.addEventListener('click', (e) => {
    const btn = e.target.closest('.btn-skip-station');
    if (!btn) return;
    const idx = parseInt(btn.dataset.index, 10);
    const item = dom.stationsList.querySelector(`.station-item[data-index="${idx}"]`);
    if (state.skippedStations.has(idx)) {
      state.skippedStations.delete(idx);
      item?.classList.remove('skipped');
      btn.textContent = 'דלג';
    } else {
      state.skippedStations.add(idx);
      item?.classList.add('skipped');
      btn.textContent = 'בטל דילוג';
    }
  });

  dom.btnStartTrip.addEventListener('click', startTrip);

  // TRACKING screen
  dom.btnEndTrip.addEventListener('click', () => endTrip('סיום נסיעה ידני על ידי הנהג'));

  // תחנה סופית
  document.getElementById('btn-confirm-end').addEventListener('click', () => endTrip('הגעת לתחנה הסופית — הנסיעה הסתיימה'));
  document.getElementById('btn-continue-trip').addEventListener('click', () => hideFinalStationPrompt());

  // ENDED screen — reset for a new trip
  dom.btnRestart.addEventListener('click', resetForNewTrip);
}

function resetForNewTrip() {
  state.driver           = null;
  state.route            = null;
  state.stations         = [];
  state.currentStationIdx = -1;
  state.lastPosition     = null;

  state.tripId               = null;
  state.finalStationReached  = false;
  state.autoEndTimerId       = null;
  state.skippedStations.clear();
  dom.driverUsername.value   = '';
  dom.driverPassword.value   = '';
  dom.routeSelect.value      = '';
  dom.btnDriverNext.disabled = true;
  dom.btnRouteNext.disabled  = true;
  dom.gpsStatus.textContent  = 'ממתין ל-GPS...';
  dom.nextSendLabel.textContent = 'שולח בעוד: --';
  dom.wakeStatus.textContent = 'Wake Lock: ממתין...';

  showScreen('driver');
}


/* ============================================================
   UTILITY — Haversine Distance
   ============================================================ */
/**
 * Returns the great-circle distance in metres between two
 * WGS-84 coordinates using the Haversine formula.
 */
function haversineMeters(lat1, lon1, lat2, lon2) {
  const R  = 6_371_000; // Earth's mean radius in metres
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(Δφ / 2) ** 2 +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;

  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}


/* ============================================================
   UTILITY — Error Toast
   ============================================================ */
let toastTimer = null;

function showToast(message, durationMs = 5000) {
  dom.errorToast.textContent = message;
  dom.errorToast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    dom.errorToast.classList.remove('visible');
  }, durationMs);
}
