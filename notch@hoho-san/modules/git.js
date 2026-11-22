// Git commands as a live activity. Run git push (or pull, commit, add,
// rebase...) in a terminal and the notch opens like "Copied to clipboard"
// does: the Git logo, what's happening and a loading bar, then how it went.
// A command that runs long folds into the pill's edges after a few seconds,
// and opens the notch again when it's done.
//
// Git describes what it's doing in its trace2 event stream, which it can
// send to a Unix socket (trace2.eventTarget in ~/.gitconfig, set up from the
// preferences). So nothing wraps git and nothing changes in the terminal:
// the notch only listens. Every git process connects on its own. One started
// by another git (the pack-objects under a push, the fetch under a pull)
// has its parent's session id as a prefix, which is how its progress counts
// towards the command that was typed.
//
// Git reports phases ("Counting objects", "Writing objects"), not
// percentages, so the bar creeps on by itself, jumps ahead a little at each
// new phase, and fills when git exits.
//
// Only commands that change something show, and only when run from a
// terminal: not git status/log/diff, and not what editors, IDEs and plugin
// managers run in the background.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';
import {BarLevel} from 'resource:///org/gnome/shell/ui/barLevel.js';

import {gitSocketPath} from '../gitTrace.js';

// A command done quicker than this only shows how it went.
const GRACE_MS = 200;
// How long a running command keeps the notch open before folding into the
// pill's edges.
const RUNNING_PEEK_MS = 4000;
// How long the result stays, and after the pointer leaves it.
const RESULT_MS = 2500;
const AFTER_HOVER_MS = 1500;
// The least time a result shows before another command takes its place, so
// git add . && git commit && git push steps through each. Commands queued
// behind it beyond MAX_QUEUED drop the oldest.
const MIN_RESULT_MS = 800;
const MAX_QUEUED = 4;

// The bar heads for CREEP_CAP, a little slower all the time (time constant
// CREEP_TAU_S); a new phase takes it PHASE_BUMP of the way from where it is
// to the cap. The drawn bar catches up at BAR_RATE per second, and fills at
// FILL_RATE once git is done.
const CREEP_CAP = 0.92;
const CREEP_TAU_S = 2.5;
const PHASE_BUMP = 0.3;
const BAR_RATE = 9;
const FILL_RATE = 14;
const MAX_FRAME_DT = 1 / 20;

const MAX_COMMAND_CHARS = 200;
const DRAIN_CHUNK = 64 * 1024;

// A quick command can be gone before its terminal is looked at. Then what
// started it decides: typed at an interactive shell's prompt, it's one of
// these (sh and dash, more often running scripts, aren't).
const SHELLS = new Set([
    'bash', 'zsh', 'fish', 'ksh', 'mksh', 'tcsh', 'csh', 'nu', 'xonsh', 'elvish', 'pwsh',
]);

const verbs = (doing, done, noun) => ({doing, done, noun});

// What a command is called while it runs, once done, and when it fails.
const COMMANDS = {
    'add': verbs('Staging changes', 'Changes staged', 'Staging'),
    'commit': verbs('Committing', 'Committed', 'Commit'),
    'push': verbs('Pushing', 'Pushed', 'Push'),
    'pull': verbs('Pulling', 'Pulled', 'Pull'),
    'fetch': verbs('Fetching', 'Fetched', 'Fetch'),
    'clone': verbs('Cloning', 'Cloned', 'Clone'),
    'rebase': verbs('Rebasing', 'Rebased', 'Rebase'),
    'merge': verbs('Merging', 'Merged', 'Merge'),
    'checkout': verbs('Checking out', 'Checked out', 'Checkout'),
    'switch': verbs('Switching branch', 'Switched branch', 'Switch'),
    'cherry-pick': verbs('Cherry-picking', 'Cherry-picked', 'Cherry-pick'),
    'revert': verbs('Reverting', 'Reverted', 'Revert'),
    'reset': verbs('Resetting', 'Reset', 'Reset'),
    'restore': verbs('Restoring', 'Restored', 'Restore'),
    'rm': verbs('Removing', 'Removed', 'Remove'),
    'mv': verbs('Moving', 'Moved', 'Move'),
    'stash': verbs('Stashing changes', 'Changes stashed', 'Stash'),
};
const STASH = {
    pop: verbs('Applying stash', 'Stash applied', 'Stash pop'),
    apply: verbs('Applying stash', 'Stash applied', 'Stash apply'),
    drop: verbs('Dropping stash', 'Stash dropped', 'Stash drop'),
    clear: verbs('Clearing stashes', 'Stashes cleared', 'Stash clear'),
};
const STASH_READ_ONLY = new Set(['list', 'show', 'create']);
// git checkout options that switch branch rather than restore files.
const CHECKOUT_SWITCHES = new Set(['-b', '-B', '--orphan', '--detach', '-']);

