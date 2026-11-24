// Music in the notch. While something plays, the compact pill grows album
// art on its left edge and a small visualizer on its right; expanded, it
// shows the full player. See notch.js for the module contract.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import Graphene from 'gi://Graphene';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';

import {ArtLoader} from '../art.js';
import {MprisWatcher, Status} from '../mpris.js';

// After pausing, keep the compact activity briefly: players often report a
// pause between tracks, and a quick pause/resume shouldn't make the pill
// jump.
const PAUSE_GRACE_MS = 5000;
const PROGRESS_TICK_MS = 1000;
const POSITION_RESYNC_TICKS = 5;
const BAR_COUNT = 4;
// Smooth bars glide between heights, which redraws every frame while music
// plays; stepped bars jump a few times a second instead, for about a fifth
// of the CPU (measured with `make perf`).
const SMOOTH_STEP_MS = 240;
const STEPPED_STEP_MS = 125;
const BAR_IDLE_SCALE = 0.22;
const DEFAULT_ACCENT = 'rgb(255, 255, 255)';
const FALLBACK_ICON = new Gio.ThemedIcon({name: 'audio-x-generic-symbolic'});

// Filled, rounded transport icons from icons/. The -symbolic suffix makes the
// shell recolour them from the CSS, like theme icons.
function controlIcon(extensionPath, name) {
    return Gio.icon_new_for_string(GLib.build_filenamev(
        [extensionPath, 'icons', `notch-media-${name}-symbolic.svg`]));
}

function formatTime(us) {
    const total = Math.floor(us / 1e6);
    const h = Math.floor(total / 3600);
    const m = Math.floor(total / 60) % 60;
    const s = String(total % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

const AlbumArt = GObject.registerClass(
class NotchAlbumArt extends St.Bin {
    _init(params) {
        super._init(params);
        this._icon = new St.Icon({
            style_class: 'notch-art-fallback',
            gicon: FALLBACK_ICON,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            y_expand: true,
        });
        this.child = this._icon;
    }

    /**
     * @param {?string} uri - local file:// URI of the art, or null
     * @param {?Gio.Icon} fallback - shown when there is no art (app icon)
     */
    setArt(uri, fallback = null) {
        if (uri) {
            // Drawn as a CSS background so the theme's border-radius clips it.
            this.set_style(`background-image: url("${uri.replaceAll('"', '%22')}");`);
            this._icon.hide();
        } else {
            this.set_style(null);
            this._icon.gicon = fallback ?? FALLBACK_ICON;
            this._icon.show();
        }
    }
});

// Bars that bounce while music plays. It's decorative, not a real
// spectrum: reading the audio stream would need PipeWire access.
const Visualizer = GObject.registerClass(
class NotchVisualizer extends St.BoxLayout {
    _init(settings, params) {
        super._init({style_class: 'notch-visualizer', ...params});
        this._settings = settings;
        this._playing = false;
        this._timerId = 0;
        this._bars = [];
        for (let i = 0; i < BAR_COUNT; i++) {
            const bar = new St.Widget({
                style_class: 'notch-bar',
                pivot_point: new Graphene.Point({x: 0.5, y: 0.5}),
                scale_y: BAR_IDLE_SCALE,
            });
            this._bars.push(bar);
            this.add_child(bar);
        }
        this.connect('notify::mapped', () => this._sync());
        this.connect('destroy', () => this._stopTimer());
        this._settings.connectObject('changed::smooth-visualizer', () => {
            this._stopTimer();
            this._sync();
        }, this);
    }

    get _smooth() {
        return this._settings.get_boolean('smooth-visualizer');
    }

    setColor(color) {
        this._bars.forEach(bar => bar.set_style(`background-color: ${color};`));
    }

    setPlaying(playing) {
        if (this._playing === playing)
            return;
        this._playing = playing;
        this._sync();
    }

    _sync() {
        // Only animate while actually on screen.
        if (this.mapped && this._playing && St.Settings.get().enable_animations) {
            if (!this._timerId) {
                this._bounce();
                const step = this._smooth ? SMOOTH_STEP_MS : STEPPED_STEP_MS;
                this._timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, step, () => {
                    this._bounce();
                    return GLib.SOURCE_CONTINUE;
                });
            }
        } else {
            this._stopTimer();
            this._bars.forEach(bar => bar.ease({
                scale_y: this._playing ? 0.6 : BAR_IDLE_SCALE,
                duration: 200,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            }));
        }
    }

    _bounce() {
        const smooth = this._smooth;
        for (const bar of this._bars) {
            const scale = 0.3 + Math.random() * 0.7;
            if (smooth) {
                bar.ease({
                    scale_y: scale,
                    duration: SMOOTH_STEP_MS,
                    mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
                });
            } else {
                bar.remove_all_transitions();
                bar.scale_y = scale;
            }
        }
    }

    _stopTimer() {
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = 0;
        }
    }
});

