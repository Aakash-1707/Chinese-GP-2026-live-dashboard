"""
Chinese GP 2026 – Live Race Dashboard
Strategy:
  1. Parallel REST requests (ThreadPoolExecutor) for instant initial load (~2s)
  2. MQTT subscription for real-time push updates (~50ms latency)
  3. REST used as fallback if MQTT drops

pip install PySide6 requests paho-mqtt
"""

import os, sys, ssl, json, time, requests
from datetime import datetime
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed

import paho.mqtt.client as mqtt

from PySide6.QtWidgets import (
    QApplication, QMainWindow, QWidget, QVBoxLayout, QHBoxLayout,
    QLabel, QTableWidget, QTableWidgetItem, QHeaderView, QFrame,
    QSplitter, QGroupBox, QPushButton
)
from PySide6.QtCore import Qt, QTimer, QThread, Signal, QObject
from PySide6.QtGui import QColor, QFont, QBrush

# ── Config ────────────────────────────────────────────────────────────────────
BASE_URL    = "https://api.openf1.org/v1"
TOKEN_URL   = "https://api.openf1.org/token"
MQTT_HOST   = "mqtt.openf1.org"
MQTT_PORT   = 8883
OPENF1_USER = os.environ.get("OPENF1_USER", "aakashsbaskar@gmail.com")
OPENF1_PASS = os.environ.get("OPENF1_PASS", "nLcyUrs4UD9ZlNiP")

# ── Style ─────────────────────────────────────────────────────────────────────
TEAM_COLOURS = {
    "Red Bull Racing": "#3671C6", "Ferrari": "#E8002D",
    "Mercedes": "#27F4D2",        "McLaren": "#FF8000",
    "Aston Martin": "#229971",    "Alpine": "#FF87BC",
    "Williams": "#64C4FF",        "Haas F1 Team": "#B6BABD",
    "Kick Sauber": "#52E252",     "Racing Bulls": "#6692FF",
}
TYRE_COLOURS = {
    "SOFT": "#E8002D", "MEDIUM": "#FFF200", "HARD": "#CCCCCC",
    "INTER": "#39B54A", "WET": "#0067FF", "UNKNOWN": "#888888",
}
DRS_MAP   = {0:"OFF",1:"OFF",8:"ELIGIBLE",10:"ON",12:"ON",14:"ON"}
DARK_BG   = "#0f0f0f"; PANEL_BG = "#1a1a1a"; BORDER = "#2e2e2e"
TEXT_MAIN = "#f0f0f0"; TEXT_DIM = "#888888";  ACCENT = "#e10600"

# ── OAuth2 Token Manager ──────────────────────────────────────────────────────
class TokenManager:
    def __init__(self):
        self._token = None; self._expires_at = 0

    def get(self):
        if self._token and time.time() < self._expires_at - 60:
            return self._token
        return self._refresh()

    def _refresh(self):
        print("Fetching OpenF1 OAuth2 token…")
        try:
            r = requests.post(TOKEN_URL,
                headers={"Content-Type": "application/x-www-form-urlencoded"},
                data={"username": OPENF1_USER, "password": OPENF1_PASS},
                timeout=10)
            r.raise_for_status()
            d = r.json()
            self._token = d["access_token"]
            self._expires_at = time.time() + int(d.get("expires_in", 3600))
            print(f"  ✓ Token OK (expires in {d.get('expires_in')}s)")
            return self._token
        except Exception as e:
            print(f"  ✗ Token failed: {e}"); return None

TOKEN = TokenManager()

# ── REST helper ───────────────────────────────────────────────────────────────
def api_get(ep, params=None):
    tok = TOKEN.get()
    hdrs = {"Authorization": f"Bearer {tok}", "accept": "application/json"} if tok else {}
    try:
        r = requests.get(f"{BASE_URL}/{ep}", params=params, headers=hdrs, timeout=12)
        r.raise_for_status()
        return r.json()
    except requests.HTTPError as e:
        if e.response.status_code == 401: TOKEN._expires_at = 0
        print(f"[REST] {ep}: {e}"); return []
    except Exception as e:
        print(f"[REST] {ep}: {e}"); return []