// Left in the git dir while a command waits for conflicts to be resolved
// (or, for an interactive rebase, for an "edit" stop).
const CAN_PAUSE = new Set(['rebase', 'merge', 'pull', 'cherry-pick', 'revert']);
const PAUSE_MARKERS = [
    ['rebase-merge', 'Rebase paused', 'rebase'],
    ['rebase-apply', 'Rebase paused', 'rebase'],
    ['MERGE_HEAD', 'Merge conflicts', 'merge'],
    ['CHERRY_PICK_HEAD', 'Cherry-pick conflicts', 'cherry-pick'],
    ['REVERT_HEAD', 'Revert conflicts', 'revert'],
];

const now = () => GLib.get_monotonic_time();

function describe(name, args) {
    if (name !== 'stash')
        return COMMANDS[name] ?? null;
    const sub = args.find(arg => !arg.startsWith('-'));
    if (STASH_READ_ONLY.has(sub))
        return null;
    return STASH[sub] ?? COMMANDS.stash;
}

// The arguments after the command's name, past any global options.
function argsAfter(argv, name) {
    const i = argv.indexOf(name, 1);
    return i < 0 ? [] : argv.slice(i + 1);
}

// The command as typed, roughly: git's own path shortened to "git".
function commandLine(argv) {
    const line = ['git', ...argv.slice(1)]
        .map(word => word === '' || /[\s"'\\$`]/.test(word) ? JSON.stringify(word) : word)
        .join(' ');
    return line.length > MAX_COMMAND_CHARS ? `${line.slice(0, MAX_COMMAND_CHARS - 1)}…` : line;
}

function duration(seconds) {
    if (seconds < 1)
        return `${Math.max(1, Math.round(seconds * 1000))}ms`;
    if (seconds < 10)
        return `${seconds.toFixed(1)}s`;
    if (seconds < 60)
        return `${Math.round(seconds)}s`;
    const minutes = Math.floor(seconds / 60);
    return `${minutes}m ${String(Math.floor(seconds % 60)).padStart(2, '0')}s`;
}

// Whether a git process's stdin, stdout or stderr is a terminal; null if it
// can't be told (it's already gone).
function fromTerminal(connection) {
    let pid;
    try {
        pid = connection.get_socket().get_credentials().get_unix_pid();
    } catch {
        return null;
    }
    let seen = false;
    for (const fd of [0, 1, 2]) {
        let target;
        try {
            target = GLib.file_read_link(`/proc/${pid}/fd/${fd}`);
        } catch {
            continue;
        }
        seen = true;
        if (target.startsWith('/dev/pts/') || target.startsWith('/dev/tty'))
            return true;
    }
    return seen ? false : null;
}

function loadText(path, cancellable) {
    return new Promise(resolve => {
        Gio.File.new_for_path(path).load_contents_async(cancellable, (file, res) => {
            try {
                resolve(new TextDecoder().decode(file.load_contents_finish(res)[1]));
            } catch {
                resolve(null);
            }
        });
    });
}

function exists(path, cancellable) {
    return new Promise(resolve => {
        Gio.File.new_for_path(path).query_info_async('standard::type',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, GLib.PRIORITY_DEFAULT, cancellable,
            (file, res) => {
                try {
                    file.query_info_finish(res);
                    resolve(true);
                } catch {
                    resolve(false);
                }
            });
    });
}

// A work tree's git dir and checked-out branch (or short commit when
// detached). Linked work trees and submodules have a .git file pointing at
// their git dir instead of a directory.
async function readRepo(worktree, cancellable) {
    let gitdir = GLib.build_filenamev([worktree, '.git']);
    let head = await loadText(GLib.build_filenamev([gitdir, 'HEAD']), cancellable);
    if (head === null) {
        const pointer = (await loadText(gitdir, cancellable))?.match(/^gitdir:\s*(.+)$/m);
        if (!pointer)
            return null;
        const target = pointer[1].trim();
        gitdir = GLib.path_is_absolute(target) ? target : GLib.build_filenamev([worktree, target]);
        head = await loadText(GLib.build_filenamev([gitdir, 'HEAD']), cancellable);
        if (head === null)
            return null;
    }
    const ref = head.match(/^ref: refs\/heads\/(.+)$/m);
    let branch = ref ? ref[1].trim() : head.trim().slice(0, 7);
    // Reftable repositories keep a placeholder in HEAD.
    if (branch === '.invalid')
        branch = null;
    return {gitdir, branch};
}

// One command, as typed, and every git process it starts.
class Operation {
    constructor(sid, name, spec, argv) {
        this.sid = sid;
        this.name = name;
        this.spec = spec;
        this.args = argsAfter(argv, name);
        this.command = commandLine(argv);

        this.repo = null;
        this.branch = null;
        this.worktree = null;
        this.phase = '';
        this.error = '';
        this.editors = new Set();

        this.graceId = 0;
        this.visible = false; // past the grace period
        this.collapsed = false; // folded into the pill's edges
        this.dismissed = false;
        this.dropped = false; // turned out to be read-only
        this.finished = false;
        this.outcome = null; // one of OUTCOMES, once finished

        this.title = spec.doing;
        this.detail = this.command;

        this._startedAt = now();
        this._floor = 0;
        this._creepFrom = this._startedAt;
        this._editingSince = null;
        this.editingSeconds = 0;
    }

    get editing() {
        return this.editors.size > 0;
    }

    get elapsed() {
        return (now() - this._startedAt) / 1e6;
    }

    // Where the bar is heading, 0 to 1.
    target(time) {
        if (this.finished)
            return 1;
        if (this._creepFrom === null)
            return this._floor;
        const t = (time - this._creepFrom) / 1e6;
        return CREEP_CAP - (CREEP_CAP - this._floor) * Math.exp(-t / CREEP_TAU_S);
    }

    enterPhase(label) {
        if (label === this.phase)
            return;
        const time = now();
        const at = this.target(time);
        this._floor = at + (CREEP_CAP - at) * PHASE_BUMP;
        if (this._creepFrom !== null)
            this._creepFrom = time;
        this.phase = label;
        if (!this.finished)
            this.detail = label;
    }

    // Time spent in the editor isn't progress, nor part of how long the
    // command took.
    startEditing() {
        if (this._editingSince !== null)
            return;
        this._floor = this.target(now());
        this._creepFrom = null;
        this._editingSince = now();
    }

    stopEditing() {
        if (this._editingSince === null)
            return;
        this.editingSeconds += (now() - this._editingSince) / 1e6;
        this._editingSince = null;
        this._creepFrom = now();
    }
}

// A loading bar that follows an operation, animating only while on screen.
// It turns green once full after a success; other outcomes colour it at once.
const LoadingBar = GObject.registerClass(
class NotchLoadingBar extends BarLevel {
    _init(params) {
        super._init({value: 0, ...params});
        this._op = null;
        this._outcome = null;
        this._timeline = new Clutter.Timeline({actor: this, duration: 1000, repeat_count: -1});
        this._timeline.connect('new-frame', () => this._step());
        this.connect('notify::mapped', () => this._sync());
        this.connect('destroy', () => this._timeline.stop());
    }

    follow(op) {
        if (op !== this._op) {
            this._op = op;
            this.value = 0;
        }
        this._sync();
    }

    get _filled() {
        return this._op.finished && this.value >= 1;
    }

    _sync() {
        if (!this._op) {
            this._timeline.stop();
        } else if (!St.Settings.get().enable_animations) {
            this._timeline.stop();
            this.value = this._op.target(now());
        } else if (this.mapped && !this._filled) {
            if (!this._timeline.is_playing()) {
                this._lastFrame = now();
                this._timeline.start();
            }
        } else {
            this._timeline.stop();
        }
        this._syncOutcome();
    }

    _step() {
        const time = now();
        const dt = Math.min((time - this._lastFrame) / 1e6, MAX_FRAME_DT);
        this._lastFrame = time;
        const target = this._op.target(time);
        const rate = this._op.finished ? FILL_RATE : BAR_RATE;
        const value = this.value + (target - this.value) * (1 - Math.exp(-dt * rate));
        this.value = Math.abs(target - value) < 0.002 ? target : value;
        if (this._filled)
            this._timeline.stop();
        this._syncOutcome();
    }

    _syncOutcome() {
        const outcome = this._op?.outcome ?? null;
        const show = outcome && (outcome !== 'success' || this.value >= 1) ? outcome : null;
        if (show === this._outcome)
            return;
        if (this._outcome)
            this.remove_style_class_name(this._outcome);
        if (show)
            this.add_style_class_name(show);
        this._outcome = show;
    }
});

// Laid out like a notification in the notch (see notifications.js), with a
// loading bar under the title.
const GitView = GObject.registerClass({
    Signals: {'dismiss': {}},
}, class NotchGitView extends St.Button {
    _init(icon, styleClass = '') {
        super._init({
            style_class: `notch-notification notch-git ${styleClass}`,
            x_expand: true,
            can_focus: true,
        });

        const box = new St.BoxLayout({
            style_class: 'notch-notification-box',
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
        });
        this.set_child(box);

        box.add_child(new St.Icon({
            gicon: icon,
            style_class: 'notch-notification-icon',
            y_align: Clutter.ActorAlign.START,
        }));

        const text = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'notch-notification-text',
            x_expand: true,
        });
        box.add_child(text);

        this._source = new St.Label({style_class: 'notch-notification-source'});
        this._title = new St.Label({style_class: 'notch-notification-title'});
        this.bar = new LoadingBar({style_class: 'notch-git-bar', x_expand: true});
        this._detail = new St.Label({style_class: 'notch-git-detail'});
        for (const label of [this._source, this._title, this._detail])
            label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        text.add_child(this._source);
        text.add_child(this._title);
        text.add_child(this.bar);
        text.add_child(this._detail);

        const close = new St.Button({
            style_class: 'notch-notification-close',
            icon_name: 'window-close-symbolic',
            accessible_name: 'Dismiss',
            y_align: Clutter.ActorAlign.START,
        });
        close.connect('clicked', () => this.emit('dismiss'));
        box.add_child(close);

        this.connect('clicked', () => this.emit('dismiss'));
    }

    update(op) {
        this._source.text = [op.repo, op.branch].filter(Boolean).join(' · ') || 'Git';
        this._title.text = op.title;
        this._detail.text = op.detail;
        this.accessible_name = `Git: ${op.title}`;
        this.bar.follow(op);
    }
});

