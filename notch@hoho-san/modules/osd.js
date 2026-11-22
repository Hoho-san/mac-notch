// Volume, brightness and other system pop-ups, shown in the notch instead of
// GNOME's on-screen display: the icon on the pill's left edge, the level
// (or a short label, e.g. "Touchpad off") on its right.
//
// Only the primary monitor's pop-up is taken over, since that's where the
// notch is. Other monitors, and any time the notch is hidden (a full-screen
// window), keep GNOME's.
//
// GNOME only pops up for the volume keys: dragging the volume slider in the
// system menu shows nothing (brightness, by contrast, pops up for every
// change). So the notch also watches the output volume itself and shows any
// change to it, wherever it came from.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gvc from 'gi://Gvc';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';
import {BarLevel} from 'resource:///org/gnome/shell/ui/barLevel.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {OsdWindowManager} from 'resource:///org/gnome/shell/ui/osdWindow.js';
import {getMixerControl} from 'resource:///org/gnome/shell/ui/status/volume.js';

const HIDE_TIMEOUT_MS = 1500; // same as GNOME's pop-up
const LEVEL_ANIMATION_MS = 100;

// The same icons, in the same steps, as GNOME's own volume pop-up.
const VOLUME_ICONS = [
    'audio-volume-muted-symbolic',
    'audio-volume-low-symbolic',
    'audio-volume-medium-symbolic',
    'audio-volume-high-symbolic',
    'audio-volume-overamplified-symbolic',
];
const ALLOW_AMPLIFIED_KEY = 'allow-volume-above-100-percent';

const clamp = (v, min, max) => Math.min(Math.max(v, min), max);

