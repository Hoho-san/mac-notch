// Drives the headless shell started by headless-test.sh: moves the pointer
// with Mutter's RemoteDesktop API, captures the screen with the Shell's
// Screenshot API, and runs helpers (a fake music player, a full-screen
// window) next to it. Only ever run inside that script's private D-Bus
// session.
//
// usage: gjs -m drive.js OUT_DIR UUID
//   NOTCH_SCENARIO  full (default) | multimonitor | perf | stacking | volume |
//                   clipboard | git
//   NOTCH_MONITORS  the virtual monitor sizes, first is primary
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

const [OUT, UUID] = ARGV;
const DEV_DIR = GLib.path_get_dirname(System.programPath);
const SCENARIO = GLib.getenv('NOTCH_SCENARIO') ?? 'full';
// Virtual monitors sit left to right from x = 0; the first is primary.
const MONITORS = (GLib.getenv('NOTCH_MONITORS') ?? '1920x1080').trim().split(/\s+/)
    .reduce((list, size) => {
        const [width, height] = size.split('x').map(Number);
        const x = list.reduce((sum, m) => sum + m.width, 0);
        return [...list, {x, y: 0, width, height}];
    }, []);
const SCREEN = MONITORS[0];
const NOTCH_AREA = {x: 960 - 320, y: 0, width: 640, height: 220};
// Where GNOME's own volume/brightness pop-up appears (bottom centre).
const osdArea = m => ({x: m.x + m.width / 2 - 300, y: m.height - 200, width: 600, height: 180});
const GNOME_OSD_AREA = osdArea(SCREEN);
// The clock text in the compact notch.
const CLOCK_AREA = {x: 900, y: 6, width: 120, height: 20};
// The top-bar band around the notch, where pop-up icons and levels appear.
const HEADER_AREA = {x: 760, y: 0, width: 400, height: 32};

// Where things are in the expanded notch at default settings (440px wide,
// 32px top bar). Check against 04-player.png if the layout changes.
const AT = {
    header: [960, 10],
    playPause: [960, 140],
    next: [1015, 140],
    progress75: [1038, 107],
    away: [1500, 700],
    // A notification shown in the notch.
    notification: [960, 75],
    notificationClose: [1150, 52],
    notificationAction: [840, 117],
    // GNOME's system menu (top right) and its volume slider, at about 40%.
    systemMenu: [1880, 16],
    volumeSlider: [1700, 120],
    // The two halves of dev/copy-helper.js's maximized window.
    copyText: [530, 556],
    copySecret: [1450, 556],
};

const bus = Gio.DBus.session;
const RD = 'org.gnome.Mutter.RemoteDesktop';
const SHELL = 'org.gnome.Shell';

function call(dest, path, iface, method, params = null, replyType = null) {
    return new Promise((resolve, reject) => {
        bus.call(dest, path, iface, method, params,
            replyType ? new GLib.VariantType(replyType) : null,
            Gio.DBusCallFlags.NONE, -1, null, (conn, res) => {
                try {
                    resolve(conn.call_finish(res).deepUnpack());
                } catch (e) {
                    reject(e);
                }
            });
    });
}

const sleep = ms => new Promise(resolve => {
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    });
});

async function waitForName(name, timeoutMs = 30000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const [has] = await call('org.freedesktop.DBus', '/org/freedesktop/DBus',
            'org.freedesktop.DBus', 'NameHasOwner', new GLib.Variant('(s)', [name]), '(b)');
        if (has)
            return;
        await sleep(250);
    }
    throw new Error(`timed out waiting for ${name}`);
}

// The Screenshot API only answers a short allow-list of bus names. Nothing
// else owns this one on the private bus, so we borrow it.
function ownScreenshotAllowedName() {
    return new Promise((resolve, reject) => {
        Gio.bus_own_name_on_connection(bus, 'org.gnome.SettingsDaemon.MediaKeys',
            Gio.BusNameOwnerFlags.NONE, () => resolve(),
            () => reject(new Error('could not own an allow-listed name')));
    });
}

async function screenshot(name, area = NOTCH_AREA) {
    const file = `${OUT}/${name}.png`;
    const iface = `${SHELL}.Screenshot`;
    const [ok] = area
        ? await call(iface, '/org/gnome/Shell/Screenshot', iface, 'ScreenshotArea',
            new GLib.Variant('(iiiibs)', [area.x, area.y, area.width, area.height, false, file]),
            '(bs)')
        : await call(iface, '/org/gnome/Shell/Screenshot', iface, 'Screenshot',
            new GLib.Variant('(bbs)', [true, false, file]), '(bs)');
    print(`${ok ? 'saved' : 'FAILED'} ${name}.png`);
}

class Input {
    async start() {
        [this._session] = await call(RD, '/org/gnome/Mutter/RemoteDesktop', RD,
            'CreateSession', null, '(o)');
        await this._call('Start');
        // Relative motion is clamped at the screen edges, so pinning the
        // pointer to the primary monitor's bottom-left corner (the leftmost
        // monitor) gives a known origin.
        await this._call('NotifyPointerMotionRelative', new GLib.Variant('(dd)', [-1e5, 1e5]));
        this._x = 0;
        this._y = SCREEN.height - 1;
    }

    _call(method, params = null) {
        return call(RD, this._session, `${RD}.Session`, method, params);
    }

    async moveTo([x, y]) {
        await this._call('NotifyPointerMotionRelative',
            new GLib.Variant('(dd)', [x - this._x, y - this._y]));
        this._x = x;
        this._y = y;
    }

    async press(pressed) {
        const BTN_LEFT = 0x110;
        await this._call('NotifyPointerButton', new GLib.Variant('(ib)', [BTN_LEFT, pressed]));
    }