// The shell's slider, minus scroll-to-change: scrolling over the notch
// shouldn't silently seek.
const ProgressSlider = GObject.registerClass(
class NotchProgressSlider extends Slider {
    vfunc_scroll_event() {
        return Clutter.EVENT_PROPAGATE;
    }
});

const MediaView = GObject.registerClass({
    Signals: {'busy-changed': {}},
}, class NotchMediaView extends St.BoxLayout {
    _init(settings, extensionPath) {
        super._init({
            style_class: 'notch-media',
            orientation: Clutter.Orientation.VERTICAL,
        });
        this._settings = settings;
        this._icons = Object.fromEntries(
            ['skip-backward', 'skip-forward', 'play', 'pause'].map(
                name => [name, controlIcon(extensionPath, name)]));

        this._player = null;
        this._dragging = false;
        this._ticks = 0;
        this._tickId = 0;

        this._buildEmpty();
        this._buildPlayer();

        this.connect('notify::mapped', () => this._syncTicking());
        this.connect('destroy', () => this._stopTicking());
    }

    get dragging() {
        return this._dragging;
    }

    _buildEmpty() {
        this._empty = new St.BoxLayout({
            style_class: 'notch-media-empty',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._empty.add_child(new St.Icon({
            gicon: FALLBACK_ICON,
            style_class: 'notch-media-empty-icon',
        }));
        this._empty.add_child(new St.Label({
            text: 'Nothing playing',
            style_class: 'notch-media-empty-label',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this.add_child(this._empty);
    }

    _buildPlayer() {
        this._playerBox = new St.BoxLayout({
            style_class: 'notch-player',
            orientation: Clutter.Orientation.VERTICAL,
            visible: false,
        });

        // Art · title/artist · visualizer
        const top = new St.BoxLayout({style_class: 'notch-player-top'});
        this._art = new AlbumArt({style_class: 'notch-art'});
        const artButton = new St.Button({
            child: this._art,
            style_class: 'notch-art-button',
            accessible_name: 'Show player',
        });
        artButton.connect('clicked', () => this._player?.raise());
        top.add_child(artButton);

        const info = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'notch-player-info',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._title = new St.Label({style_class: 'notch-player-title'});
        this._artist = new St.Label({style_class: 'notch-player-artist'});
        for (const label of [this._title, this._artist])
            label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        info.add_child(this._title);
        info.add_child(this._artist);
        top.add_child(info);

        this._visualizer = new Visualizer(this._settings, {y_align: Clutter.ActorAlign.CENTER});
        top.add_child(this._visualizer);
        this._playerBox.add_child(top);

        // 0:42 ━━━━●──── -2:10
        this._progressRow = new St.BoxLayout({style_class: 'notch-progress-row'});
        this._elapsed = new St.Label({
            style_class: 'notch-time notch-time-elapsed',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._remaining = new St.Label({
            style_class: 'notch-time notch-time-remaining',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._slider = new ProgressSlider(0);
        this._slider.add_style_class_name('notch-progress');
        this._slider.accessible_name = 'Playback position';
        this._slider.y_align = Clutter.ActorAlign.CENTER;
        this._slider.connect('drag-begin', () => this._setDragging(true));
        this._slider.connect('notify::value', () => {
            if (this._dragging && this._player)
                this._showTimes(this._slider.value * this._player.track.length);
        });
        this._slider.connect('drag-end', () => {
            this._player?.seekTo(this._slider.value * this._player.track.length);
            this._setDragging(false);
        });
        this._progressRow.add_child(this._elapsed);
        this._progressRow.add_child(this._slider);
        this._progressRow.add_child(this._remaining);
        this._playerBox.add_child(this._progressRow);

        // ⏮ ⏯ ⏭
        const controls = new St.BoxLayout({
            style_class: 'notch-controls',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._prev = this._controlButton(this._icons['skip-backward'], 'Previous',
            () => this._player?.previous());
        this._playPause = this._controlButton(this._icons.play, 'Play',
            () => this._player?.playPause());
        this._playPause.add_style_class_name('notch-control-main');
        this._next = this._controlButton(this._icons['skip-forward'], 'Next',
            () => this._player?.next());
        [this._prev, this._playPause, this._next].forEach(b => controls.add_child(b));
        this._playerBox.add_child(controls);

        this.add_child(this._playerBox);
    }

    _controlButton(gicon, label, onClicked) {
        const button = new St.Button({
            style_class: 'notch-control',
            child: new St.Icon({gicon}),
            accessible_name: label,
            can_focus: true,
        });
        button.connect('clicked', onClicked);
        return button;
    }

    _setDragging(dragging) {
        this._dragging = dragging;
        this.emit('busy-changed');
    }

    /**
     * @param {?MprisPlayer} player
     * @param {{uri: ?string, color: string}} art
     */
    update(player, art) {
        this._player = player;
        this._empty.visible = !player;
        this._playerBox.visible = !!player;
        if (!player) {
            this._syncTicking();
            return;
        }

        const {track} = player;
        this._title.text = track.title || 'Unknown title';
        this._artist.text = track.artists.join(', ') || player.identity;
        this._art.setArt(art.uri, player.app?.get_icon());
        this._visualizer.setColor(art.color);

        const playing = player.status === Status.PLAYING;
        this._visualizer.setPlaying(playing);
        this._playPause.child.gicon = playing ? this._icons.pause : this._icons.play;
        this._playPause.accessible_name = playing ? 'Pause' : 'Play';
        this._prev.reactive = player.canGoPrevious;
        this._next.reactive = player.canGoNext;

        // Live streams have no length; there's nothing to show progress of.
        this._progressRow.visible = track.length > 0;
        this._slider.reactive = player.canSeek;
        this._syncProgress();
        this._syncTicking();
    }

    _syncProgress() {
        if (!this._player || this._dragging || !this._progressRow.visible)
            return;
        const {position} = this._player;
        this._slider.value = position / this._player.track.length;
        this._showTimes(position);
    }

    _showTimes(position) {
        const {length} = this._player.track;
        this._elapsed.text = formatTime(position);
        this._remaining.text = `-${formatTime(Math.max(0, length - position))}`;
    }

    // Tick the progress bar only while it can be seen and is moving.
    _syncTicking() {
        const needed = this.mapped && this._player?.status === Status.PLAYING;
        if (needed && !this._tickId) {
            this._ticks = 0;
            this._tickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PROGRESS_TICK_MS, () => {
                if (++this._ticks % POSITION_RESYNC_TICKS === 0)
                    this._player?.refreshPosition();
                this._syncProgress();
                return GLib.SOURCE_CONTINUE;
            });
        } else if (!needed) {
            this._stopTicking();
        }
    }

    _stopTicking() {
        if (this._tickId) {
            GLib.source_remove(this._tickId);
            this._tickId = 0;
        }
    }
});

export class MediaModule extends EventEmitter {
    /**
     * @param {Gio.Settings} settings
     * @param {string} cacheDir - for downloaded album art
     * @param {string} extensionPath - where the icons/ folder is
     */
    constructor(settings, cacheDir, extensionPath) {
        super();
        this._settings = settings;
        this._art = new ArtLoader(cacheDir);
        this._artState = {url: null, uri: null, color: DEFAULT_ACCENT};
        this._graceId = 0;
        this._inGrace = false;

        this.activityStart = new AlbumArt({style_class: 'notch-art-thumb'});
        this.activityEnd = new Visualizer(settings);
        this.body = new MediaView(settings, extensionPath);
        this.body.connect('busy-changed', () => this.emit('changed'));

        this._watcher = new MprisWatcher();
        this._watcher.connectObject('changed', () => this._sync(), this);
        this._settings.connectObject('changed::media-activity', () => this.emit('changed'), this);
    }

    get player() {
        return this._watcher.active;
    }

    get hasActivity() {
        if (!this._settings.get_boolean('media-activity') || !this.player)
            return false;
        return this.player.status === Status.PLAYING || this._inGrace;
    }

    get busy() {
        return this.body.dragging;
    }

    _sync() {
        const {player} = this;
        const playing = player?.status === Status.PLAYING;
        this._syncGrace(playing, !!player);
        this._loadArt(player?.track.artUrl ?? '');

        this.activityStart.setArt(this._artState.uri, player?.app?.get_icon());
        this.activityEnd.setColor(this._artState.color);
        this.activityEnd.setPlaying(playing);
        this.body.update(player, this._artState);
        this.emit('changed');
    }

    _syncGrace(playing, hasPlayer) {
        if (playing || !hasPlayer) {
            this._clearGrace();
            this._wasPlaying = playing;
            return;
        }
        if (this._wasPlaying && !this._graceId) {
            this._inGrace = true;
            this._graceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PAUSE_GRACE_MS, () => {
                this._graceId = 0;
                this._inGrace = false;
                this.emit('changed');
                return GLib.SOURCE_REMOVE;
            });
        }
        this._wasPlaying = false;
    }

    _clearGrace() {
        if (this._graceId) {
            GLib.source_remove(this._graceId);
            this._graceId = 0;
        }
        this._inGrace = false;
    }

    // Loads art for the current track; ignores results that arrive after the
    // track has changed again.
    _loadArt(url) {
        if (url === this._artState.url)
            return;
        this._artState = {url, uri: null, color: DEFAULT_ACCENT};
        if (!url)
            return;

        (async () => {
            const uri = await this._art.resolve(url);
            if (this._artState.url !== url || !uri)
                return;
            this._artState = {...this._artState, uri};
            this._sync();

            const color = await this._art.accentColor(uri);
            if (this._artState.url !== url)
                return;
            this._artState = {...this._artState, color};
            this._sync();
        })().catch(e => {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.debug(`notch: no album art for ${url}: ${e.message}`);
        });
    }

    destroy() {
        this._clearGrace();
        this._watcher.disconnectObject(this);
        this._watcher.destroy();
        this._settings.disconnectObject(this);
        this._art.destroy();
        this.activityStart.destroy();
        this.activityEnd.destroy();
        this.body.destroy();
    }
}