export class OsdModule extends EventEmitter {
    /**
     * @param {Gio.Settings} settings
     * @param {() => boolean} isNotchShowing - whether the notch is on screen
     */
    constructor(settings, isNotchShowing) {
        super();
        this._settings = settings;
        this._isNotchShowing = isNotchShowing;
        this._showing = false;
        this._hideId = 0;

        // A volume change should be seen even with the notch open.
        this.activityWhenExpanded = true;
        this.body = null;
        this.busy = false;

        this.activityStart = new St.Icon({style_class: 'notch-osd-icon'});
        this.activityEnd = new St.Widget({
            style_class: 'notch-osd-end',
            layout_manager: new Clutter.BinLayout(),
        });
        this._level = new BarLevel({
            style_class: 'notch-osd-level',
            value: 0,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._label = new St.Label({
            style_class: 'notch-osd-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this.activityEnd.add_child(this._level);
        this.activityEnd.add_child(this._label);

        this._injections = new InjectionManager();
        this._intercept();
        this._watchVolume();
    }

    get hasActivity() {
        return this._showing;
    }

    // All of GNOME's pop-ups go through show() (brightness, and showOne(),
    // which mutter uses for e.g. touchpad toggles) or showAll() (volume).
    _intercept() {
        const module = this;
        const proto = OsdWindowManager.prototype;

        this._injections.overrideMethod(proto, 'show', original =>
            function (icon, label, levels) {
                return original.call(this, icon, label,
                    module._takePrimary(icon, label, levels));
            });

        this._injections.overrideMethod(proto, 'showAll', original =>
            function (icon, label, level, maxLevel) {
                if (!module._wants(icon))
                    return original.call(this, icon, label, level, maxLevel);
                // Re-route through show() so the primary monitor's share can
                // be taken out.
                const levels = {};
                Main.layoutManager.monitors.forEach((_, i) => {
                    levels[i] = {level, maxLevel};
                });
                return this.show(icon, label, levels);
            });
    }

    // The shell's own mixer connection, shared with its volume controls.
    _watchVolume() {
        this._mixer = getMixerControl();
        this._soundSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.sound'});
        this._mixer.connectObject(
            'state-changed', () => this._trackSink(),
            'default-sink-changed', () => this._trackSink(), this);
        this._trackSink();
    }

    _trackSink() {
        const sink = this._mixer.get_state() === Gvc.MixerControlState.READY
            ? this._mixer.get_default_sink() : null;
        if (sink === this._sink)
            return;
        this._sink?.disconnectObject(this);
        this._sink = sink;
        // Switching to another device isn't a volume change; compare from here.
        this._lastVolume = this._readVolume();
        sink?.connectObject(
            'notify::volume', () => this._onVolumeChanged(),
            'notify::is-muted', () => this._onVolumeChanged(), this);
    }

    _readVolume() {
        return this._sink
            ? {volume: this._sink.volume, muted: this._sink.is_muted}
            : null;
    }

    _onVolumeChanged() {
        const now = this._readVolume();
        const last = this._lastVolume;
        this._lastVolume = now;
        // Some devices re-announce an unchanged volume; that's not a change.
        if (!now || (last && last.volume === now.volume && last.muted === now.muted))
            return;

        const norm = this._mixer.get_vol_max_norm();
        let step = 0;
        if (!now.muted && now.volume > 0)
            step = clamp(Math.ceil(3 * now.volume / norm), 1, VOLUME_ICONS.length - 1);
        const icon = new Gio.ThemedIcon({name: VOLUME_ICONS[step]});
        if (!this._wants(icon))
            return;

        const maxLevel = this._soundSettings.get_boolean(ALLOW_AMPLIFIED_KEY)
            ? this._mixer.get_vol_max_amplified() / norm : 1;
        this._show(icon, null, now.muted ? 0 : now.volume / norm, maxLevel);
    }

    _wants(icon) {
        return !!icon && this._settings.get_boolean('osd') && this._isNotchShowing();
    }

    // Shows the primary monitor's entry in the notch; returns the rest for
    // GNOME to show. GNOME hides its pop-up on monitors left out.
    _takePrimary(icon, label, levels) {
        const primary = Main.layoutManager.primaryIndex;
        const entry = levels?.[primary];
        if (!entry || !this._wants(icon))
            return levels;

        this._show(icon, label, entry.level, entry.maxLevel);
        const rest = {...levels};
        delete rest[primary];
        return rest;
    }

    _show(icon, label, level, maxLevel) {
        const wasShowing = this._showing;
        this.activityStart.gicon = icon;

        const hasLevel = typeof level === 'number' && Number.isFinite(level);
        this._level.visible = hasLevel;
        this._label.visible = !hasLevel && !!label;

        if (hasLevel) {
            // GNOME passes -1 or nothing for "the usual maximum".
            const max = maxLevel > 0 ? maxLevel : 1;
            this._level.maximum_value = max;
            // Above 100% (volume over-amplification) draws in a warning
            // colour, like the quick-settings slider.
            this._level.overdrive_start = Math.min(1, max);

            const value = clamp(level, 0, max);
            if (wasShowing && St.Settings.get().enable_animations) {
                this._level.ease_property('value', value, {
                    duration: LEVEL_ANIMATION_MS,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
            } else {
                this._level.remove_transition('value');
                this._level.value = value;
            }
        } else if (label) {
            this._label.text = label;
        }

        this._showing = true;
        this._restartHideTimer();
        this.emit('changed');
    }

    _restartHideTimer() {
        if (this._hideId)
            GLib.source_remove(this._hideId);
        this._hideId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, HIDE_TIMEOUT_MS, () => {
            this._hideId = 0;
            this._showing = false;
            this.emit('changed');
            return GLib.SOURCE_REMOVE;
        });
    }

    destroy() {
        this._injections.clear();
        this._mixer?.disconnectObject(this);
        this._sink?.disconnectObject(this);
        this._sink = null;
        if (this._hideId) {
            GLib.source_remove(this._hideId);
            this._hideId = 0;
        }
        this.activityStart.destroy();
        this.activityEnd.destroy();
    }
}
