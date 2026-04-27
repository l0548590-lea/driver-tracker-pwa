'use strict';

/* ============================================================
   CONFIGURATION — edit these values before deployment
   ============================================================ */
const CONFIG = {
  /**
   * GET endpoint that returns driver names and routes.
   * Expected response shape:
   * {
   *   "drivers": ["ישראל ישראלי", "אבי כהן"],
   *   "routes": {
   *     "מסלול צפון": [
   *       { "name": "תחנה א", "lat": 32.0853, "lon": 34.7818 },
   *       { "name": "תחנה ב", "lat": 32.1000, "lon": 34.8000 }
   *     ]
   *   }
   * }
   * NOTE: lat/lon are optional. If omitted, station auto-detection
   *       is disabled and stations must be confirmed manually.
   */
  API_URL: 'https://YOUR_N8N_INSTANCE/webhook/get-data',

  /**
   * POST endpoint that receives location pings.
   * The response may optionally contain { "terminate": true }
   * to instruct the app to end the trip automatically.
   */
  WEBHOOK_URL: 'https://YOUR_N8N_INSTANCE/webhook/track',

  /** Sent as the x-api-key header on every request */
  API_KEY: 'YOUR_SECRET_API_KEY',

  /** How often to POST location data to the webhook (ms) */
  SEND_INTERVAL: 30_000,

  /** Radius in meters within which a driver is considered "at" a station */
  STATION_RADIUS: 150,

  /**
   * Safety auto-shutdown: if no new station has been detected for this
   * many milliseconds, the trip ends automatically.
   */
  SAFETY_TIMEOUT: 45 * 60 * 1000, // 45 minutes
};


/* ============================================================
   APPLICATION STATE
   ============================================================ */
const state = {
  // Data fetched from the API
  drivers: [],
  routes: {},

  // Current trip selections
  driver: null,
  route: null,
  stations: [],

  // Station tracking
  currentStationIdx: -1,  // index of the last station passed; -1 = none yet
  lastStationTime: null,  // Date.now() when the last station was detected

  // GPS
  watchId: null,
  lastPosition: null,     // { lat, lon, timestamp }

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
  driverSelect:    $('driver-select'),
  btnDriverNext:   $('btn-driver-next'),

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

  // Driver manual add
  driverManualInput: $('driver-manual-input'),
  btnAddDriver:      $('btn-add-driver'),

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
  return CONFIG.API_URL.includes('YOUR_N8N_INSTANCE');
}

async function loadData() {
  showScreen('loading');

  /* מצב הדגמה — כשה-URL עדיין לא הוגדר */
  if (isDemoMode()) {
    await new Promise((r) => setTimeout(r, 800)); // השהייה קצרה לאפקט טעינה
    state.drivers = DEMO_DATA.drivers;
    state.routes  = DEMO_DATA.routes;
    populateDriverSelect();
    showScreen('driver');
    showToast('מצב הדגמה — נתונים מדומים (ה-API לא הוגדר עדיין)', 4000);
    return;
  }

  try {
    const res = await fetch(CONFIG.API_URL, {
      method: 'GET',
      headers: { 'x-api-key': CONFIG.API_KEY },
    });

    if (!res.ok) throw new Error(`שגיאת שרת: HTTP ${res.status}`);

    const data = await res.json();

    state.drivers = Array.isArray(data.drivers) ? data.drivers : [];
    state.routes  = (data.routes && typeof data.routes === 'object') ? data.routes : {};

    if (state.drivers.length === 0) {
      throw new Error('לא נמצאו נהגים בתגובת ה-API');
    }

    populateDriverSelect();
    showScreen('driver');
  } catch (err) {
    console.error('[loadData]', err);
    showToast(`שגיאה בטעינה: ${err.message}`);
    setTimeout(() => {
      showScreen('loading');
      setTimeout(loadData, 1000);
    }, 4000);
  }
}


/* ============================================================
   STEP 1 — DRIVER SELECTION
   ============================================================ */