export class GitModule extends EventEmitter {
    /**
     * @param {Gio.Settings} settings
     * @param {string} extensionPath - where icons/git.svg is
     */
    constructor(settings, extensionPath) {
        super();
        this._settings = settings;
        this._service = null;
        this._clients = new Set();
        this._ops = []; // running, oldest first
        this._shown = null;
        this._shownAt = 0;
        this._queue = []; // waiting for the result on show to be seen
        this._queueId = 0;
        this._timerId = 0;
        this._timerAction = null;
        this._cancellable = new Gio.Cancellable();
        this._notificationSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});

        this.busy = false;

        const icon = Gio.FileIcon.new(Gio.File.new_for_path(
            GLib.build_filenamev([extensionPath, 'icons', 'git.svg'])));

        this.activityStart = new St.Icon({gicon: icon, style_class: 'notch-git-activity-icon'});
        this.activityEnd = new LoadingBar({
            style_class: 'notch-git-activity-bar',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this.peekView = new GitView(icon);
        this.peekView.connect('dismiss', () => this._dismiss());
        // Like a notification: it stays while the pointer is on it.
        this.peekView.connect('notify::hover', () => {
            if (this.peekView.hover) {
                this._pauseTimer();
                this._pauseQueue();
            } else {
                if (this._timerAction)
                    this._startTimer(AFTER_HOVER_MS, this._timerAction);
                this._armQueue();
            }
        });

        // Hovering the pill while a command runs folded in its edges shows
        // it above the player. Empty (no height) otherwise.
        this.body = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL});
        this._bodyView = new GitView(icon, 'notch-git-body-view');
        this._bodyView.visible = false;
        this._bodyView.connect('dismiss', () => this._dismiss());
        this.body.add_child(this._bodyView);

        this._settings.connectObject('changed::git', () => this._syncListening(), this);
        this._notificationSettings.connectObject('changed::show-banners',
            () => this.emit('changed'), this);
        this._syncListening();
    }

    get peeking() {
        const op = this._shown;
        return !!op && this._bannersAllowed() && (op.finished || !op.collapsed);
    }

    // While running, at the pill's edges (only seen once it's folded, as the
    // notch is open before that). Under Do Not Disturb, the result too.
    get hasActivity() {
        const op = this._shown;
        return !!op && (!op.finished || !this._bannersAllowed());
    }

    _bannersAllowed() {
        return this._notificationSettings.get_boolean('show-banners');
    }

    // Listening

    _syncListening() {
        const want = this._settings.get_boolean('git');
        if (want && !this._service) {
            this._listen();
        } else if (!want && this._service) {
            this._stopListening();
            this._clear();
        }
    }

    _listen() {
        const path = gitSocketPath();
        const address = Gio.UnixSocketAddress.new(path);
        const service = new Gio.SocketService();
        const bind = () => service.add_address(address, Gio.SocketType.STREAM,
            Gio.SocketProtocol.DEFAULT, null);
        try {
            try {
                bind();
            } catch (e) {
                if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.ADDRESS_IN_USE))
                    throw e;
                // Left over from a shell that didn't shut down cleanly, unless
                // another shell (e.g. a nested one) is listening there.
                if (this._isLive(address)) {
                    console.warn(`notch: ${path} is in use by another shell; git activity stays there`);
                    return;
                }
                Gio.File.new_for_path(path).delete(null);
                bind();
            }
        } catch (e) {
            console.warn(`notch: can't listen for git at ${path}: ${e.message}`);
            return;
        }
        service.connect('incoming', (_service, connection) => {
            this._onIncoming(connection);
            return true;
        });
        service.start();
        this._service = service;
        this._socketPath = path;
    }

    _isLive(address) {
        try {
            new Gio.SocketClient().connect(address, null).close(null);
            return true;
        } catch {
            return false;
        }
    }

    _stopListening() {
        this._service.stop();
        this._service.close();
        this._service = null;
        for (const client of this._clients)
            this._close(client);
        this._clients.clear();
        try {
            Gio.File.new_for_path(this._socketPath).delete(null);
        } catch {
            // Already gone.
        }
    }

    _onIncoming(connection) {
        const client = {
            connection,
            input: new Gio.DataInputStream({base_stream: connection.get_input_stream()}),
            cancellable: new Gio.Cancellable(),
            terminal: fromTerminal(connection),
            sid: '',
            argv: [],
            ancestry: [],
            worktree: null,
            op: null, // the operation this process is the command of
            parent: null, // the operation it was started under
            ignored: false,
        };
        this._clients.add(client);
        this._read(client);
    }

    // Git writes one JSON event per line. Never close a connection before
    // git does: it only ignores the broken pipe, it doesn't need it.
    _read(client) {
        client.input.read_line_async(GLib.PRIORITY_DEFAULT, client.cancellable, (input, res) => {
            let line;
            try {
                [line] = input.read_line_finish_utf8(res);
            } catch (e) {
                if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    return;
                line = null;
            }
            if (line === null) {
                this._onClosed(client);
                return;
            }

            let event = null;
            try {
                event = JSON.parse(line);
            } catch {
                // Not an event; skip it.
            }
            if (event)
                this._onEvent(client, event);

            // A process run under a command that has since finished (e.g. a
            // daemon it started) has nothing more to tell.
            if (client.parent?.finished)
                client.ignored = true;
            if (client.ignored)
                this._drain(client);
            else
                this._read(client);
        });
    }

    _drain(client) {
        client.input.skip_async(DRAIN_CHUNK, GLib.PRIORITY_DEFAULT, client.cancellable,
            (input, res) => {
                let skipped = 0;
                try {
                    skipped = input.skip_finish(res);
                } catch (e) {
                    if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        return;
                }
                if (skipped > 0)
                    this._drain(client);
                else
                    this._onClosed(client);
            });
    }

    _onClosed(client) {
        // Gone without saying how it exited: killed, e.g. by Ctrl+C.
        if (client.op && !client.op.finished)
            this._finish(client.op, null);
        this._close(client);
        this._clients.delete(client);
    }

    _close(client) {
        client.cancellable.cancel();
        try {
            client.connection.close(null);
        } catch {
            // Already closed.
        }
    }

    // Events

    _onEvent(client, event) {
        switch (event.event) {
        case 'start':
            client.sid = String(event.sid ?? '');
            client.argv = Array.isArray(event.argv) ? event.argv.map(String) : [];
            break;
        case 'cmd_ancestry':
            client.ancestry = Array.isArray(event.ancestry) ? event.ancestry : [];
            break;
        case 'def_repo':
            if (event.repo === 1 && event.worktree) {
                client.worktree = String(event.worktree);
                if (client.op)
                    this._setWorktree(client.op, client.worktree);
            }
            break;
        case 'cmd_name':
            this._onCommandName(client, String(event.hierarchy ?? event.name ?? ''));
            break;
        case 'child_start':
            this._onChildStart(client, event);
            break;
        case 'child_exit': {
            const op = this._opOf(client);
            if (op?.editors.delete(`${client.sid}:${event.child_id}`))
                this._onEditing(op);
            break;
        }
        case 'region_enter':
            if (event.category === 'progress' && event.label)
                this._onPhase(this._opOf(client), String(event.label));
            break;
        case 'error': {
            const op = this._opOf(client);
            if (op && !op.error && event.msg)
                op.error = String(event.msg).split('\n')[0].trim();
            break;
        }
        case 'exit':
            if (client.op && !client.op.finished)
                this._finish(client.op, Number(event.code), Number(event.t_abs));
            break;
        }
    }

    _onCommandName(client, hierarchy) {
        if (client.op)
            return;
        // Aliases show as _run_dashed_ / _run_git_alias_, and run the real
        // command in a child.
        const path = hierarchy.split('/').filter(part => part && !part.startsWith('_run_'));
        if (path.length === 0)
            return;
        if (path.length > 1) {
            // Started by another git command: its progress counts towards
            // that one, if that one is shown.
            client.parent = this._ops.find(op => client.sid.startsWith(`${op.sid}/`)) ?? null;
            if (!client.parent)
                client.ignored = true;
            return;
        }

        const [name] = path;
        const spec = describe(name, argsAfter(client.argv, name));
        if (!spec || !this._isInteractive(client)) {
            client.ignored = true;
            return;
        }

        const op = new Operation(client.sid, name, spec, client.argv);
        client.op = op;
        this._ops.push(op);
        if (client.worktree)
            this._setWorktree(op, client.worktree);
        op.graceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, GRACE_MS, () => {
            op.graceId = 0;
            op.visible = true;
            if (!op.editing)
                this._request(op);
            return GLib.SOURCE_REMOVE;
        });
    }

    _isInteractive(client) {
        if (client.terminal !== null)
            return client.terminal;
        return SHELLS.has(client.ancestry.find(name => name !== 'git'));
    }

    _opOf(client) {
        return client.op ?? client.parent;
    }

    _onChildStart(client, event) {
        const op = this._opOf(client);
        if (!op || op.finished)
            return;
        switch (event.child_class) {
        case 'editor':
            op.editors.add(`${client.sid}:${event.child_id}`);
            this._onEditing(op);
            break;
        case 'pager':
            // Only reading after all (e.g. git stash show).
            if (op === client.op) {
                this._drop(op);
                client.ignored = true;
            }
            break;
        case 'hook':
            if (event.hook_name)
                this._onPhase(op, `Running ${event.hook_name} hook`);
            break;
        }
    }

    _onPhase(op, label) {
        if (!op || op.finished)
            return;
        op.enterPhase(label);
        this._refresh(op);
    }

    // Hidden while you write the commit message (or the rebase todo list),
    // back when the editor closes.
    _onEditing(op) {
        if (op.editing) {
            op.startEditing();
            if (this._shown === op)
                this._showNext();
        } else {
            op.stopEditing();
            op.collapsed = false;
            if (op.visible && !op.finished)
                this._request(op);
        }
    }

    _setWorktree(op, worktree) {
        op.worktree = worktree;
        op.repo = GLib.path_get_basename(worktree);
        this._refresh(op);
        readRepo(worktree, this._cancellable).then(repo => {
            if (!repo || this._cancellable.is_cancelled())
                return;
            if (!op.finished)
                op.branch = repo.branch;
            this._refresh(op);
        });
    }

    _removeOp(op) {
        if (op.graceId) {
            GLib.source_remove(op.graceId);
            op.graceId = 0;
        }
        this._ops = this._ops.filter(o => o !== op);
    }

    _drop(op) {
        op.dropped = true;
        this._removeOp(op);
        this._queue = this._queue.filter(o => o !== op);
        if (this._shown === op)
            this._showNext();
    }

    async _finish(op, code, seconds) {
        op.finished = true;
        this._removeOp(op);
        if (op.dropped)
            return;
        // The bars start filling now; the words follow once the repo's been
        // looked at.
        this._refresh(op);

        let markers = new Set();
        let branch = op.branch;
        const aborting = op.args.some(arg => arg === '--abort' || arg === '--quit');
        if (op.worktree) {
            const repo = await readRepo(op.worktree, this._cancellable);
            if (this._cancellable.is_cancelled())
                return;
            if (repo) {
                branch = repo.branch;
                if (CAN_PAUSE.has(op.name) && !aborting) {
                    const found = await Promise.all(PAUSE_MARKERS.map(([file]) =>
                        exists(GLib.build_filenamev([repo.gitdir, file]), this._cancellable)));
                    if (this._cancellable.is_cancelled())
                        return;
                    markers = new Set(PAUSE_MARKERS.filter((_, i) => found[i]).map(([file]) => file));
                }
            }
        }

        const {spec} = op;
        op.stopEditing();
        const took = duration(
            (Number.isFinite(seconds) ? seconds : op.elapsed) - op.editingSeconds);
        const pause = PAUSE_MARKERS.find(([file]) => markers.has(file));
        if (pause) {
            op.outcome = 'paused';
            op.title = pause[1];
            op.detail = `Resolve, then git ${pause[2]} --continue`;
        } else if (code === 0) {
            op.outcome = 'success';
            if (aborting)
                op.title = `${spec.noun} aborted`;
            else if (branch && this._switchedBranch(op, branch))
                op.title = `Switched to ${branch}`;
            else
                op.title = spec.done;
            op.detail = `${op.command} · ${took}`;
        } else if (code === null) {
            op.outcome = 'cancelled';
            op.title = `${spec.noun} cancelled`;
            op.detail = op.command;
        } else {
            op.outcome = 'failure';
            op.title = `${spec.noun} failed`;
            op.detail = op.error || `${op.command} · exit ${code}`;
        }
        op.branch = branch;

        if (this._settings.get_boolean('git'))
            this._request(op);
    }

    // HEAD may well have moved before git's events were read, so the
    // arguments tell: git checkout main, not git checkout -- file.
    _switchedBranch(op, branch) {
        if (op.name === 'switch')
            return true;
        if (op.name !== 'checkout' || op.args.includes('--'))
            return false;
        return op.args.some(arg => CHECKOUT_SWITCHES.has(arg) || arg.startsWith(branch));
    }

    // Showing

    _canShow(op) {
        if (op.dropped)
            return false;
        return op.finished || (op.visible && !op.editing && !op.dismissed);
    }

    // Shows a command now, or once the result on show has had its moment.
    _request(op) {
        // The one on show turning into its result never waits.
        const shown = this._shown;
        const waiting = shown !== op && (this._queue.length > 0 ||
            (shown?.finished && now() - this._shownAt < MIN_RESULT_MS * 1000));
        if (!waiting) {
            this._show(op);
            return;
        }
        if (!this._queue.includes(op)) {
            this._queue.push(op);
            if (this._queue.length > MAX_QUEUED)
                this._queue.shift();
        }
        this._armQueue();
    }

    _armQueue() {
        if (this._queueId || this._queue.length === 0 || (this.peekView.hover && this.peeking))
            return;
        const wait = Math.max(0, MIN_RESULT_MS - (now() - this._shownAt) / 1000);
        this._queueId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.ceil(wait), () => {
            this._queueId = 0;
            this._showNext();
            return GLib.SOURCE_REMOVE;
        });
    }

    _pauseQueue() {
        if (this._queueId) {
            GLib.source_remove(this._queueId);
            this._queueId = 0;
        }
    }

    _show(op) {
        this._pauseQueue();
        this._clearTimer();
        this._shown = op;
        this._shownAt = now();
        if (op?.finished) {
            this._startTimer(RESULT_MS, () => this._showNext());
        } else if (op && !op.collapsed) {
            this._startTimer(RUNNING_PEEK_MS, () => {
                op.collapsed = true;
                this._render();
                this.emit('changed');
            });
        }
        this._render();
        this.emit('changed');
        this._armQueue();
    }

    // The next command waiting its turn, if any; else back to whatever's
    // still running, folded: it was seen already.
    _showNext() {
        while (this._queue.length > 0) {
            const next = this._queue.shift();
            if (this._canShow(next)) {
                this._show(next);
                return;
            }
        }
        const op = this._ops.findLast(o => this._canShow(o)) ?? null;
        if (op)
            op.collapsed = true;
        this._show(op);
    }

    _refresh(op) {
        if (op !== this._shown)
            return;
        this._render();
        this.emit('changed');
    }

    _render() {
        const op = this._shown;
        if (op) {
            this.peekView.update(op);
            this._bodyView.update(op);
            this.activityEnd.follow(op);
        }
        this._bodyView.visible = !!op && !op.finished;
    }

    // A running command stops showing until it's done; a result goes.
    _dismiss() {
        const op = this._shown;
        if (!op)
            return;
        if (!op.finished)
            op.dismissed = true;
        this._showNext();
    }

    _startTimer(ms, action) {
        this._clearTimer();
        this._timerAction = action;
        if (this.peekView.hover && this.peeking)
            return; // started again when the pointer leaves
        this._timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._timerId = 0;
            const run = this._timerAction;
            this._timerAction = null;
            run();
            return GLib.SOURCE_REMOVE;
        });
    }

    _pauseTimer() {
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = 0;
        }
    }

    _clearTimer() {
        this._pauseTimer();
        this._timerAction = null;
    }

    _clear() {
        for (const op of [...this._ops])
            this._removeOp(op);
        this._queue = [];
        this._show(null);
    }

    destroy() {
        this._settings.disconnectObject(this);
        this._notificationSettings.disconnectObject(this);
        this._cancellable.cancel();
        if (this._service)
            this._stopListening();
        for (const op of [...this._ops])
            this._removeOp(op);
        this._queue = [];
        this._pauseQueue();
        this._clearTimer();
        this._shown = null;
        this.activityStart.destroy();
        this.activityEnd.destroy();
        this.peekView.destroy();
        this.body.destroy();
    }
}
