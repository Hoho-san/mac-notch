// A fake MPRIS media player for the headless test. Track 1's art is a local
// file, track 2's is served over HTTP from here, so both art paths get
// exercised. Every control call is printed to stdout for drive.js to check.
//
// usage: gjs -m fake-player.js WORK_DIR
import Cairo from 'cairo';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

const [WORK_DIR] = ARGV;
const BUS_NAME = 'org.mpris.MediaPlayer2.notchtest';
const PATH = '/org/mpris/MediaPlayer2';

const log = line => print(line);

function makeCover(file, [r1, g1, b1], [r2, g2, b2]) {
    const size = 256;
    const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, size, size);
    const cr = new Cairo.Context(surface);
    const gradient = new Cairo.LinearGradient(0, 0, size, size);
    gradient.addColorStopRGB(0, r1, g1, b1);
    gradient.addColorStopRGB(1, r2, g2, b2);
    cr.setSource(gradient);
    cr.paint();
    cr.setSourceRGBA(1, 1, 1, 0.85);
    cr.arc(size / 2, size / 2, size / 5, 0, 2 * Math.PI);
    cr.fill();
    surface.writeToPNG(file);
    cr.$dispose();
}

GLib.mkdir_with_parents(WORK_DIR, 0o700);
const cover1 = `${WORK_DIR}/cover1.png`;
const cover2 = `${WORK_DIR}/cover2.png`;
makeCover(cover1, [1.0, 0.31, 0.55], [0.42, 0.24, 1.0]);
makeCover(cover2, [0.05, 0.75, 0.7], [0.95, 0.85, 0.2]);

// Serve cover 2 over HTTP to exercise the download path.
const server = new Soup.Server();
const cover2Bytes = GLib.file_get_contents(cover2)[1];
server.add_handler('/', (_server, msg, path) => {
    log(`HTTP GET ${path}`);
    msg.set_status(200, null);
    msg.set_response('image/png', Soup.MemoryUse.COPY, cover2Bytes);
});
server.listen_local(0, Soup.ServerListenOptions.IPV4_ONLY);
const port = server.get_uris()[0].get_port();

const TRACKS = [
    {
        id: '/org/notch/track/1', title: 'Neon Harbor', artists: ['The Test Pattern'],
        album: 'Signals', length: 215e6, art: GLib.filename_to_uri(cover1, null),
    },
    {
        id: '/org/notch/track/2', title: 'Paper Satellites', artists: ['Quiet Machines', 'Ana V'],
        album: 'Orbit', length: 187e6, art: `http://127.0.0.1:${port}/cover2.png`,
    },
];

const ROOT_XML = `<node><interface name="org.mpris.MediaPlayer2">
  <method name="Raise"/><method name="Quit"/>
  <property name="CanRaise" type="b" access="read"/>
  <property name="CanQuit" type="b" access="read"/>
  <property name="Identity" type="s" access="read"/>
  <property name="DesktopEntry" type="s" access="read"/>
</interface></node>`;

const PLAYER_XML = `<node><interface name="org.mpris.MediaPlayer2.Player">
  <method name="PlayPause"/><method name="Play"/><method name="Pause"/>
  <method name="Next"/><method name="Previous"/>
  <method name="Seek"><arg direction="in" type="x" name="Offset"/></method>
  <method name="SetPosition">
    <arg direction="in" type="o" name="TrackId"/><arg direction="in" type="x" name="Position"/>
  </method>
  <signal name="Seeked"><arg type="x" name="Position"/></signal>
  <property name="PlaybackStatus" type="s" access="read"/>
  <property name="Metadata" type="a{sv}" access="read"/>
  <property name="Position" type="x" access="read"/>
  <property name="Rate" type="d" access="read"/>
  <property name="CanGoNext" type="b" access="read"/>
  <property name="CanGoPrevious" type="b" access="read"/>
  <property name="CanPlay" type="b" access="read"/>
  <property name="CanPause" type="b" access="read"/>
  <property name="CanSeek" type="b" access="read"/>
  <property name="CanControl" type="b" access="read"/>
</interface></node>`;