    // A tiny move, so the session counts the user as active (notifications
    // wait for an idle user to come back before hiding, like GNOME's).
    async nudge() {
        const [x, y] = [this._x, this._y];
        await this.moveTo([x, y + 1]);
        await this.moveTo([x, y]);
    }

    async click(at) {
        if (at)
            await this.moveTo(at);
        await this.press(true);
        await sleep(60);
        await this.press(false);
        // Mutter can deliver a virtual move ahead of a release sent just
        // before it; a real hand never moves that fast after a click.
        await sleep(80);
    }

    // Presses keys in order and releases them in reverse, e.g. Alt+F2.
    async combo(...keysyms) {
        for (const keysym of keysyms)
            await this._call('NotifyKeyboardKeysym', new GLib.Variant('(ub)', [keysym, true]));
        await sleep(40);
        for (const keysym of keysyms.reverse())
            await this._call('NotifyKeyboardKeysym', new GLib.Variant('(ub)', [keysym, false]));
    }

    // Types plain ASCII text (letters, digits, spaces).
    async type(text) {
        for (const char of text)
            await this.key(char.charCodeAt(0));
    }

    async key(keysym) {
        await this._call('NotifyKeyboardKeysym', new GLib.Variant('(ub)', [keysym, true]));
        await sleep(40);
        await this._call('NotifyKeyboardKeysym', new GLib.Variant('(ub)', [keysym, false]));
    }

    async stop() {
        await this._call('Stop').catch(() => {});
    }
}

// Runs a helper script from dev/ and collects what it prints.
class Helper {
    constructor(script, args = [], env = {}) {
        this.lines = [];
        this._name = script.replace(/\.js$/, '');
        const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.STDOUT_PIPE});
        for (const [key, value] of Object.entries(env))
            launcher.setenv(key, value, true);
        this._proc = launcher.spawnv(['gjs', '-m', `${DEV_DIR}/${script}`, ...args]);
        this._stdout = new Gio.DataInputStream({base_stream: this._proc.get_stdout_pipe()});
        this._readLines();
    }

    _readLines() {
        this._stdout.read_line_async(GLib.PRIORITY_DEFAULT, null, (stream, res) => {
            const [line] = stream.read_line_finish_utf8(res);
            if (line === null)
                return;
            this.lines.push(line);
            print(`  [${this._name}] ${line}`);
            this._readLines();
        });
    }

    async ready() {
        for (let i = 0; i < 50 && !this.lines.includes('READY'); i++)
            await sleep(100);
        if (!this.lines.includes('READY'))
            throw new Error(`${this._name} never became ready`);
    }

    count(prefix) {
        return this.lines.filter(l => l.startsWith(prefix)).length;
    }

    quit() {
        this._proc.send_signal(15);
    }
}

const fakePlayer = () => new Helper('fake-player.js', [`${OUT}/fake-player`]);

// The shell's own OSD entry point, the one gnome-settings-daemon uses.
async function showOsd({icon, label, level, maxLevel}) {
    const params = {icon: new GLib.Variant('s', icon)};
    if (label !== undefined)
        params.label = new GLib.Variant('s', label);
    if (level !== undefined)
        params.level = new GLib.Variant('d', level);
    if (maxLevel !== undefined)
        params.max_level = new GLib.Variant('d', maxLevel);
    await call(SHELL, '/org/gnome/Shell', SHELL, 'ShowOSD',
        new GLib.Variant('(a{sv})', [params]));
}

// Fraction of pixels that differ noticeably between two same-sized shots.
function changedFraction(fileA, fileB) {
    const a = GdkPixbuf.Pixbuf.new_from_file(`${OUT}/${fileA}.png`);
    const b = GdkPixbuf.Pixbuf.new_from_file(`${OUT}/${fileB}.png`);
    const pa = a.get_pixels(), pb = b.get_pixels();
    const n = a.get_n_channels();
    let changed = 0;
    for (let y = 0; y < a.height; y++) {
        for (let x = 0; x < a.width; x++) {
            const i = y * a.rowstride + x * n;
            if (Math.abs(pa[i] - pb[i]) + Math.abs(pa[i + 1] - pb[i + 1]) +
                Math.abs(pa[i + 2] - pb[i + 2]) > 60)
                changed++;
        }
    }
    return changed / (a.width * a.height);
}

const gnomeOsdShown = (baseline, shot) => changedFraction(baseline, shot) > 0.02;

