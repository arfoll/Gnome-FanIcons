import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const POLL_MS = 3000;
const FRAME_MS = 16;
const MAX_RPM = 6000;
const MAX_DEG = 30;
const SMOOTHING = 0.05;
const SENSORS_EVERY = 4;

const FanIndicator = GObject.registerClass(
class FanIndicator extends PanelMenu.Button {
    _init(extensionPath) {
        super._init(0.0, 'Fan & Temp Indicator');

        this._box = new St.BoxLayout({
            style_class: 'panel-status-indicators-box',
            vertical: false,
        });
        this.add_child(this._box);

        this._gicon = Gio.icon_new_for_string(extensionPath + '/fan-symbolic.svg');
        this._fanStates = {};
        this._uiFanMap = new Map();
        this._uiTempMap = new Map();
        this._panelTempKeys = [];
        this._panelTempsLabel = null;
        this._fp = '';
        this._uiReady = false;
        this._sensorsOk = true;
        this._nvidiaOk = true;
        this._pollN = 0;
        this._rotLoopId = null;
        this._rotRunning = false;
        this._dead = false;

        this._pollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, POLL_MS, () => {
            if (this._dead) return GLib.SOURCE_REMOVE;
            this._poll().catch(e => console.error(`Fan Indicator: ${e.message}`));
            return GLib.SOURCE_CONTINUE;
        });
        this._poll().catch(e => console.error(`Fan Indicator: ${e.message}`));
    }

    // Read a single sysfs file, returns trimmed string or null.
    async _sysfs(path) {
        return new Promise((resolve) => {
            const f = Gio.File.new_for_path(path);
            f.load_contents_async(null, (obj, res) => {
                try {
                    const [ok, data] = obj.load_contents_finish(res);
                    resolve(ok ? new TextDecoder().decode(data).trim() : null);
                } catch (_) { resolve(null); }
            });
        });
    }

    // Enumerate /sys/class/hwmon and read fan/temp inputs natively.
    async _readHwmon() {
        const fans = [];
        const temps = [];
        let dir;

        try {
            dir = GLib.Dir.open('/sys/class/hwmon', 0);
        } catch (_) {
            return {fans, temps};
        }

        let entry;
        while ((entry = dir.read_name()) !== null) {
            const base = `/sys/class/hwmon/${entry}`;
            const chip = await this._sysfs(`${base}/name`) || entry;

            let sub;
            try { sub = GLib.Dir.open(base, 0); } catch (_) { continue; }

            let fname;
            while ((fname = sub.read_name()) !== null) {
                let m;
                if ((m = fname.match(/^fan(\d+)_input$/))) {
                    const raw = await this._sysfs(`${base}/${fname}`);
                    if (raw === null) continue;
                    const val = parseInt(raw, 10);
                    if (isNaN(val)) continue;
                    const lbl = await this._sysfs(`${base}/fan${m[1]}_label`) || `fan${m[1]}`;
                    fans.push({
                        key: `hwmon_${chip}_fan${m[1]}`,
                        label: `${lbl} (${chip})`,
                        value: val,
                        isPercentage: false,
                    });
                } else if ((m = fname.match(/^temp(\d+)_input$/))) {
                    const raw = await this._sysfs(`${base}/${fname}`);
                    if (raw === null) continue;
                    const val = parseInt(raw, 10);
                    if (isNaN(val)) continue;
                    const lbl = await this._sysfs(`${base}/temp${m[1]}_label`) || `temp${m[1]}`;
                    temps.push({
                        key: `hwmon_${chip}_temp${m[1]}`,
                        label: `${lbl} (${chip})`,
                        value: Math.round(val / 1000),
                        category: this._classifyTemp(chip, lbl),
                    });
                }
            }
            sub.close();
        }
        dir.close();
        return {fans, temps};
    }

    // Check NVIDIA GPU PCI runtime status without spawning nvidia-smi.
    async _isNvidiaAwake() {
        let dir;
        try { dir = GLib.Dir.open('/sys/bus/pci/devices', 0); }
        catch (_) { return true; }

        let found = false;
        let entry;
        while ((entry = dir.read_name()) !== null) {
            const vendor = await this._sysfs(`/sys/bus/pci/devices/${entry}/vendor`);
            if (vendor !== '0x10de') continue;

            found = true;
            const status = await this._sysfs(
                `/sys/bus/pci/devices/${entry}/power/runtime_status`);
            if (status !== 'suspended') {
                dir.close();
                return true;
            }
        }
        dir.close();
        return !found;
    }

    _exec(argv) {
        return new Promise((resolve, reject) => {
            try {
                const proc = new Gio.Subprocess({
                    argv,
                    flags: Gio.SubprocessFlags.STDOUT_PIPE |
                           Gio.SubprocessFlags.STDERR_PIPE,
                });
                proc.init(null);
                proc.communicate_utf8_async(null, null, (p, res) => {
                    try {
                        const [ok, stdout] = p.communicate_utf8_finish(res);
                        resolve(ok ? (stdout ?? '') : '');
                    } catch (e) { reject(e); }
                });
            } catch (e) { reject(e); }
        });
    }

    async _poll() {
        if (this._dead) return;
        try {

        const fans = [];
        const temps = [];
        const seen = new Set();

        const addFan = f => { if (!seen.has(f.key)) { seen.add(f.key); fans.push(f); } };
        const addTemp = t => { if (!seen.has(t.key)) { seen.add(t.key); temps.push(t); } };

        // Native hwmon reads (no subprocess)
        const hw = await this._readHwmon();
        for (const f of hw.fans) addFan(f);
        for (const t of hw.temps) addTemp(t);

        // lm-sensors JSON fallback (only when hwmon found nothing)
        this._pollN++;
        if (fans.length === 0 && temps.length === 0 &&
            this._sensorsOk && (this._pollN % SENSORS_EVERY) === 0) {
            try {
                const json = await this._exec(['sensors', '-j']);
                if (json) {
                    const p = this._parseSensorsJson(json);
                    for (const f of p.fans) addFan(f);
                    for (const t of p.temps) addTemp(t);
                }
            } catch (e) {
                if (/No such file|not found/i.test(e.message))
                    this._sensorsOk = false;
            }
        }

        // NVIDIA GPU (skip if asleep to avoid waking it)
        if (this._nvidiaOk && (await this._isNvidiaAwake())) {
            try {
                const out = await this._exec([
                    'nvidia-smi',
                    '--query-gpu=name,temperature.gpu,fan.speed',
                    '--format=csv,noheader',
                ]);
                if (out) this._parseNvidia(out, addFan, addTemp);
            } catch (e) {
                if (/No such file|not found/i.test(e.message))
                    this._nvidiaOk = false;
            }
        }

        if (this._dead) return;

        const fp = this._buildFp(fans, temps);
        if (fp !== this._fp) {
            this._fp = fp;
            this._rebuildUi(fans, temps);
        } else {
            this._updateUi(fans, temps);
        }
        this._manageRotation();
        } catch (e) {
            console.error(`Fan Indicator: ${e.message}`);
        }
    }

    _buildFp(fans, temps) {
        let s = '';
        for (const f of fans) s += f.key + ',';
        s += '|';
        for (const t of temps) s += t.key + ',';
        return s;
    }

    _parseNvidia(output, addFan, addTemp) {
        const lines = output.trim().split('\n');
        for (let i = 0; i < lines.length; i++) {
            const p = lines[i].split(',');
            if (p.length < 3) continue;

            const name = p[0].trim().replace('NVIDIA GeForce ', '');
            const temp = parseInt(p[1], 10);
            const fanStr = p[2].replace('%', '').trim();

            if (fanStr !== '[Not Supported]') {
                const fan = parseInt(fanStr, 10);
                if (!isNaN(fan))
                    addFan({key: `nvidia_fan_${i}`, label: `${name} Fan`,
                            value: fan, isPercentage: true});
            }
            if (!isNaN(temp))
                addTemp({key: `nvidia_temp_${i}`, label: name,
                         value: temp, category: 'gpu'});
        }
    }

    _parseSensorsJson(jsonStr) {
        const fans = [];
        const temps = [];
        try {
            const data = JSON.parse(jsonStr);
            for (const [chip, chipData] of Object.entries(data)) {
                const short = chip.split('-')[0];
                for (const [feat, fData] of Object.entries(chipData)) {
                    if (typeof fData !== 'object' || fData === null) continue;
                    for (const [sub, val] of Object.entries(fData)) {
                        if (!sub.endsWith('_input')) continue;
                        if (sub.includes('fan')) {
                            fans.push({
                                key: `${chip}_${feat}`,
                                label: feat.startsWith('fan')
                                    ? `${feat} (${short})` : feat,
                                value: Math.round(val),
                                isPercentage: false,
                            });
                        }
                        if (sub.includes('temp')) {
                            const lbl = feat.startsWith('temp')
                                ? `${feat} (${short})` : feat;
                            temps.push({
                                key: `${chip}_${feat}`, label: lbl,
                                value: Math.round(val),
                                category: this._classifyTemp(short, lbl),
                            });
                        }
                    }
                }
            }
        } catch (e) {
            console.error(`Fan Indicator: ${e.message}`);
        }
        return {fans, temps};
    }

    _classifyTemp(chip, label) {
        const c = chip.toLowerCase();
        const l = label.toLowerCase();

        if (c === 'k10temp' || c === 'coretemp' || c === 'zenpower') return 'cpu';
        if (l.includes('tctl') || l.includes('tdie') || l === 'package id 0') return 'cpu';

        if (c === 'amdgpu' || c === 'nouveau' || c === 'radeon') return 'gpu';
        if (l === 'edge' || l === 'junction' || l === 'mem') return 'gpu';

        if (c === 'acpitz' || c.includes('thinkpad') || c.includes('dell') ||
            c.includes('asus') || /^nct67\d\d$/.test(c) || c === 'it8665')
            return 'board';

        if (c === 'nvme' || c === 'drivetemp') return 'disk';
        if (c.includes('phy') || c.includes('iwl')) return 'other';
        return 'other';
    }

    _calculateSystemTemp(temps) {
        if (temps.length === 0) return '--';
        let wSum = 0, wTotal = 0;
        for (const t of temps) {
            const w = (t.category === 'cpu' || t.category === 'gpu') ? 1.0
                    : (t.category === 'board' || t.category === 'disk') ? 0.5
                    : 0.2;
            wSum += w * t.value * t.value;
            wTotal += w;
        }
        return wTotal > 0 ? Math.round(Math.sqrt(wSum / wTotal)) : '--';
    }

    _getTempColor(val) {
        if (val === '--') return '#a3a3a3';
        if (val < 50) return '#33d17a';
        if (val < 70) return '#f6d32d';
        return '#ff5500';
    }

    _getCategoryIcon(cat) {
        switch (cat) {
            case 'cpu':   return 'computer-symbolic';
            case 'gpu':   return 'video-display-symbolic';
            case 'disk':  return 'drive-harddisk-symbolic';
            case 'board': return 'drive-harddisk-system-symbolic';
            default:      return 'temperature-symbolic';
        }
    }

    _manageRotation() {
        if (this._dead) return;

        let any = false;
        for (const k in this._fanStates) {
            const s = this._fanStates[k];
            if (s.iconActor && (s.targetRpm > 0 || s.currentRpm > 1)) {
                any = true;
                break;
            }
        }

        if (any && !this._rotRunning) {
            this._rotLoopId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT, FRAME_MS, () => {
                    if (this._dead) return GLib.SOURCE_REMOVE;
                    this._tick();
                    return GLib.SOURCE_CONTINUE;
                });
            this._rotRunning = true;
        } else if (!any && this._rotRunning) {
            if (this._rotLoopId) {
                GLib.Source.remove(this._rotLoopId);
                this._rotLoopId = null;
            }
            this._rotRunning = false;
        }
    }

    _rebuildUi(fans, temps) {
        this._box.destroy_all_children();
        this.menu.removeAll();
        this._uiFanMap.clear();
        this._uiTempMap.clear();
        this._panelTempKeys = [];
        this._panelTempsLabel = null;

        // Purge stale fan states
        const active = new Set(fans.map(f => f.key));
        for (const k of Object.keys(this._fanStates))
            if (!active.has(k)) delete this._fanStates[k];

        if (fans.length === 0 && temps.length === 0) {
            this._showFallback();
            return;
        }

        // Fans
        for (let i = 0; i < fans.length; i++) {
            const fan = fans[i];
            const unit = fan.isPercentage ? '%' : ' RPM';

            if (!this._fanStates[fan.key])
                this._fanStates[fan.key] = {
                    currentRpm: 0, targetRpm: fan.value,
                    angle: 0, iconActor: null, isPercentage: fan.isPercentage,
                };
            this._fanStates[fan.key].targetRpm = fan.value;

            const mi = new PopupMenu.PopupMenuItem(
                `${fan.label}: ${fan.value}${unit}`);
            this.menu.addMenuItem(mi);

            const ui = {label: fan.label, menuItem: mi,
                        hasPanel: false, unit, panelLabel: null,
                        lastValue: fan.value};

            if (i < 2) {
                const ico = new St.Icon({gicon: this._gicon,
                    style_class: 'system-status-icon'});
                ico.set_pivot_point(0.5, 0.5);

                const lbl = new St.Label({text: `${fan.value}${unit}`,
                    y_align: Clutter.ActorAlign.CENTER,
                    style: 'margin-left:4px;margin-right:12px;font-weight:bold;'});

                this._box.add_child(ico);
                this._box.add_child(lbl);
                this._fanStates[fan.key].iconActor = ico;
                ui.panelLabel = lbl;
                ui.hasPanel = true;
            }
            this._uiFanMap.set(fan.key, ui);
        }

        if (fans.length === 0 && temps.length > 0) {
            this.menu.addMenuItem(new PopupMenu.PopupMenuItem(
                'ℹ️ No fan RPM exposed by this hardware'));
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        }

        // Temperatures
        if (fans.length > 0 && temps.length > 0)
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        if (temps.length > 0) {
            const sysT = this._calculateSystemTemp(temps);
            const col = this._getTempColor(sysT);
            this._uiSysTemp = new PopupMenu.PopupImageMenuItem(
                `System Temperature: ${sysT}°C [RMS]`, 'temperature-symbolic');
            this._uiSysTemp.label.set_style(`color:${col};font-weight:bold;`);
            this.menu.addMenuItem(this._uiSysTemp);
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        }

        const catMenus = {};
        const catOrd = {cpu: 1, gpu: 2, board: 3, disk: 4, other: 5};
        const catLabel = {cpu: 'CPU', gpu: 'GPU', board: 'Motherboard',
                          disk: 'Storage', other: 'Other Sensors'};

        temps.sort((a, b) => (catOrd[a.category] || 5) - (catOrd[b.category] || 5));

        for (const t of temps) {
            const cat = t.category || 'other';
            if (!catMenus[cat]) {
                catMenus[cat] = new PopupMenu.PopupSubMenuMenuItem(
                    `${catLabel[cat]} Sensors`);
                this.menu.addMenuItem(catMenus[cat]);
            }

            const col = this._getTempColor(t.value);
            const mi = new PopupMenu.PopupImageMenuItem(
                `${t.label}: ${t.value}°C`, this._getCategoryIcon(cat));
            mi.label.set_style(`color:${col};`);
            catMenus[cat].menu.addMenuItem(mi);

            this._uiTempMap.set(t.key, {
                label: t.label, menuItem: mi, lastValue: t.value,
            });
        }

        if (temps.length > 0) {
            const sysT = this._calculateSystemTemp(temps);
            const col = this._getTempColor(sysT);

            this._panelTempIcon = new St.Icon({
                icon_name: 'temperature-symbolic',
                style_class: 'system-status-icon',
                y_align: Clutter.ActorAlign.CENTER,
                style: `margin-left:6px;color:${col};`,
            });
            this._box.add_child(this._panelTempIcon);

            this._panelTempsLabel = new St.Label({
                text: `${sysT}°C`,
                y_align: Clutter.ActorAlign.CENTER,
                style: `margin-left:2px;font-weight:bold;color:${col};`,
            });
            this._box.add_child(this._panelTempsLabel);
        }

        if (this._box.get_n_children() === 0) {
            this._box.add_child(new St.Icon({
                gicon: this._gicon, style_class: 'system-status-icon'}));
        }

        this._uiReady = true;
    }

    _updateUi(fans, temps) {
        for (const fan of fans) {
            if (this._fanStates[fan.key])
                this._fanStates[fan.key].targetRpm = fan.value;
            const ui = this._uiFanMap.get(fan.key);
            if (!ui || ui.lastValue === fan.value) continue;
            ui.lastValue = fan.value;
            ui.menuItem.label.text = `${ui.label}: ${fan.value}${ui.unit}`;
            if (ui.hasPanel && ui.panelLabel)
                ui.panelLabel.set_text(`${fan.value}${ui.unit}`);
        }

        let dirty = false;
        for (const t of temps) {
            const ui = this._uiTempMap.get(t.key);
            if (!ui || ui.lastValue === t.value) continue;
            ui.lastValue = t.value;
            ui.menuItem.label.text = `${ui.label}: ${t.value}°C`;
            ui.menuItem.label.set_style(`color:${this._getTempColor(t.value)};`);
            dirty = true;
        }

        if (dirty && this._panelTempsLabel) {
            const sysT = this._calculateSystemTemp(temps);
            const col = this._getTempColor(sysT);
            this._panelTempsLabel.set_text(`${sysT}°C`);
            this._panelTempsLabel.set_style(
                `margin-left:2px;font-weight:bold;color:${col};`);
            if (this._panelTempIcon)
                this._panelTempIcon.set_style(`margin-left:6px;color:${col};`);
            if (this._uiSysTemp) {
                this._uiSysTemp.label.text =
                    `System Temperature: ${sysT}°C [RMS]`;
                this._uiSysTemp.label.set_style(
                    `color:${col};font-weight:bold;`);
            }
        }
    }

    _tick() {
        for (const k in this._fanStates) {
            const s = this._fanStates[k];
            if (!s.iconActor) continue;
            s.currentRpm += (s.targetRpm - s.currentRpm) * SMOOTHING;

            const max = s.isPercentage ? 100 : MAX_RPM;
            const thr = s.isPercentage ? 5 : 50;
            if (s.currentRpm >= thr) {
                const r = Math.min(s.currentRpm / max, 1.0);
                s.angle = (s.angle + r * MAX_DEG) % 360;
                s.iconActor.rotation_angle_z = s.angle;
            }
        }
    }

    _showFallback() {
        this._box.destroy_all_children();
        this.menu.removeAll();
        this._box.add_child(new St.Label({
            text: '⚠️ No Sensors',
            y_align: Clutter.ActorAlign.CENTER,
            style: 'font-weight:bold;color:#ff3333;',
        }));
        this.menu.addMenuItem(new PopupMenu.PopupMenuItem(
            'No hwmon sensors detected. Install lm-sensors and run sensors-detect.'));
        this._uiReady = false;
    }

    destroy() {
        this._dead = true;
        if (this._pollId) {
            GLib.Source.remove(this._pollId);
            this._pollId = null;
        }
        if (this._rotLoopId) {
            GLib.Source.remove(this._rotLoopId);
            this._rotLoopId = null;
        }
        this._rotRunning = false;
        super.destroy();
    }
});

export default class FanIconExtension extends Extension {
    enable() {
        this._indicator = new FanIndicator(this.dir.get_path());
        Main.panel.addToStatusArea('fan-indicator', this._indicator, 1, 'left');
    }

    disable() {
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }
}
