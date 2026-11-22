// A small MPRIS client: finds media players on the session bus, tracks the
// one the user most likely cares about, and exposes its track, status and an
// extrapolated playback position.
//
// Modelled on the shell's own ui/mpris.js, which can't be reused here: it
// doesn't track position or seeking, and it has no way to tear down its bus
// subscriptions when the extension is disabled.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';

const MPRIS_PREFIX = 'org.mpris.MediaPlayer2';
const MPRIS_PATH = '/org/mpris/MediaPlayer2';
const PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';
const NO_TRACK = '/org/mpris/MediaPlayer2/TrackList/NoTrack';

// playerctld re-exports whichever player is active, so listing it would
// show every player twice.
const IGNORED_NAMES = new Set([`${MPRIS_PREFIX}.playerctld`]);

const MprisProxy = Gio.DBusProxy.makeProxyWrapper(`
<node>
  <interface name="org.mpris.MediaPlayer2">
    <method name="Raise"/>
    <property name="CanRaise" type="b" access="read"/>
    <property name="Identity" type="s" access="read"/>
    <property name="DesktopEntry" type="s" access="read"/>
  </interface>
</node>`);

const PlayerProxy = Gio.DBusProxy.makeProxyWrapper(`
<node>
  <interface name="org.mpris.MediaPlayer2.Player">
    <method name="PlayPause"/>
    <method name="Next"/>
    <method name="Previous"/>
    <method name="Seek">
      <arg direction="in" type="x" name="Offset"/>
    </method>
    <method name="SetPosition">
      <arg direction="in" type="o" name="TrackId"/>
      <arg direction="in" type="x" name="Position"/>
    </method>
    <signal name="Seeked">
      <arg type="x" name="Position"/>
    </signal>
    <property name="PlaybackStatus" type="s" access="read"/>
    <property name="Metadata" type="a{sv}" access="read"/>
    <property name="Rate" type="d" access="read"/>
    <property name="CanGoNext" type="b" access="read"/>
    <property name="CanGoPrevious" type="b" access="read"/>
    <property name="CanPlay" type="b" access="read"/>
    <property name="CanSeek" type="b" access="read"/>
  </interface>
</node>`);

export const Status = Object.freeze({
    PLAYING: 'Playing',
    PAUSED: 'Paused',
    STOPPED: 'Stopped',
});

function newProxy(Wrapper, busName, cancellable) {
    return new Promise((resolve, reject) => {
        // eslint-disable-next-line no-new
        new Wrapper(Gio.DBus.session, busName, MPRIS_PATH, (proxy, error) => {
            if (error)
                reject(error);
            else
                resolve(proxy);
        }, cancellable);
    });
}