// Mean brightness (0-255) of a screenshot.
function brightness(file) {
    const image = GdkPixbuf.Pixbuf.new_from_file(`${OUT}/${file}.png`);
    const pixels = image.get_pixels();
    const n = image.get_n_channels();
    let sum = 0;
    for (let y = 0; y < image.height; y++) {
        for (let x = 0; x < image.width; x++) {
            const i = y * image.rowstride + x * n;
            sum += (pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3;
        }
    }
    return sum / (image.width * image.height);
}

// How wide the black pill is in a HEADER_AREA shot, measured along a row
// below the text (the top bar around it is dark grey, not black).
function pillWidth(file) {
    const image = GdkPixbuf.Pixbuf.new_from_file(`${OUT}/${file}.png`);
    const pixels = image.get_pixels();
    const n = image.get_n_channels();
    const y = image.height - 4;
    let black = 0;
    for (let x = 0; x < image.width; x++) {
        const i = y * image.rowstride + x * n;
        if (pixels[i] < 8 && pixels[i + 1] < 8 && pixels[i + 2] < 8)
            black++;
    }
    return black;
}

// CPU time (seconds) the shell process has used so far.
function shellCpuSeconds() {
    const pid = GLib.getenv('NOTCH_SHELL_PID');
    const stat = new TextDecoder().decode(GLib.file_get_contents(`/proc/${pid}/stat`)[1]);
    // Fields after "pid (comm) ": state is field 3, utime 14, stime 15.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const CLOCK_TICKS = 100;
    return (Number(fields[11]) + Number(fields[12])) / CLOCK_TICKS;
}

function gsettings(...args) {
    const proc = Gio.Subprocess.new(['gsettings', '--schemadir',
        `${DEV_DIR}/../${UUID}/schemas`, ...args], Gio.SubprocessFlags.NONE);
    proc.wait(null);
}

// Talks to the shell's notification daemon like an app would, and records
// what it hears back.
class NotificationClient {
    constructor() {
        this.events = [];
        const iface = 'org.freedesktop.Notifications';
        this._id = bus.signal_subscribe(null, iface, null, '/org/freedesktop/Notifications',
            null, Gio.DBusSignalFlags.NONE, (_c, _sender, _path, _iface, signal, params) => {
                const args = params.deepUnpack();
                this.events.push({signal, args});
                print(`  [notifications] ${signal} ${JSON.stringify(args)}`);
            });
    }

    async notify(summary, {body = '', icon = 'mail-unread-symbolic', actions = [],
        urgency, transient} = {}) {
        const hints = {};
        if (urgency !== undefined)
            hints.urgency = new GLib.Variant('y', urgency);
        if (transient)
            hints.transient = new GLib.Variant('b', true);
        const iface = 'org.freedesktop.Notifications';
        const [id] = await call(iface, '/org/freedesktop/Notifications', iface, 'Notify',
            new GLib.Variant('(susssasa{sv}i)',
                ['Notch Test', 0, icon, summary, body, actions, hints, -1]), '(u)');
        return id;
    }

    invoked(id, action) {
        return this.events.some(e => e.signal === 'ActionInvoked' &&
            e.args[0] === id && e.args[1] === action);
    }

    // 1 expired, 2 dismissed by the user
    closed(id, reason) {
        return this.events.some(e => e.signal === 'NotificationClosed' &&
            e.args[0] === id && (reason === undefined || e.args[1] === reason));
    }
}

async function setBattery(state, percentage) {
    await call('org.freedesktop.UPower', '/org/freedesktop/UPower/devices/DisplayDevice',
        'dev.notch.FakeUPower', 'Set', new GLib.Variant('(ud)', [state, percentage]));
}

// A throwaway repo (notch-demo) with a bare "remote", and git run in a
// terminal (a pty from script(1)) reporting to the shell under test. It has
// its own git config, so ~/.gitconfig plays no part.
class GitSandbox {
    constructor() {
        this.dir = GLib.dir_make_tmp('notch-git-XXXXXX');
        this.repo = `${this.dir}/notch-demo`;
        this._config = `${this.dir}/gitconfig`;
        GLib.file_set_contents(this._config, [
            '[user]', 'name = Notch Test', 'email = test@example.com',
            '[init]', 'defaultBranch = main',
            '[maintenance]', 'auto = false',
            '[gc]', 'auto = 0',
        ].join('\n'));
    }

    async setup() {
        await this.sh(`git init -q --bare ../remote.git && git init -q . &&
            git remote add origin ../remote.git &&
            printf '# Notch demo\\n' > README.md && git add . && git commit -qm init &&
            git push -q -u origin main &&
            git checkout -qb other && printf 'theirs\\n' > conflict.txt &&
            git add . && git commit -qm theirs && git checkout -q main`, {cwd: null});
    }

    // A shell command, with git not reporting to the notch (setup).
    sh(command, {cwd = this.repo} = {}) {
        if (cwd === null) {
            GLib.mkdir_with_parents(this.repo, 0o755);
            cwd = this.repo;
        }
        return this._spawn(['sh', '-c', command], {cwd, trace: false});
    }

    // A git command typed at a shell prompt in a terminal; resolves to its
    // exit status. The trailing exit keeps bash from exec'ing a lone git
    // command, so bash is its parent, as at a real prompt.
    run(command, env = {}) {
        return this._spawn(['script', '-qec', `${command}; exit $?`, '/dev/null'], {env});
    }

    // The same, run by a program with no terminal (as an IDE would).
    runDetached(...args) {
        return this._spawn(['git', ...args]);
    }

    hook(name, body) {
        const file = `${this.repo}/.git/hooks/${name}`;
        if (body === null)
            return this.sh(`rm -f ${file}`);
        return this.sh(`printf '#!/bin/sh\\n%s\\n' '${body}' > ${file} && chmod +x ${file}`);
    }

    write(name, text) {
        GLib.file_set_contents(`${this.repo}/${name}`, text);
    }

    _spawn(argv, {cwd = this.repo, trace = true, env = {}} = {}) {
        const launcher = new Gio.SubprocessLauncher({
            flags: Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE,
        });
        launcher.set_stdin_file_path('/dev/null');
        launcher.set_cwd(cwd);
        launcher.setenv('GIT_CONFIG_GLOBAL', this._config, true);
        launcher.setenv('GIT_CONFIG_NOSYSTEM', '1', true);
        launcher.setenv('GIT_EDITOR', 'true', true);
        // What an interactive terminal would run git from.
        launcher.setenv('SHELL', '/bin/bash', true);
        if (trace) {
            launcher.setenv('GIT_TRACE2_EVENT',
                `af_unix:stream:${GLib.get_user_runtime_dir()}/notch-git.sock`, true);
        } else {
            launcher.unsetenv('GIT_TRACE2_EVENT');
        }
        for (const [key, value] of Object.entries(env))
            launcher.setenv(key, value, true);
        const proc = launcher.spawnv(argv);
        return new Promise(resolve => {
            proc.wait_async(null, (p, res) => {
                p.wait_finish(res);
                resolve(p.get_exit_status());
            });
        });
    }

    remove() {
        return this._spawn(['rm', '-rf', this.dir], {cwd: '/', trace: false});
    }
}

const XK_Escape = 0xff1b;
const XK_Alt_L = 0xffe9;
const XK_F2 = 0xffbf;
const XK_Print = 0xff61;
const XK_Control_L = 0xffe3;

async function extensionReport() {
    const ext = `${SHELL}.Extensions`;
    const [info] = await call(SHELL, '/org/gnome/Shell', ext, 'GetExtensionInfo',
        new GLib.Variant('(s)', [UUID]), '(a{sv})');
    const [errors] = await call(SHELL, '/org/gnome/Shell', ext, 'GetExtensionErrors',
        new GLib.Variant('(s)', [UUID]), '(as)');
    // ExtensionState: 1 enabled (ACTIVE), 2 disabled (INACTIVE), 3 error
    return {state: info.state?.deepUnpack(), errors};
}

async function setEnabled(enabled) {
    await call(SHELL, '/org/gnome/Shell', `${SHELL}.Extensions`,
        enabled ? 'EnableExtension' : 'DisableExtension',
        new GLib.Variant('(s)', [UUID]), '(b)');
}

const failures = [];
function check(what, ok, detail = '') {
    print(`${ok ? 'PASS' : 'FAIL'} ${what}${!ok && detail ? ` (${detail})` : ''}`);
    if (!ok)
        failures.push(what);
}

async function main() {
    await waitForName(`${SHELL}.Screenshot`);
    await waitForName(RD);
    await ownScreenshotAllowedName();
    await sleep(3000); // startup animation

    let report = await extensionReport();
    check('extension active after startup', report.state === 1 && !report.errors.length);

    const input = new Input();
    await input.start();
    await input.key(XK_Escape); // leave the startup overview, if any
    await sleep(1000);

    const scenarios = {
        full: fullScenario,
        multimonitor: multiMonitorScenario,
        perf: perfScenario,
        stacking: stackingChecks,
        volume: volumeSliderCheck,
        clipboard: clipboardChecks,
        git: gitChecks,
    };
    await scenarios[SCENARIO](input);
    await input.stop();
}

async function fullScenario(input) {
    let report;

    // Phase 1: no player
    await screenshot('01-compact');
    await input.moveTo(AT.header);
    await sleep(120 + 110); // hover delay + a few frames of the spring
    await screenshot('02-opening');
    await sleep(900);
    await screenshot('03-expanded-empty');
    await input.moveTo(AT.away);
    await sleep(1000);

    // Phase 2: music
    const player = fakePlayer();
    await player.ready();
    await sleep(1500);
    await screenshot('04-activity');
    await screenshot('04-activity-full', null);

    await input.moveTo(AT.header);
    await sleep(1200);
    await screenshot('05-player');
    await screenshot('05-player-full', null);

    await input.click(AT.playPause);
    await sleep(700);
    await screenshot('06-paused');
    check('play/pause button reaches the player', player.count('CALL PlayPause') === 1);

    await input.click(AT.playPause);
    await sleep(300);
    await input.click(AT.next);
    await sleep(1500); // HTTP art download + colour
    await screenshot('07-next-track');
    check('next button reaches the player', player.count('CALL Next') === 1);
    check('remote album art was downloaded', player.count('HTTP GET /cover2.png') === 1);

    await input.click(AT.progress75);
    await sleep(600);
    await screenshot('08-seeked');
    check('clicking the progress bar seeks', player.count('CALL SetPosition /org/notch/track/2') === 1);

    await input.moveTo(AT.away);
    await sleep(1000);
    await screenshot('09-activity-track2');

    // Press a button, drag off it and release outside: no click, and the
    // notch must still close once the pointer is gone.
    await input.moveTo(AT.header);
    await sleep(1000);
    await input.moveTo(AT.playPause);
    await input.press(true);
    await sleep(100);
    await input.moveTo(AT.away);
    await sleep(100);
    await input.press(false);
    await sleep(1200);
    await screenshot('09b-after-drag-out');
    check('pressing and dragging off a button does not click it',
        player.count('CALL PlayPause') === 2);

    // Pause from the expanded view, leave, and the activity should go after
    // its grace period.
    await input.moveTo(AT.header);
    await sleep(1000);
    await input.click(AT.playPause);
    await input.moveTo(AT.away);
    await sleep(1000);
    await screenshot('10-paused-in-grace');
    await sleep(5500);
    await screenshot('11-paused-after-grace');

    player.quit();
    await sleep(1000);
    await input.moveTo(AT.header);
    await sleep(1000);
    await screenshot('12-player-gone');
    await input.moveTo(AT.away);
    await sleep(800);

    // Phase 3: volume and brightness
    await screenshot('16-baseline-bottom', GNOME_OSD_AREA);
    await showOsd({icon: 'audio-volume-medium-symbolic', level: 0.5});
    await sleep(500);
    await screenshot('16-osd-volume');
    await screenshot('16-osd-volume-bottom', GNOME_OSD_AREA);
    check("volume shows in the notch, not GNOME's pop-up",
        !gnomeOsdShown('16-baseline-bottom', '16-osd-volume-bottom'));
    await showOsd({icon: 'audio-volume-high-symbolic', level: 0.8});
    await sleep(400);
    await screenshot('17-osd-volume-up');
    await sleep(1800);
    await screenshot('18-osd-gone');

    await showOsd({icon: 'display-brightness-symbolic', level: 0.3});
    await sleep(500);
    await screenshot('19-osd-brightness');
    await showOsd({icon: 'audio-volume-overamplified-symbolic', level: 1.3, maxLevel: 1.5});
    await sleep(500);
    await screenshot('20-osd-overamplified');
    await showOsd({icon: 'input-touchpad-symbolic', label: 'Touchpad off'});
    await sleep(500);
    await screenshot('21-osd-label');
    await sleep(2000);

    // Over music the pop-up takes the edges, then the music comes back.
    const player2 = fakePlayer();
    await player2.ready();
    await sleep(1500);
    await showOsd({icon: 'audio-volume-medium-symbolic', level: 0.6});
    await sleep(500);
    await screenshot('22-osd-over-music');
    await sleep(2200);
    await screenshot('23-music-back');

    // With the notch open, it shows in the header band.
    await input.moveTo(AT.header);
    await sleep(1000);
    await showOsd({icon: 'audio-volume-low-symbolic', level: 0.25});
    await sleep(400);
    await screenshot('24-osd-while-open');
    await input.moveTo(AT.away);
    await sleep(2000);
    player2.quit();
    await sleep(800);

    // Turned off in settings: GNOME's pop-up again.
    gsettings('set', 'org.gnome.shell.extensions.notch', 'osd', 'false');
    await sleep(300);
    await showOsd({icon: 'audio-volume-medium-symbolic', level: 0.5});
    await sleep(500);
    await screenshot('25-osd-setting-off-bottom', GNOME_OSD_AREA);
    check("with the setting off, GNOME's pop-up is used",
        gnomeOsdShown('16-baseline-bottom', '25-osd-setting-off-bottom'));
    gsettings('set', 'org.gnome.shell.extensions.notch', 'osd', 'true');
    await sleep(2000);

    // A full-screen window hides the notch, so GNOME's pop-up is used.
    const fullscreen = new Helper('fullscreen-window.js', [],
        {WAYLAND_DISPLAY: 'notch-test', GTK_A11Y: 'none'});
    await fullscreen.ready();
    await sleep(1500);
    await screenshot('26-fullscreen', null);
    await screenshot('26-fullscreen-bottom', GNOME_OSD_AREA);
    await showOsd({icon: 'audio-volume-medium-symbolic', level: 0.7});
    await sleep(500);
    await screenshot('27-fullscreen-osd', null);
    await screenshot('27-fullscreen-osd-bottom', GNOME_OSD_AREA);
    check("under a full-screen window, GNOME's pop-up is used",
        gnomeOsdShown('26-fullscreen-bottom', '27-fullscreen-osd-bottom'));
    fullscreen.quit();
    await sleep(2000);

    await volumeSliderCheck(input);
    await clipboardChecks(input);
    await gitChecks(input);

    // Phase 4: notifications
    const apps = new NotificationClient();
    const LONG_BODY = 'All 42 tests passed in 3.2 seconds. The release candidate is ' +
        'ready for review and can be published once the changelog is updated.';
    await input.nudge();
    const n1 = await apps.notify('Build finished', {body: LONG_BODY});
    await sleep(800);
    await screenshot('30-notification');
    await screenshot('30-notification-full', null);
    await sleep(4500);
    await screenshot('31-notification-gone');
    check('a notification hides by itself and stays in the list', !apps.closed(n1));

    // Staying under the pointer, then clicking it.
    const n2 = await apps.notify('Hover over me', {
        body: 'I should stay while the pointer is here.', actions: ['default', 'Open'],
    });
    await sleep(600);
    await input.moveTo(AT.notification);
    await sleep(5500);
    await screenshot('32-hover-keeps');
    await input.click(AT.notification);
    await sleep(500);
    check('clicking a notification activates it', apps.invoked(n2, 'default'));
    await input.moveTo(AT.away);
    await sleep(1000);

    const n3 = await apps.notify('Dismiss me', {body: 'With the close button.'});
    await sleep(800);
    await screenshot('33-close-button');
    await input.click(AT.notificationClose);
    await sleep(500);
    check('the close button dismisses it', apps.closed(n3, 2));
    await input.moveTo(AT.away);
    await sleep(1000);

    const n4 = await apps.notify('New message from Ana', {
        body: 'Are we still on for tomorrow?', actions: ['default', 'Open', 'reply', 'Reply'],
    });
    await sleep(800);
    await screenshot('34-actions');
    await input.click(AT.notificationAction);
    await sleep(500);
    check('action buttons reach the app', apps.invoked(n4, 'reply'));
    await input.moveTo(AT.away);
    await sleep(1000);

    const n5 = await apps.notify('Disk almost full', {
        body: 'Only 1 GB left on /home.', urgency: 2, icon: 'drive-harddisk-symbolic',
    });
    await sleep(6000);
    await screenshot('35-critical-stays');
    check('critical notifications stay until dismissed', !apps.closed(n5));
    await input.click(AT.notificationClose);
    await sleep(500);
    await input.moveTo(AT.away);
    await sleep(1000);

    // Two at once are shown one after the other.
    await input.nudge();
    await apps.notify('First of two');
    await apps.notify('Second of two');
    await sleep(800);
    await screenshot('36-queue-first');
    await sleep(4500);
    await screenshot('37-queue-second');
    await input.nudge();
    await sleep(2500);

    await input.nudge();
    const nT = await apps.notify('Copied to clipboard', {transient: true, icon: 'edit-copy-symbolic'});
    await sleep(5000);
    check('transient notifications expire after showing', apps.closed(nT, 1));

    // Arriving while the user is away, it waits for them.
    await sleep(2000);
    const nIdle = await apps.notify('While you were away', {transient: true});
    await sleep(6000);
    await screenshot('37b-idle-waits');
    check('a notification waits while the user is away', !apps.closed(nIdle));
    await input.nudge();
    await sleep(2600);
    check('...and goes once they are back', apps.closed(nIdle, 1));

    // Do Not Disturb: only critical ones get through.
    gsettings('set', 'org.gnome.desktop.notifications', 'show-banners', 'false');
    await sleep(300);
    await apps.notify('Quiet please');
    await sleep(800);
    await screenshot('38-dnd');
    const nC = await apps.notify('Battery critically low', {urgency: 2, icon: 'battery-level-0-symbolic'});
    await sleep(800);
    await screenshot('39-dnd-critical');
    await input.click(AT.notificationClose);
    await sleep(500);
    check('critical gets through Do Not Disturb (and dismisses)', apps.closed(nC, 2));
    await input.moveTo(AT.away);
    gsettings('set', 'org.gnome.desktop.notifications', 'show-banners', 'true');
    await sleep(1000);

    // Turned off: GNOME's banner.
    gsettings('set', 'org.gnome.shell.extensions.notch', 'notifications', 'false');
    await sleep(300);
    await apps.notify('Shown by GNOME', {body: 'The notch setting is off.'});
    await sleep(800);
    await screenshot('40-setting-off', null);
    await sleep(5000);
    gsettings('set', 'org.gnome.shell.extensions.notch', 'notifications', 'true');

    // Phase 4: battery (fake UPower, starts discharging at 50%)
    await setBattery(1, 50); // charging
    await sleep(500);
    await screenshot('41-charging');
    await sleep(3200);
    await screenshot('42-charging-gone');
    await setBattery(2, 21); // unplugged, nothing to show
    await sleep(500);
    await screenshot('43-unplugged');
    await setBattery(2, 19); // crosses 20%
    await sleep(500);
    await screenshot('44-low');
    await sleep(4500);

    await stackingChecks(input);

    // The header still opens the calendar.
    await input.click(AT.header);
    await sleep(800);
    await screenshot('13-calendar', null);
    await input.key(XK_Escape);
    await sleep(500);
    await input.moveTo(AT.away);
    await sleep(500);

    await setEnabled(false);
    await sleep(600);
    await screenshot('28-disabled');
    report = await extensionReport();
    check('extension disables cleanly', report.state === 2 && !report.errors.length);

    await setEnabled(true);
    await sleep(800);
    await screenshot('29-reenabled');
    report = await extensionReport();
    check('extension re-enables cleanly', report.state === 1 && !report.errors.length);
}

// The volume slider in GNOME's system menu: GNOME shows no pop-up for it,
// but the notch should, as it does for brightness.
async function volumeSliderCheck(input) {
    await input.click(AT.systemMenu);
    await sleep(800);
    await screenshot('27b-before-slider', HEADER_AREA);
    await screenshot('27c-system-menu', null);
    await input.click(AT.volumeSlider);
    await sleep(400);
    await screenshot('27d-volume-slider', HEADER_AREA);
    await screenshot('27d-volume-slider-full', null);
    check('the volume slider in the system menu shows in the notch',
        changedFraction('27b-before-slider', '27d-volume-slider') > 0.01);
    await input.key(XK_Escape);
    await input.moveTo(AT.away);
    await sleep(2000);
}

// Copying shows a "Copied to clipboard" notification in the notch, like
// notify-send -e -i edit-copy-symbolic "Copied to clipboard".
async function clipboardChecks(input) {
    const copier = new Helper('copy-helper.js', [],
        {WAYLAND_DISPLAY: 'notch-test', GTK_A11Y: 'none'});
    await copier.ready();
    await sleep(1500);
    await screenshot('48-copy-window', null);
    await screenshot('48-before-copy', HEADER_AREA);
    const compact = pillWidth('48-before-copy');
    const opened = file => pillWidth(file) > compact + 100;
    const closed = file => pillWidth(file) === compact;

    await input.click(AT.copyText);
    await sleep(700);
    await screenshot('49-copied');
    await screenshot('49-copied-band', HEADER_AREA);
    check('copying opens the notch with a notification',
        copier.count('COPIED text') === 1 && opened('49-copied-band'));
    await sleep(4300);
    await screenshot('50-copy-gone-band', HEADER_AREA);
    check('...and it closes by itself', closed('50-copy-gone-band'));

    // Three copies in a row: one notification, not three queued up.
    for (let i = 0; i < 3; i++) {
        await input.click(AT.copyText);
        await sleep(300);
    }
    await sleep(4500);
    await screenshot('51-repeat-gone-band', HEADER_AREA);
    check('copying repeatedly shows it once, not a queue',
        copier.count('COPIED text') === 4 && closed('51-repeat-gone-band'));

    await input.click(AT.copySecret);
    await sleep(700);
    await screenshot('52-copied-secret-band', HEADER_AREA);
    check("a password manager's copy shows it too",
        copier.count('COPIED secret') === 1 && opened('52-copied-secret-band'));
    await sleep(4300);

    gsettings('set', 'org.gnome.shell.extensions.notch', 'clipboard', 'false');
    await sleep(300);
    await input.click(AT.copyText);
    await sleep(700);
    await screenshot('53-setting-off-band', HEADER_AREA);
    check('with the setting off, copying stays quiet', closed('53-setting-off-band'));
    gsettings('set', 'org.gnome.shell.extensions.notch', 'clipboard', 'true');

    gsettings('set', 'org.gnome.desktop.notifications', 'show-banners', 'false');
    await sleep(300);
    await input.click(AT.copyText);
    await sleep(700);
    await screenshot('54-dnd-band', HEADER_AREA);
    check('under Do Not Disturb, copying stays quiet', closed('54-dnd-band'));
    gsettings('set', 'org.gnome.desktop.notifications', 'show-banners', 'true');
    await sleep(300);

    // Quitting the app that owns the clipboard makes GNOME restore its saved
    // copy; that isn't a new copy.
    copier.quit();
    await sleep(700);
    await screenshot('55-app-quit-band', HEADER_AREA);
    check('closing the app you copied from shows nothing', closed('55-app-quit-band'));
    await sleep(1000);

    // Copies made in GNOME's own text fields count too (they use the same
    // in-memory clipboard as GNOME's restores, so must not be filtered out).
    // The dialog is closed before looking, so its dimming can't fool the
    // measurement.
    await input.combo(XK_Alt_L, XK_F2);
    await sleep(800);
    await input.type('hello from the run dialog');
    await input.combo(XK_Control_L, 'a'.charCodeAt(0));
    await input.combo(XK_Control_L, 'c'.charCodeAt(0));
    await input.key(XK_Escape);
    await sleep(600);
    await screenshot('56-shell-copy-band', HEADER_AREA);
    check('copying in a GNOME text field shows it too', opened('56-shell-copy-band'));
    await input.moveTo(AT.away);
    await sleep(4500);
}

// Git commands run in a terminal show as a live activity: a notification-
// style view with a loading bar, folding into the pill's edges if they run
// long, then how they went.
async function gitChecks(input) {
    const git = new GitSandbox();
    await git.setup();
    await input.moveTo(AT.away);
    await sleep(500);
    await screenshot('60-git-before-band', HEADER_AREA);
    // Open, the notch is wider than the band; folded, the logo and bar at
    // its edges widen the pill a little.
    const compact = pillWidth('60-git-before-band');
    const open = HEADER_AREA.width - 4;
    const opened = file => pillWidth(file) >= open;
    const closed = file => pillWidth(file) === compact;
    const folded = file => {
        const width = pillWidth(file);
        return width > compact + 20 && width < open;
    };

    // Quick: only how it went.
    git.write('notes.md', 'Ideas for the notch\n');
    let status = await git.run('git add .');
    await sleep(600);
    await screenshot('61-git-add');
    await screenshot('61-git-add-band', HEADER_AREA);
    check('git add opens the notch with how it went', status === 0 && opened('61-git-add-band'));
    await sleep(3000);
    await screenshot('62-git-add-gone-band', HEADER_AREA);
    check('...and it closes by itself', closed('62-git-add-gone-band'));

    // A slow push (its pre-push hook takes 2s): the loading bar meanwhile.
    await git.run('git commit -qm "Add notes"');
    await sleep(3000);
    await git.hook('pre-push', 'sleep 2');
    let push = git.run('git push -q');
    await sleep(900);
    await screenshot('63-git-pushing');
    await screenshot('63-git-pushing-band', HEADER_AREA);
    check('a running push shows, with a loading bar', opened('63-git-pushing-band'));
    status = await push;
    await sleep(700);
    await screenshot('64-git-pushed');
    await screenshot('64-git-pushed-band', HEADER_AREA);
    check('...then how it went', status === 0 && opened('64-git-pushed-band'));
    await sleep(3000);

    // A long one folds into the pill's edges, and opens it again when done.
    await git.hook('pre-push', 'sleep 7');
    git.write('notes.md', 'Ideas for the notch\nA live activity for git\n');
    await git.sh('git commit -qam "More notes"');
    push = git.run('git push -q');
    await sleep(5200);
    await screenshot('65-git-folded');
    await screenshot('65-git-folded-band', HEADER_AREA);
    check('a long command folds into the pill\'s edges', folded('65-git-folded-band'));
    await input.moveTo(AT.header);
    await sleep(900);
    await screenshot('66-git-hover');
    await input.moveTo(AT.away);
    status = await push;
    await sleep(700);
    await screenshot('67-git-long-done-band', HEADER_AREA);
    check('...and opens the notch again when it finishes',
        status === 0 && opened('67-git-long-done-band'));
    await git.hook('pre-push', null);
    await sleep(3000);

    // Failing: red, with git's reason.
    status = await git.run('git push -q nowhere main');
    await sleep(700);
    await screenshot('68-git-failed');
    await screenshot('68-git-failed-band', HEADER_AREA);
    check('a failed push says so', status !== 0 && opened('68-git-failed-band'));
    await sleep(3000);

    // Conflicts: paused, not failed.
    git.write('conflict.txt', 'ours\n');
    await git.sh('git add . && git commit -qm ours');
    await git.run('git merge -q other');
    await sleep(700);
    await screenshot('69-git-conflict');
    await screenshot('69-git-conflict-band', HEADER_AREA);
    check('a merge with conflicts shows as paused', opened('69-git-conflict-band'));
    await git.sh('git merge --abort');
    await sleep(3000);

    // While the editor is open for the commit message, the notch stays out
    // of the way; it shows once the commit is made.
    git.write('todo.md', 'Ship it\n');
    await git.sh('git add .');
    const commit = git.run('git commit -q', {
        GIT_EDITOR: 'sleep 2; echo "Add todo" >',
    });
    await sleep(1200);
    await screenshot('70-git-editing-band', HEADER_AREA);
    check('the notch stays shut while the commit message is written',
        closed('70-git-editing-band'));
    status = await commit;
    await sleep(600);
    await screenshot('71-git-committed');
    await screenshot('71-git-committed-band', HEADER_AREA);
    check('...and shows the commit once made', status === 0 && opened('71-git-committed-band'));
    await sleep(3000);

    // Run by a program with no terminal (an IDE, a plugin manager): quiet.
    status = await git.runDetached('fetch', '-q', 'origin');
    await sleep(700);
    await screenshot('72-git-detached-band', HEADER_AREA);
    check('git run without a terminal stays quiet', status === 0 && closed('72-git-detached-band'));

    // Read-only commands: quiet.
    await git.run('git status && git log -1 && git stash list');
    await sleep(700);
    await screenshot('73-git-read-only-band', HEADER_AREA);
    check('read-only git commands stay quiet', closed('73-git-read-only-band'));
    await sleep(500);

    // A chain done in a blink still shows each step for a moment.
    git.write('chain.md', 'add, commit, push\n');
    const chain = git.run('git add . && git commit -qm "Chain" && git push -q');
    const steps = ['76-git-chain-add', '76-git-chain-commit', '76-git-chain-push'];
    await sleep(400);
    for (const step of steps) {
        await screenshot(step);
        await screenshot(`${step}-band`, HEADER_AREA);
        await sleep(800 - 60);
    }
    status = await chain;
    check('git add && commit && push steps through each, open throughout',
        status === 0 && steps.every(step => opened(`${step}-band`)) &&
        changedFraction(steps[0], steps[1]) > 0.002 &&
        changedFraction(steps[1], steps[2]) > 0.002);
    await sleep(3500);

    gsettings('set', 'org.gnome.shell.extensions.notch', 'git', 'false');
    await sleep(300);
    git.write('off.md', 'off\n');
    await git.run('git add .');
    await sleep(700);
    await screenshot('74-git-setting-off-band', HEADER_AREA);
    check('with the setting off, git stays quiet', closed('74-git-setting-off-band'));
    gsettings('set', 'org.gnome.shell.extensions.notch', 'git', 'true');
    await sleep(300);

    // Do Not Disturb: the notch doesn't open; how it went shows at the edges.
    gsettings('set', 'org.gnome.desktop.notifications', 'show-banners', 'false');
    await sleep(300);
    await git.run('git reset -q');
    await sleep(700);
    await screenshot('75-git-dnd');
    await screenshot('75-git-dnd-band', HEADER_AREA);
    check('under Do Not Disturb, it shows at the pill\'s edges only', folded('75-git-dnd-band'));
    gsettings('set', 'org.gnome.desktop.notifications', 'show-banners', 'true');
    await sleep(3000);

    await git.remove();
}

// Modal dialogs and the screenshot tool go over the notch, as they go over
// the top bar.
async function stackingChecks(input) {
    await input.moveTo(AT.away);
    await sleep(500);
    await screenshot('45-clock', CLOCK_AREA);
    await input.combo(XK_Alt_L, XK_F2);
    await sleep(1000);
    await screenshot('46-run-dialog', null);
    await screenshot('46-run-dialog-clock', CLOCK_AREA);
    check('a dialog dims the notch like the top bar',
        brightness('46-run-dialog-clock') < 0.8 * brightness('45-clock'));
    await input.key(XK_Escape);
    await sleep(800);
    await input.key(XK_Print);
    await sleep(1200);
    await screenshot('47-screenshot-tool', null);
    await screenshot('47-screenshot-tool-clock', CLOCK_AREA);
    // (The screenshot tool raises itself to the top when it opens, so this
    // holds either way; the dialog check above is the one that needs the
    // notch's own stacking to be right.)
    check('the screenshot tool goes over the notch',
        brightness('47-screenshot-tool-clock') < 0.8 * brightness('45-clock'));
    await input.key(XK_Escape);
    await sleep(800);

}

// With a second monitor: the notch stays on the primary one (where the top
// bar is), and pop-ups for the other monitor stay GNOME's.
async function multiMonitorScenario(input) {
    const other = MONITORS[1];
    await screenshot('mm-01-layout', null);

    await screenshot('mm-02-primary-before', GNOME_OSD_AREA);
    await screenshot('mm-02-other-before', osdArea(other));
    await showOsd({icon: 'audio-volume-medium-symbolic', level: 0.5});
    await sleep(500);
    // Small shots first: GNOME's pop-up is gone 1.5s after it appears, and
    // encoding the whole desktop takes a while.
    await screenshot('mm-03-primary', GNOME_OSD_AREA);
    await screenshot('mm-03-other', osdArea(other));
    await screenshot('mm-03-osd', null);
    check('volume on the primary monitor is in the notch',
        !gnomeOsdShown('mm-02-primary-before', 'mm-03-primary'));
    check("the other monitor keeps GNOME's pop-up",
        gnomeOsdShown('mm-02-other-before', 'mm-03-other'));
    await sleep(2000);

    const apps = new NotificationClient();
    await input.nudge();
    await apps.notify('On the primary monitor', {body: 'Where the top bar is.'});
    await sleep(800);
    await screenshot('mm-04-notification', null);
    await sleep(4500);

    // Dark style: the notch is black either way, like the real one.
    for (const scheme of ['prefer-dark', 'default']) {
        gsettings('set', 'org.gnome.desktop.interface', 'color-scheme', scheme);
        await sleep(1000);
        await screenshot(`mm-05-${scheme}-compact`);
        await input.moveTo(AT.header);
        await sleep(1000);
        await screenshot(`mm-05-${scheme}-open`);
        await input.moveTo(AT.away);
        await sleep(800);
    }

    const report = await extensionReport();
    check('no extension errors', report.state === 1 && !report.errors.length);
}

// Rough CPU cost of the shell in a few states. Headless rendering is done in
// software, so absolute numbers are far above a real GPU's; compare them.
async function perfScenario(input) {
    const measure = async label => {
        const before = shellCpuSeconds();
        await sleep(10000);
        const pct = (shellCpuSeconds() - before) / 10 * 100;
        print(`PERF ${label.padEnd(36)} ${pct.toFixed(1)}% of one core`);
    };

    await input.moveTo(AT.away);
    await sleep(2000);
    await measure('idle, nothing playing');

    const player = fakePlayer();
    await player.ready();
    await sleep(2000);
    await measure('music playing, compact (smooth bars)');
    gsettings('set', 'org.gnome.shell.extensions.notch', 'smooth-visualizer', 'false');
    await sleep(1000);
    await measure('music playing, compact (stepped bars)');
    gsettings('set', 'org.gnome.shell.extensions.notch', 'smooth-visualizer', 'true');

    await input.moveTo(AT.header);
    await sleep(1500);
    await measure('music playing, notch open');

    await input.click(AT.playPause);
    await input.moveTo(AT.away);
    await sleep(7000); // past the pause grace period
    await measure('music paused, compact');
    player.quit();
}

const loop = new GLib.MainLoop(null, false);
main().catch(e => {
    failures.push(`drive.js crashed: ${e.message}`);
    printerr(`drive.js: ${e.message}\n${e.stack}`);
}).finally(() => loop.quit());
loop.run();

print(failures.length ? `\n${failures.length} check(s) failed` : '\nall checks passed');
System.exit(failures.length ? 1 : 0);