class Player {
    constructor() {
        this._index = 0;
        this._status = 'Playing';
        this._base = 42e6;
        this._since = GLib.get_monotonic_time();
    }

    get _track() {
        return TRACKS[this._index];
    }

    get _position() {
        const elapsed = this._status === 'Playing' ? GLib.get_monotonic_time() - this._since : 0;
        return Math.min(this._base + elapsed, this._track.length);
    }

    _setPosition(position) {
        this._base = position;
        this._since = GLib.get_monotonic_time();
    }

    _changed(names) {
        const values = {
            PlaybackStatus: () => new GLib.Variant('s', this.PlaybackStatus),
            Metadata: () => new GLib.Variant('a{sv}', this.Metadata),
        };
        for (const name of names)
            this.dbus.emit_property_changed(name, values[name]());
        this.dbus.flush();
    }

    get PlaybackStatus() {
        return this._status;
    }

    get Metadata() {
        const t = this._track;
        return {
            'mpris:trackid': new GLib.Variant('o', t.id),
            'xesam:title': new GLib.Variant('s', t.title),
            'xesam:artist': new GLib.Variant('as', t.artists),
            'xesam:album': new GLib.Variant('s', t.album),
            'mpris:length': new GLib.Variant('x', t.length),
            'mpris:artUrl': new GLib.Variant('s', t.art),
        };
    }

    get Position() {
        return this._position;
    }

    get Rate() {
        return 1;
    }

    get CanGoNext() {
        return true;
    }

    get CanGoPrevious() {
        return true;
    }

    get CanPlay() {
        return true;
    }

    get CanPause() {
        return true;
    }

    get CanSeek() {
        return true;
    }

    get CanControl() {
        return true;
    }

    PlayPause() {
        log('CALL PlayPause');
        this._setPosition(this._position);
        this._status = this._status === 'Playing' ? 'Paused' : 'Playing';
        this._changed(['PlaybackStatus']);
    }

    Play() {
        log('CALL Play');
        this._setPosition(this._position);
        this._status = 'Playing';
        this._changed(['PlaybackStatus']);
    }

    Pause() {
        log('CALL Pause');
        this._setPosition(this._position);
        this._status = 'Paused';
        this._changed(['PlaybackStatus']);
    }

    Next() {
        log('CALL Next');
        this._index = (this._index + 1) % TRACKS.length;
        this._setPosition(0);
        this._changed(['Metadata']);
    }

    Previous() {
        log('CALL Previous');
        this._index = (this._index + TRACKS.length - 1) % TRACKS.length;
        this._setPosition(0);
        this._changed(['Metadata']);
    }

    Seek(offset) {
        log(`CALL Seek ${offset}`);
        this._setPosition(Math.max(0, this._position + offset));
        this.dbus.emit_signal('Seeked', new GLib.Variant('(x)', [this._position]));
    }

    SetPosition(trackId, position) {
        log(`CALL SetPosition ${trackId} ${Math.round(position / 1e6)}s`);
        if (trackId !== this._track.id)
            return;
        this._setPosition(position);
        this.dbus.emit_signal('Seeked', new GLib.Variant('(x)', [position]));
    }
}

const root = {
    Raise: () => log('CALL Raise'),
    Quit: () => loop.quit(),
    CanRaise: true,
    CanQuit: true,
    Identity: 'Notch Test Player',
    DesktopEntry: '',
};

const player = new Player();
const rootExport = Gio.DBusExportedObject.wrapJSObject(ROOT_XML, root);
player.dbus = Gio.DBusExportedObject.wrapJSObject(PLAYER_XML, player);
rootExport.export(Gio.DBus.session, PATH);
player.dbus.export(Gio.DBus.session, PATH);

const loop = new GLib.MainLoop(null, false);
Gio.bus_own_name_on_connection(Gio.DBus.session, BUS_NAME, Gio.BusNameOwnerFlags.NONE,
    () => log('READY'), () => {
        log('LOST NAME');
        loop.quit();
    });
loop.run();