function populateDriverSelect() {
  dom.driverSelect.innerHTML = '<option value="">— בחר נהג —</option>';
  state.drivers.forEach((name) => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    dom.driverSelect.appendChild(opt);
  });
  dom.btnDriverNext.disabled = true;
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
    item.innerHTML = `
      <div class="station-num">${i + 1}</div>
      <div class="station-item-name">${name}</div>
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
  state.lastPosition = null;
  state.sendCountdown = CONFIG.SEND_INTERVAL / 1000;

  // Update tracking screen meta labels
  dom.trackDriverLabel.textContent = state.driver;
  dom.trackRouteLabel.textContent  = state.route;

  // Show first "next station" immediately
  const firstStation = state.stations[0];
  dom.currentStation.textContent = 'ממתין למיקום...';
  dom.nextStation.textContent    = firstStation
    ? (typeof firstStation === 'string' ? firstStation : firstStation.name)
    : '--';

  showScreen('tracking');

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
    const elapsed = Date.now() - state.lastStationTime;
    if (elapsed > CONFIG.SAFETY_TIMEOUT) {
      endTrip('פסק הזמן פג — לא זוהתה תחנה חדשה במשך 45 דקות');
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

  dom.gpsStatus.textContent = `GPS פעיל \u00B1${Math.round(accuracy)}\u05DE`;

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
    const st = stations[i];
    if (st == null || st.lat == null || st.lon == null) continue;

    const dist = haversineMeters(lat, lon, st.lat, st.lon);
    if (dist <= CONFIG.STATION_RADIUS) {
      state.currentStationIdx = i;
      state.lastStationTime = Date.now(); // Reset safety timer

      updateStationDisplay();

      console.log(`[Station] Reached: ${st.name || i} (${Math.round(dist)}m)`);

      // Auto-end on final station
      if (i === stations.length - 1) {
        setTimeout(() => endTrip('הגעת לתחנה הסופית — הנסיעה הסתיימה'), 2000);
      }
      break;
    }
  }
}

function updateStationDisplay() {
  const { stations, currentStationIdx } = state;
  const current = stations[currentStationIdx];
  const next    = stations[currentStationIdx + 1];

  const name = (st) =>
    st == null ? null : (typeof st === 'string' ? st : st.name);

  dom.currentStation.textContent = name(current) ?? 'ממתין...';
  dom.nextStation.textContent    = name(next) ?? '\u2705 תחנה סופית';
}


/* ============================================================
   SEND LOCATION WEBHOOK
   ============================================================ */
async function sendLocation() {
  if (!state.lastPosition || !state.tracking) return;

  /* במצב הדגמה — לא שולחים לשרת, רק מדפיסים לקונסול */
  if (isDemoMode()) {
    console.log('[DEMO] מיקום (לא נשלח לשרת):', state.lastPosition);
    return;
  }

  const { lat, lon, timestamp } = state.lastPosition;
  const currentStationObj = state.stations[state.currentStationIdx];
  const stationName = currentStationObj
    ? (typeof currentStationObj === 'string' ? currentStationObj : currentStationObj.name)
    : null;

  const payload = {
    driver:       state.driver,
    route:        state.route,
    lat,
    lon,
    timestamp,
    station:      stationName,
    stationIndex: state.currentStationIdx,
  };

  try {
    const res = await fetch(CONFIG.WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key':    CONFIG.API_KEY,
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      console.warn(`[Webhook] HTTP ${res.status}`);
      return;
    }

    // Check if the backend wants to terminate the trip
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      let data;
      try { data = await res.json(); } catch { return; }

      if (data && (data.terminate === true || data.command === 'terminate')) {
        const reason = data.reason || 'הנסיעה הסתיימה לפי הוראת השרת';
        endTrip(reason);
      }
    }
  } catch (err) {
    // Network errors are common on mobile — log and continue
    console.warn('[Webhook] Send failed:', err.message);
  }
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
  state.sendIntervalId = null;
  state.countdownId    = null;
  state.safetyCheckId  = null;

  // Release wake persistence
  WakePersistence.disable();

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
  dom.driverSelect.addEventListener('change', (e) => {
    state.driver = e.target.value || null;
    dom.driverManualInput.value = ''; // נקה את שדה ההקלדה
    dom.btnDriverNext.disabled = !state.driver;
  });

  // הקלדת נהג חדש — מפעיל/מכבה את כפתור "הוסף"
  dom.driverManualInput.addEventListener('input', (e) => {
    const val = e.target.value.trim();
    dom.btnAddDriver.disabled = val.length === 0;
    // אם מקלידים — מנקים את הבחירה מהרשימה
    if (val) {
      dom.driverSelect.value = '';
      state.driver = null;
      dom.btnDriverNext.disabled = true;
    }
  });

  // לחיצה על "הוסף" — מוסיף את הנהג לרשימה ובוחר אותו
  dom.btnAddDriver.addEventListener('click', () => {
    const name = dom.driverManualInput.value.trim();
    if (!name) return;

    // הוסף לרשימה המקומית אם לא קיים
    if (!state.drivers.includes(name)) {
      state.drivers.unshift(name); // הוסף בתחילת הרשימה
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      dom.driverSelect.insertBefore(opt, dom.driverSelect.options[1]);
    }

    // בחר אותו אוטומטית
    dom.driverSelect.value = name;
    state.driver = name;
    dom.driverManualInput.value = '';
    dom.btnAddDriver.disabled = true;
    dom.btnDriverNext.disabled = false;
  });

  // Enter בשדה ההקלדה = לחיצה על הוסף
  dom.driverManualInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !dom.btnAddDriver.disabled) {
      dom.btnAddDriver.click();
    }
  });

  dom.btnDriverNext.addEventListener('click', () => {
    if (!state.driver) return;
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

  dom.btnStartTrip.addEventListener('click', startTrip);

  // TRACKING screen
  dom.btnEndTrip.addEventListener('click', () => endTrip('סיום נסיעה ידני על ידי הנהג'));

  // ENDED screen — reset for a new trip
  dom.btnRestart.addEventListener('click', resetForNewTrip);
}

function resetForNewTrip() {
  state.driver           = null;
  state.route            = null;
  state.stations         = [];
  state.currentStationIdx = -1;
  state.lastPosition     = null;

  dom.driverSelect.value     = '';
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