def fmt_lap(s):
    if s is None: return "–"
    try:
        s = float(s); m = int(s // 60); return f"{m}:{s%60:06.3f}"
    except: return "–"

# ── Live State (shared between MQTT thread and UI) ────────────────────────────
class LiveState:
    """Thread-safe store for all session data, merged from REST + MQTT."""
    def __init__(self):
        self.drivers   = {}           # dn -> driver metadata
        self.positions = {}           # dn -> latest position record
        self.best_laps = {}           # dn -> best lap record
        self.lap_counts= defaultdict(int)
        self.stints    = defaultdict(list)
        self.pits      = defaultdict(list)
        self.telemetry = {}           # dn -> latest car_data record
        self._lap_seen = set()        # deduplicate lap records by (dn, lap_number)

    def snapshot(self):
        """Return a plain-dict copy safe to pass across threads."""
        return {
            "drivers":    dict(self.drivers),
            "positions":  dict(self.positions),
            "best_laps":  dict(self.best_laps),
            "lap_counts": dict(self.lap_counts),
            "stints":     dict(self.stints),
            "pits":       dict(self.pits),
            "telemetry":  dict(self.telemetry),
        }

    # ── REST bulk load (called once at startup in parallel) ──────────────────
    def bulk_load(self, sk):
        print("Parallel REST bulk load…")
        t0 = time.time()

        endpoints = {
            "position": {"session_key": sk},
            "laps":     {"session_key": sk},
            "stints":   {"session_key": sk},
            "pit":      {"session_key": sk},
            "drivers":  {"session_key": sk},
        }

        results = {}
        with ThreadPoolExecutor(max_workers=5) as pool:
            futs = {pool.submit(api_get, ep, p): ep for ep, p in endpoints.items()}
            for f in as_completed(futs):
                ep = futs[f]
                results[ep] = f.result()

        # drivers
        for d in results.get("drivers", []):
            self.drivers[d["driver_number"]] = d

        # positions
        for x in results.get("position", []):
            dn = x["driver_number"]
            if dn not in self.positions or x["date"] > self.positions[dn]["date"]:
                self.positions[dn] = x

        # laps
        for lap in results.get("laps", []):
            self._ingest_lap(lap)

        # stints
        for s in results.get("stints", []):
            dn = s["driver_number"]
            if s not in self.stints[dn]:
                self.stints[dn].append(s)

        # pits
        for p in results.get("pit", []):
            dn = p["driver_number"]
            if p not in self.pits[dn]:
                self.pits[dn].append(p)

        print(f"  ✓ Bulk load done in {time.time()-t0:.2f}s  "
              f"({len(self.positions)} drivers, {sum(self.lap_counts.values())} laps)")

    def _ingest_lap(self, lap):
        dn  = lap.get("driver_number")
        dur = lap.get("lap_duration")
        key = (dn, lap.get("lap_number"))
        if key not in self._lap_seen:
            self._lap_seen.add(key)
            self.lap_counts[dn] += 1
        if dur and (dn not in self.best_laps or dur < self.best_laps[dn]["lap_duration"]):
            self.best_laps[dn] = lap

    def ingest_mqtt(self, topic, msg):
        """Merge a single MQTT message into live state."""
        dn = msg.get("driver_number")
        if topic == "v1/position" and dn:
            if dn not in self.positions or msg["date"] > self.positions[dn]["date"]:
                self.positions[dn] = msg
        elif topic == "v1/laps" and dn:
            self._ingest_lap(msg)
        elif topic == "v1/car_data" and dn:
            if dn not in self.telemetry or msg.get("date","") >= self.telemetry[dn].get("date",""):
                self.telemetry[dn] = msg
        elif topic == "v1/stints" and dn:
            existing = self.stints[dn]
            sn = msg.get("stint_number")
            # update or append
            for i, s in enumerate(existing):
                if s.get("stint_number") == sn:
                    existing[i] = msg; return
            existing.append(msg)
        elif topic == "v1/pit" and dn:
            if msg not in self.pits[dn]:
                self.pits[dn].append(msg)


# ── MQTT + Data Worker ────────────────────────────────────────────────────────
class DataWorker(QObject):
    data_ready  = Signal(dict)
    status_msg  = Signal(str)

    TOPICS = ["v1/position", "v1/laps", "v1/car_data", "v1/stints", "v1/pit"]

    def __init__(self, session_key):
        super().__init__()
        self.sk    = session_key
        self.state = LiveState()
        self._mqtt = None
        self._mqtt_connected = False

    # called from QThread
    def start(self):
        # Step 1: parallel REST bulk load
        self.status_msg.emit("Loading session data…")
        self.state.bulk_load(self.sk)
        self.data_ready.emit(self.state.snapshot())

        # Step 2: connect MQTT for real-time push
        self.status_msg.emit("Connecting MQTT…")
        self._connect_mqtt()

    def _connect_mqtt(self):
        tok = TOKEN.get()
        if not tok:
            self.status_msg.emit("⚠ No token — falling back to REST polling")
            self._start_rest_fallback()
            return

        client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
        client.username_pw_set(username=OPENF1_USER, password=tok)
        client.tls_set(cert_reqs=ssl.CERT_REQUIRED, tls_version=ssl.PROTOCOL_TLS_CLIENT)
        client.on_connect    = self._on_mqtt_connect
        client.on_message    = self._on_mqtt_message
        client.on_disconnect = self._on_mqtt_disconnect

        try:
            client.connect(MQTT_HOST, MQTT_PORT, keepalive=60)
            self._mqtt = client
            client.loop_start()   # non-blocking background thread
            print("  ✓ MQTT loop started")
        except Exception as e:
            print(f"  ✗ MQTT connect failed: {e}")
            self.status_msg.emit("⚠ MQTT failed — REST polling every 10s")
            self._start_rest_fallback()

    def _on_mqtt_connect(self, client, userdata, flags, rc, props=None):
        if rc == 0:
            self._mqtt_connected = True
            self.status_msg.emit("🟢 MQTT Live")
            print("MQTT connected — subscribing to topics…")
            for t in self.TOPICS:
                client.subscribe(t)
                print(f"  ✓ subscribed: {t}")
        else:
            print(f"MQTT connect error rc={rc}")
            self.status_msg.emit(f"⚠ MQTT rc={rc}")

    def _on_mqtt_message(self, client, userdata, msg):
        try:
            data = json.loads(msg.payload.decode())
            # filter to this session only
            if data.get("session_key") != self.sk:
                return
            self.state.ingest_mqtt(msg.topic, data)
            self.data_ready.emit(self.state.snapshot())
            self.status_msg.emit(f"🟢 MQTT  {datetime.now().strftime('%H:%M:%S.%f')[:-3]}")
        except Exception as e:
            print(f"[MQTT msg] {e}")

    def _on_mqtt_disconnect(self, client, userdata, flags, rc, props=None):
        self._mqtt_connected = False
        self.status_msg.emit("🔴 MQTT disconnected — reconnecting…")
        print(f"MQTT disconnected rc={rc}, will auto-reconnect")

    # REST fallback (if MQTT unavailable)
    def _start_rest_fallback(self):
        self._rest_timer = QTimer()
        self._rest_timer.timeout.connect(self._rest_poll)
        self._rest_timer.start(10_000)

    def _rest_poll(self):
        self.status_msg.emit("Polling REST…")
        # Only fetch what might have changed
        with ThreadPoolExecutor(max_workers=3) as pool:
            futs = {
                pool.submit(api_get, "position", {"session_key": self.sk}): "position",
                pool.submit(api_get, "laps",     {"session_key": self.sk}): "laps",
                pool.submit(api_get, "car_data", {"session_key": self.sk,
                    "date>": self._latest_tele_date()}): "car_data",
            }
            for f in as_completed(futs):
                ep = futs[f]; rows = f.result()
                for row in rows:
                    self.state.ingest_mqtt(f"v1/{ep}", row)
        self.data_ready.emit(self.state.snapshot())
        self.status_msg.emit(f"🟡 REST  {datetime.now().strftime('%H:%M:%S')}")

    def _latest_tele_date(self):
        dates = [v.get("date","") for v in self.state.telemetry.values() if v.get("date")]
        return max(dates) if dates else "2026-01-01T00:00:00"

    def stop(self):
        if self._mqtt:
            self._mqtt.loop_stop()
            self._mqtt.disconnect()


# ── Table helpers ─────────────────────────────────────────────────────────────
def make_table(headers):
    t = QTableWidget(0, len(headers))
    t.setHorizontalHeaderLabels(headers)
    t.setEditTriggers(QTableWidget.NoEditTriggers)
    t.setSelectionBehavior(QTableWidget.SelectRows)
    t.verticalHeader().setVisible(False)
    t.horizontalHeader().setStretchLastSection(True)
    t.horizontalHeader().setSectionResizeMode(QHeaderView.ResizeToContents)
    t.setShowGrid(False)
    t.setStyleSheet(f"""
        QTableWidget {{ background:{PANEL_BG}; color:{TEXT_MAIN}; border:none;
                        font-family:Monospace; font-size:11px; }}
        QHeaderView::section {{ background:#111; color:{TEXT_DIM}; border:none;
                                padding:4px 8px; font-size:10px; font-weight:bold; letter-spacing:1px; }}
        QTableWidget::item {{ padding:3px 8px; border-bottom:1px solid {BORDER}; }}
        QTableWidget::item:selected {{ background:#2a2a2a; }}
    """)
    return t

def cell(tbl, row, col, text, fg=TEXT_MAIN, bold=False, align=Qt.AlignLeft):
    it = QTableWidgetItem(str(text))
    it.setForeground(QBrush(QColor(fg)))
    it.setTextAlignment(align | Qt.AlignVCenter)
    f = QFont("Monospace", 11); f.setBold(bold); it.setFont(f)
    tbl.setItem(row, col, it)

def wrap_panel(title, widget):
    box = QGroupBox(title)
    box.setStyleSheet(f"""
        QGroupBox {{ color:{TEXT_DIM}; border:1px solid {BORDER}; border-radius:4px;
                     margin-top:12px; font-family:Monospace; font-size:10px;
                     font-weight:bold; letter-spacing:2px; }}
        QGroupBox::title {{ subcontrol-origin:margin; left:10px; padding:0 4px; }}
    """)
    lay = QVBoxLayout(box); lay.setContentsMargins(0,8,0,0); lay.addWidget(widget)
    return box


# ══════════════════════════════════════════════════════════════════════════════
class LiveDashboard(QMainWindow):
    def __init__(self, session_key, label="2026 Chinese GP – FP1"):
        super().__init__()
        self.sk = session_key; self._dm = {}
        self.setWindowTitle(f"🏎  {label}  |  Live Dashboard")
        self.resize(1440, 880)
        self.setStyleSheet(f"""
            QMainWindow,QWidget {{ background:{DARK_BG}; }}
            QScrollBar:vertical {{ background:{PANEL_BG}; width:6px; }}
            QScrollBar::handle:vertical {{ background:#444; border-radius:3px; }}
            QPushButton {{ background:#1e1e1e; color:{TEXT_MAIN}; border:1px solid {BORDER};
                           border-radius:3px; padding:4px 12px; font-family:Monospace; font-size:11px; }}
            QPushButton:hover {{ background:#2a2a2a; }}
        """)
        self._build_ui()
        self._start_worker()

    def _build_ui(self):
        root = QWidget(); self.setCentralWidget(root)
        lay  = QVBoxLayout(root); lay.setContentsMargins(12,8,12,8); lay.setSpacing(6)

        hdr = QHBoxLayout()
        self._title  = QLabel("🏎  2026 Chinese GP – FP1  |  Live")
        self._title.setStyleSheet(f"color:{ACCENT}; font-family:Monospace; font-size:14px; font-weight:bold;")
        self._status = QLabel("Starting…")
        self._status.setStyleSheet(f"color:{TEXT_DIM}; font-family:Monospace; font-size:10px;")
        hdr.addWidget(self._title); hdr.addStretch(); hdr.addWidget(self._status)
        lay.addLayout(hdr)

        sep = QFrame(); sep.setFrameShape(QFrame.HLine)
        sep.setStyleSheet(f"color:{BORDER};"); lay.addWidget(sep)

        spl = QSplitter(Qt.Horizontal)
        spl.setHandleWidth(2)
        spl.setStyleSheet(f"QSplitter::handle {{ background:{BORDER}; }}")

        left = QWidget(); ll = QVBoxLayout(left); ll.setContentsMargins(0,0,4,0); ll.setSpacing(6)
        self.t_timing = make_table(["POS","DRIVER","TEAM","GAP","LAPS","BEST LAP"])
        self.t_laps   = make_table(["P","DRIVER","BEST LAP","LAP #","S1","S2","S3"])
        ll.addWidget(wrap_panel("LIVE TIMING", self.t_timing), 1)
        ll.addWidget(wrap_panel("BEST LAPS",   self.t_laps),   1)

        right = QWidget(); rl = QVBoxLayout(right); rl.setContentsMargins(4,0,0,0); rl.setSpacing(6)
        self.t_tele  = make_table(["DRIVER","SPEED","RPM","GEAR","THROTTLE","BRAKE","DRS"])
        self.t_tyres = make_table(["DRIVER","TYRE","AGE","HISTORY","STOPS","LAST PIT"])
        rl.addWidget(wrap_panel("LIVE TELEMETRY",   self.t_tele),  1)
        rl.addWidget(wrap_panel("TYRES & PIT STOPS", self.t_tyres), 1)

        spl.addWidget(left); spl.addWidget(right); spl.setSizes([720,720])
        lay.addWidget(spl, 1)

        footer = QLabel("Source: OpenF1 API  |  MQTT push + parallel REST load")
        footer.setStyleSheet(f"color:{TEXT_DIM}; font-family:Monospace; font-size:9px;")
        lay.addWidget(footer)

    def _start_worker(self):
        self._thread = QThread()
        self._worker = DataWorker(self.sk)
        self._worker.moveToThread(self._thread)
        self._thread.started.connect(self._worker.start)
        self._worker.data_ready.connect(self._on_data)
        self._worker.status_msg.connect(self._status.setText)
        self._thread.start()

    def _dn_col(self, dn):  return TEAM_COLOURS.get(self._dm.get(dn,{}).get("team_name",""),"#888")
    def _dn_name(self, dn): return self._dm.get(dn,{}).get("name_acronym", str(dn))
    def _dn_team(self, dn): return self._dm.get(dn,{}).get("team_name","–")

    def _on_data(self, p):
        self._dm = p.get("drivers",{})
        self._fill_timing(p); self._fill_laps(p)
        self._fill_tele(p);   self._fill_tyres(p)

    def _sorted_drivers(self, p):
        return sorted(p.get("positions",{}).items(), key=lambda x: x[1].get("position",99))

    def _fill_timing(self, p):
        rows = self._sorted_drivers(p); bl = p.get("best_laps",{}); lc = p.get("lap_counts",{})
        leader_t = bl.get(rows[0][0],{}).get("lap_duration") if rows else None
        self.t_timing.setRowCount(len(rows))
        for i,(dn,pd) in enumerate(rows):
            t   = bl.get(dn,{}).get("lap_duration")
            gap = "LEADER" if i==0 else (f"+{float(t)-float(leader_t):.3f}" if t and leader_t else "–")
            cell(self.t_timing, i, 0, pd.get("position","–"), bold=True, align=Qt.AlignCenter)
            cell(self.t_timing, i, 1, self._dn_name(dn), fg=self._dn_col(dn), bold=True)
            cell(self.t_timing, i, 2, self._dn_team(dn), fg=TEXT_DIM)
            cell(self.t_timing, i, 3, gap, fg="#aaffaa" if i==0 else TEXT_MAIN)
            cell(self.t_timing, i, 4, lc.get(dn,0), align=Qt.AlignCenter)
            cell(self.t_timing, i, 5, fmt_lap(t), fg="#ffcc00" if t else TEXT_DIM)

    def _fill_laps(self, p):
        sl = sorted(p.get("best_laps",{}).items(), key=lambda x: x[1].get("lap_duration",9999))
        self.t_laps.setRowCount(len(sl))
        for i,(dn,lap) in enumerate(sl):
            cell(self.t_laps, i, 0, i+1, bold=True, align=Qt.AlignCenter)
            cell(self.t_laps, i, 1, self._dn_name(dn), fg=self._dn_col(dn), bold=True)
            cell(self.t_laps, i, 2, fmt_lap(lap.get("lap_duration")), fg="#ff00ff" if i==0 else TEXT_MAIN, bold=(i==0))
            cell(self.t_laps, i, 3, lap.get("lap_number","–"), align=Qt.AlignCenter)
            cell(self.t_laps, i, 4, fmt_lap(lap.get("duration_sector_1")), fg="#00ff88")
            cell(self.t_laps, i, 5, fmt_lap(lap.get("duration_sector_2")), fg="#00ff88")
            cell(self.t_laps, i, 6, fmt_lap(lap.get("duration_sector_3")), fg="#00ff88")

    def _fill_tele(self, p):
        rows = self._sorted_drivers(p); tele = p.get("telemetry",{})
        self.t_tele.setRowCount(len(rows))
        for i,(dn,_) in enumerate(rows):
            t = tele.get(dn,{})
            spd = t.get("speed","–"); drs_raw = t.get("drs",0)
            drs_txt = DRS_MAP.get(drs_raw, str(drs_raw)); brake = t.get("brake",0)
            cell(self.t_tele, i, 0, self._dn_name(dn), fg=self._dn_col(dn), bold=True)
            cell(self.t_tele, i, 1, f"{spd} km/h" if spd!="–" else "–",
                 fg="#ff4444" if isinstance(spd,(int,float)) and spd>300 else TEXT_MAIN, align=Qt.AlignRight)
            cell(self.t_tele, i, 2, t.get("rpm","–"), align=Qt.AlignRight)
            cell(self.t_tele, i, 3, t.get("n_gear","–"), bold=True, align=Qt.AlignCenter)
            cell(self.t_tele, i, 4, f"{t.get('throttle','–')}%" if t.get('throttle') is not None else "–", align=Qt.AlignRight)
            cell(self.t_tele, i, 5, "YES" if brake else "–", fg="#ff4444" if brake else TEXT_DIM, align=Qt.AlignCenter)
            cell(self.t_tele, i, 6, drs_txt,
                 fg="#00ff88" if drs_txt=="ON" else ("#ffcc00" if drs_txt=="ELIGIBLE" else TEXT_DIM), align=Qt.AlignCenter)

    def _fill_tyres(self, p):
        rows = self._sorted_drivers(p); stints = p.get("stints",{}); pits = p.get("pits",{})
        self.t_tyres.setRowCount(len(rows))
        for i,(dn,_) in enumerate(rows):
            sl = stints.get(dn,[]); pl = pits.get(dn,[])
            curr = sl[-1] if sl else {}
            cmpd = curr.get("compound","–").upper() if curr else "–"
            age  = curr.get("tyre_age_at_start","–") if curr else "–"
            hist = " ".join(f"{s.get('compound','?')[0]}({s.get('tyre_age_at_start','?')})" for s in sl[:-1]) or "–"
            last_pit = pl[-1].get("lap_number","–") if pl else "–"
            cell(self.t_tyres, i, 0, self._dn_name(dn), fg=self._dn_col(dn), bold=True)
            cell(self.t_tyres, i, 1, cmpd, fg=TYRE_COLOURS.get(cmpd,"#888"), bold=True, align=Qt.AlignCenter)
            cell(self.t_tyres, i, 2, f"{age} laps" if age!="–" else "–", align=Qt.AlignCenter)
            cell(self.t_tyres, i, 3, hist, fg=TEXT_DIM)
            cell(self.t_tyres, i, 4, len(pl), align=Qt.AlignCenter)
            cell(self.t_tyres, i, 5, last_pit, align=Qt.AlignCenter)

    def closeEvent(self, e):
        self._worker.stop()
        self._thread.quit(); self._thread.wait()
        super().closeEvent(e)


# ── Entry ─────────────────────────────────────────────────────────────────────
def resolve_session():
    print("Resolving 2026 Chinese GP FP1…")
    sessions = api_get("sessions", {"year": 2026, "country_name": "China"})
    if not sessions:
        sessions = api_get("sessions", {"year": 2026})
    if not sessions:
        print("ERROR: No sessions found."); sys.exit(1)
    for s in sessions:
        if any(k in s.get("session_name","") for k in ["Practice 1","FP1"]):
            print(f"  ✓ {s['session_name']}  key={s['session_key']}")
            return s["session_key"], s["session_name"]
    s = sorted(sessions, key=lambda x: x.get("date_start",""), reverse=True)[0]
    print(f"  ✓ (latest) {s['session_name']}  key={s['session_key']}")
    return s["session_key"], s["session_name"]

if __name__ == "__main__":
    sk, name = resolve_session()
    app = QApplication(sys.argv)
    win = LiveDashboard(session_key=sk, label=f"2026 Chinese GP – {name}")
    win.show()
    sys.exit(app.exec())