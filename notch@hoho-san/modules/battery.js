// Battery moments in the compact pill: a short charging pulse when the
// charger goes in, and a warning when the battery drops below 20%.
//
// GNOME already sends its own "battery low/critical" notifications at lower
// levels (which now show in the notch too), so this warns earlier rather
// than repeating them.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';

const LOW_PERCENT = 20;
const CHARGING_SHOW_MS = 3000;
const LOW_SHOW_MS = 4000;

const UPOWER = 'org.freedesktop.UPower';
const DISPLAY_DEVICE = '/org/freedesktop/UPower/devices/DisplayDevice';

const DeviceProxy = Gio.DBusProxy.makeProxyWrapper(`
<node>
  <interface name="org.freedesktop.UPower.Device">
    <property name="Type" type="u" access="read"/>
    <property name="State" type="u" access="read"/>
    <property name="Percentage" type="d" access="read"/>
    <property name="IsPresent" type="b" access="read"/>
  </interface>
</node>`);

const DeviceType = {BATTERY: 2};
const DeviceState = {
    CHARGING: 1,
    DISCHARGING: 2,
    FULLY_CHARGED: 4,
    PENDING_CHARGE: 5,
};
const PLUGGED_IN = new Set([
    DeviceState.CHARGING, DeviceState.FULLY_CHARGED, DeviceState.PENDING_CHARGE,
]);

function batteryIcon(percent, charging) {
    const level = Math.min(100, Math.max(0, Math.round(percent / 10) * 10));
    let name = `battery-level-${level}-symbolic`;
    if (charging)
        name = level === 100 ? 'battery-level-100-charged-symbolic' : `battery-level-${level}-charging-symbolic`;
    return Gio.ThemedIcon.new_from_names([name, 'battery-symbolic']);
}

export class BatteryModule extends EventEmitter {
    constructor(settings) {
        super();
        this._settings = settings;
        this._flashId = 0;
        this._flashing = false;
        this._known = false; // seen a first reading to compare against

        this.busy = false;

        this.activityStart = new St.Icon({style_class: 'notch-battery-icon'});
        this.activityEnd = new St.Label({style_class: 'notch-battery-label'});

        // Tests point this at a fake UPower on the session bus.
        const bus = GLib.getenv('NOTCH_UPOWER_BUS') === 'session'
            ? Gio.DBus.session : Gio.DBus.system;
        this._cancellable = new Gio.Cancellable();
        // eslint-disable-next-line no-new
        new DeviceProxy(bus, UPOWER, DISPLAY_DEVICE, (proxy, error) => {
            if (error) {
                if (!error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    console.warn(`notch: no battery info: ${error.message}`);
                return;
            }
            this._proxy = proxy;
            proxy.connectObject(
                'g-properties-changed', () => this._sync(),
                'notify::g-name-owner', () => {
                    // UPower restarted: its next reading is a fresh start.
                    this._known = false;
                    this._sync();
                }, this);
            this._sync();
        }, this._cancellable);
    }

    get hasActivity() {
        return this._flashing;
    }

    _sync() {
        const proxy = this._proxy;
        const present = proxy?.g_name_owner && proxy.IsPresent &&
            proxy.Type === DeviceType.BATTERY;
        if (!present) {
            this._known = false;
            return;
        }

        const percent = proxy.Percentage;
        const plugged = PLUGGED_IN.has(proxy.State);
        if (this._known && this._settings.get_boolean('battery')) {
            if (plugged && !this._plugged)
                this._flash('charging', percent, CHARGING_SHOW_MS);
            else if (!plugged && this._percent >= LOW_PERCENT && percent < LOW_PERCENT)
                this._flash('low', percent, LOW_SHOW_MS);
        }
        this._known = true;
        this._plugged = plugged;
        this._percent = percent;
    }

    _flash(kind, percent, durationMs) {
        this.activityStart.gicon = batteryIcon(percent, kind === 'charging');
        this.activityEnd.text = `${Math.round(percent)}%`;
        for (const actor of [this.activityStart, this.activityEnd]) {
            actor.remove_style_class_name('charging');
            actor.remove_style_class_name('low');
            actor.add_style_class_name(kind);
        }

        this._flashing = true;
        this._clearFlash();
        this._flashId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, durationMs, () => {
            this._flashId = 0;
            this._flashing = false;
            this.emit('changed');
            return GLib.SOURCE_REMOVE;
        });
        this.emit('changed');
    }

    _clearFlash() {
        if (this._flashId) {
            GLib.source_remove(this._flashId);
            this._flashId = 0;
        }
    }

    destroy() {
        this._cancellable.cancel();
        this._clearFlash();
        this._proxy?.disconnectObject(this);
        this._proxy = null;
        this.activityStart.destroy();
        this.activityEnd.destroy();
    }
}