function isCancelled(error) {
    return error instanceof GLib.Error &&
        error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

// Players send all sorts of malformed metadata, so validate everything:
// https://www.freedesktop.org/wiki/Specifications/mpris-spec/metadata
function parseMetadata(raw) {
    const md = {};
    for (const [key, value] of Object.entries(raw ?? {}))
        md[key] = value instanceof GLib.Variant ? value.recursiveUnpack() : value;

    const str = v => (typeof v === 'string' ? v : '');
    let artists = md['xesam:artist'];
    if (typeof artists === 'string')
        artists = [artists];
    if (!Array.isArray(artists))
        artists = [];

    const length = Number(md['mpris:length']);
    return {
        id: str(md['mpris:trackid']),
        title: str(md['xesam:title']),
        artists: artists.filter(a => typeof a === 'string' && a),
        album: str(md['xesam:album']),
        artUrl: str(md['mpris:artUrl']),
        length: Number.isFinite(length) && length > 0 ? length : 0, // µs
    };
}

export class MprisPlayer extends EventEmitter {
    constructor(busName) {
        super();
        this.busName = busName;
        this.ready = false;
        this.status = Status.STOPPED;
        this.track = parseMetadata({});
        this.app = null;
        this.identity = '';
        // Monotonic time this player last started playing; used to pick the
        // player the user most recently interacted with.
        this.lastActive = 0;

        this._positionBase = 0; // µs, as of _positionTime
        this._positionTime = GLib.get_monotonic_time();
        this._cancellable = new Gio.Cancellable();

        this._init().catch(e => {
            if (!isCancelled(e))
                console.warn(`notch: ignoring MPRIS player ${busName}: ${e.message}`);
        });
    }

    async _init() {
        const proxies = await Promise.all([
            newProxy(MprisProxy, this.busName, this._cancellable),
            newProxy(PlayerProxy, this.busName, this._cancellable),
        ]);
        if (this._cancellable.is_cancelled())
            return;
        [this._mpris, this._player] = proxies;

        this._player.connectObject('g-properties-changed', () => this._sync(), this);
        this._mpris.connectObject('g-properties-changed', () => this._syncApp(), this);
        this._seekedId = this._player.connectSignal('Seeked',
            (_proxy, _sender, [position]) => this._setPosition(position));

        this._syncApp();
        this.ready = true;
        this._sync();
    }

    get canPlay() {
        return !!this._player?.CanPlay;
    }

    get canGoNext() {
        return !!this._player?.CanGoNext;
    }

    get canGoPrevious() {
        return !!this._player?.CanGoPrevious;
    }

    get canSeek() {
        return !!this._player?.CanSeek && this.track.length > 0;
    }

    get rate() {
        const rate = this._player?.Rate;
        return typeof rate === 'number' && rate > 0 ? rate : 1;
    }

    // Players don't announce position changes (only jumps, via Seeked), so
    // the position is extrapolated from the last known value.
    get position() {
        let position = this._positionBase;
        if (this.status === Status.PLAYING)
            position += (GLib.get_monotonic_time() - this._positionTime) * this.rate;
        if (this.track.length > 0)
            position = Math.min(position, this.track.length);
        return Math.max(0, position);
    }

    _setPosition(position) {
        this._positionBase = position;
        this._positionTime = GLib.get_monotonic_time();
        this.emit('changed');
    }

    async refreshPosition() {
        if (!this.ready)
            return;
        try {
            const reply = await Gio.DBus.session.call(this.busName, MPRIS_PATH,
                'org.freedesktop.DBus.Properties', 'Get',
                new GLib.Variant('(ss)', [PLAYER_IFACE, 'Position']),
                new GLib.VariantType('(v)'), Gio.DBusCallFlags.NONE, 2000,
                this._cancellable);
            const [position] = reply.recursiveUnpack();
            if (Number.isFinite(position))
                this._setPosition(position);
        } catch (e) {
            // Some players don't implement Position; extrapolation still works.
        }
    }

    _sync() {
        const status = Object.values(Status).includes(this._player.PlaybackStatus)
            ? this._player.PlaybackStatus : Status.STOPPED;
        const track = parseMetadata(this._player.Metadata);
        const trackChanged = track.id !== this.track.id || track.title !== this.track.title;
        const statusChanged = status !== this.status;

        if (statusChanged) {
            // Freeze or restart the extrapolation at the moment of change.
            this._positionBase = this.position;
            this._positionTime = GLib.get_monotonic_time();
            if (status === Status.PLAYING)
                this.lastActive = this._positionTime;
        }
        if (trackChanged) {
            this._positionBase = 0;
            this._positionTime = GLib.get_monotonic_time();
        }

        this.status = status;
        this.track = track;
        this.emit('changed');

        if (statusChanged || trackChanged)
            this.refreshPosition();
    }

    _syncApp() {
        const entry = this._mpris.DesktopEntry;
        this.app = entry
            ? Shell.AppSystem.get_default().lookup_app(`${entry}.desktop`)
            : null;
        this.identity = this.app?.get_name() ?? this._mpris.Identity ?? '';
        if (this.ready)
            this.emit('changed');
    }

    playPause() {
        this._player?.PlayPauseAsync().catch(logIgnored);
    }

    next() {
        this._player?.NextAsync().catch(logIgnored);
    }

    previous() {
        this._player?.PreviousAsync().catch(logIgnored);
    }

    seekTo(position) {
        if (!this.canSeek)
            return;
        position = Math.round(Math.max(0, Math.min(position, this.track.length)));

        const {id} = this.track;
        if (id && id !== NO_TRACK && GLib.Variant.is_object_path(id)) {
            this._player.SetPositionAsync(id, position).catch(logIgnored);
        } else {
            this._player.SeekAsync(Math.round(position - this.position))
                .catch(logIgnored);
        }
        // Show the new position right away; Seeked will confirm it.
        this._setPosition(position);
    }

    raise() {
        // Raise() over D-Bus can trip focus-stealing prevention, so prefer
        // activating the app, like the shell does.
        if (this.app)
            this.app.activate();
        else if (this._mpris?.CanRaise)
            this._mpris.RaiseAsync().catch(logIgnored);
    }

    destroy() {
        this._cancellable.cancel();
        if (this._seekedId)
            this._player.disconnectSignal(this._seekedId);
        this._player?.disconnectObject(this);
        this._mpris?.disconnectObject(this);
        this._player = this._mpris = null;
        this.ready = false;
    }
}

function logIgnored(e) {
    console.debug(`notch: MPRIS call failed: ${e.message}`);
}

// Watches the bus for players and keeps `active` pointed at the best one:
// the most recently started player that is playing, otherwise the current
// one while it remains (so pausing doesn't switch players), otherwise
// whichever played last.
//
// Signals: 'changed' when the active player or its state changes.
export class MprisWatcher extends EventEmitter {
    constructor() {
        super();
        this.active = null;
        this._players = new Map();
        this._cancellable = new Gio.Cancellable();

        this._nameOwnerId = Gio.DBus.session.signal_subscribe(
            'org.freedesktop.DBus', 'org.freedesktop.DBus', 'NameOwnerChanged',
            '/org/freedesktop/DBus', MPRIS_PREFIX,
            Gio.DBusSignalFlags.MATCH_ARG0_NAMESPACE,
            (_conn, _sender, _path, _iface, _signal, params) => {
                const [name, oldOwner, newOwner] = params.deepUnpack();
                if (oldOwner)
                    this._remove(name);
                if (newOwner)
                    this._add(name);
            });

        this._listPlayers().catch(e => {
            if (!isCancelled(e))
                console.warn(`notch: could not list MPRIS players: ${e.message}`);
        });
    }

    async _listPlayers() {
        const reply = await Gio.DBus.session.call('org.freedesktop.DBus',
            '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'ListNames', null,
            new GLib.VariantType('(as)'), Gio.DBusCallFlags.NONE, -1,
            this._cancellable);
        const [names] = reply.deepUnpack();
        names.filter(n => n.startsWith(`${MPRIS_PREFIX}.`)).forEach(n => this._add(n));
    }

    _add(name) {
        if (this._players.has(name) || IGNORED_NAMES.has(name))
            return;
        const player = new MprisPlayer(name);
        player.connectObject('changed', () => this._update(player), this);
        this._players.set(name, player);
    }

    _remove(name) {
        const player = this._players.get(name);
        if (!player)
            return;
        this._players.delete(name);
        player.disconnectObject(this);
        player.destroy();
        this._update(player);
    }

    _update(changedPlayer) {
        const candidates = [...this._players.values()].filter(p =>
            p.ready && p.canPlay && (p.status !== Status.STOPPED || p.track.title));
        const byRecency = (a, b) => b.lastActive - a.lastActive;

        const playing = candidates.filter(p => p.status === Status.PLAYING).sort(byRecency);
        const next = playing[0] ??
            (candidates.includes(this.active) ? this.active : null) ??
            candidates.sort(byRecency)[0] ??
            null;

        if (next !== this.active || changedPlayer === this.active) {
            this.active = next;
            this.emit('changed');
        }
    }

    destroy() {
        this._cancellable.cancel();
        Gio.DBus.session.signal_unsubscribe(this._nameOwnerId);
        for (const player of this._players.values()) {
            player.disconnectObject(this);
            player.destroy();
        }
        this._players.clear();
        this.active = null;
    }
}
