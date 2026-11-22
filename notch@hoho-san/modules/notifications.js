// New notifications open the notch instead of dropping a banner from the
// top of the screen. They still go to the notification list as usual.
//
// GNOME queues banners and pops them one at a time in
// MessageTray._showNotification(), after applying all its rules (Do Not
// Disturb, per-app banner settings, low urgency, full-screen apps). This
// module takes each notification at exactly that point, so those rules
// still apply, and shows it in the notch instead.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {
    MessageTray, NotificationDestroyedReason, Urgency,
} from 'resource:///org/gnome/shell/ui/messageTray.js';

// Same timings and idle rule as GNOME's banners: if the user is away when
// a notification arrives, it waits for them, then goes shortly after.
const SHOW_MS = 4000;
const AFTER_HOVER_MS = 1500;
const IDLE_MS = 1000;
const AFTER_RETURN_MS = 2000;
const MAX_ACTIONS = 3;

// Notification bodies may carry Pango markup; the notch shows plain text.
function plainText(text, isMarkup) {
    if (!text)
        return '';
    if (isMarkup) {
        try {
            text = Pango.parse_markup(text, -1, '')[2];
        } catch {
            // Malformed markup: show it as it came.
        }
    }
    return text.replace(/\s+/g, ' ').trim();
}

const NotificationView = GObject.registerClass({
    Signals: {
        'activate': {},
        'close': {},
        'action': {param_types: [GObject.TYPE_INT]},
    },
}, class NotchNotificationView extends St.Button {
    _init() {
        super._init({
            style_class: 'notch-notification',
            x_expand: true,
            can_focus: true,
        });

        // Fill the button (St.Bin centres its child by default), so the close
        // button sits at the right edge whatever the text length.
        const box = new St.BoxLayout({
            style_class: 'notch-notification-box',
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
        });
        this.set_child(box);

        this._icon = new St.Icon({
            style_class: 'notch-notification-icon',
            y_align: Clutter.ActorAlign.START,
        });
        box.add_child(this._icon);

        const text = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'notch-notification-text',
            x_expand: true,
        });
        box.add_child(text);

        this._source = new St.Label({style_class: 'notch-notification-source'});
        this._title = new St.Label({style_class: 'notch-notification-title'});
        this._body = new St.Label({style_class: 'notch-notification-body'});
        for (const label of [this._source, this._title])
            label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        // Up to two lines; the stylesheet caps the height and Pango
        // ellipsizes what doesn't fit.
        this._body.clutter_text.line_wrap = true;
        this._body.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        this._body.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        text.add_child(this._source);
        text.add_child(this._title);
        text.add_child(this._body);

        this._actions = new St.BoxLayout({style_class: 'notch-notification-actions'});
        text.add_child(this._actions);

        const close = new St.Button({
            style_class: 'notch-notification-close',
            icon_name: 'window-close-symbolic',
            accessible_name: 'Dismiss',
            y_align: Clutter.ActorAlign.START,
        });
        close.connect('clicked', () => this.emit('close'));
        box.add_child(close);

        this.connect('clicked', () => this.emit('activate'));
    }

    setNotification(notification) {
        const {source} = notification;
        this._icon.gicon = notification.gicon ?? source?.icon ?? null;
        this._source.text = source?.title ?? '';
        this._title.text = plainText(notification.title, false);
        this._body.text = plainText(notification.body, notification.useBodyMarkup);
        this._body.visible = !!this._body.text;
        this.accessible_name = [this._source.text, this._title.text].filter(Boolean).join(': ');

        this._actions.destroy_all_children();
        notification.actions.slice(0, MAX_ACTIONS).forEach((action, i) => {
            const button = new St.Button({
                style_class: 'notch-notification-action',
                label: action.label,
                can_focus: true,
            });
            button.connect('clicked', () => this.emit('action', i));
            this._actions.add_child(button);
        });
        this._actions.visible = this._actions.get_n_children() > 0;
    }
});

export class NotificationsModule extends EventEmitter {
    /**
     * @param {Gio.Settings} settings
     * @param {() => boolean} isNotchShowing - whether the notch is on screen
     */
    constructor(settings, isNotchShowing) {
        super();
        this._settings = settings;
        this._isNotchShowing = isNotchShowing;
        this._queue = [];
        this._current = null;
        this._hideId = 0;
        this._drainId = 0;
        this._activeWatchId = 0;
        this._idleMonitor = global.backend.get_core_idle_monitor();

        this.hasActivity = false;
        this.busy = false;

        this.peekView = new NotificationView();
        this.peekView.connect('activate', () =>
            this._act(notification => notification.activate()));
        this.peekView.connect('action', (_view, i) =>
            this._act(notification => notification.actions[i]?.activate()));
        this.peekView.connect('close', () =>
            this._current?.destroy(NotificationDestroyedReason.DISMISSED));
        // Like GNOME's banners, stay while the pointer is on it, and go
        // shortly after it leaves.
        this.peekView.connect('notify::hover', () => {
            if (this.peekView.hover)
                this._clearTimer();
            else
                this._restartTimer(AFTER_HOVER_MS);
        });

        this._injections = new InjectionManager();
        this._intercept();
    }

    get peeking() {
        return !!this._current;
    }

    // Activating usually destroys the notification, which moves on to the
    // next one; "resident" ones survive it, so move on explicitly.
    _act(callback) {
        const notification = this._current;
        if (!notification)
            return;
        callback(notification);
        this._finish(notification, false);
    }

    // MessageTray._showNotification() and its queue are GNOME internals. If
    // a GNOME update changes them, fall back to GNOME's own banners rather
    // than lose notifications.
    _intercept() {
        if (typeof MessageTray.prototype._showNotification !== 'function') {
            console.warn('notch: GNOME changed its notification banners; leaving them as they are');
            return;
        }

        const module = this;
        this._injections.overrideMethod(MessageTray.prototype, '_showNotification', original =>
            function () {
                const queue = this._notificationQueue;
                if (!module._wants() || !Array.isArray(queue) || queue.length === 0)
                    return original.call(this);

                // Only take it off GNOME's queue once the notch has it.
                try {
                    module._enqueue(queue[0]);
                } catch (e) {
                    console.error(`notch: showing a notification failed: ${e.message}`);
                    return original.call(this);
                }
                queue.shift();
                this.emit('queue-changed');

                // GNOME shows one banner per state update; since the notch
                // took this one, let it hand over the rest of its queue too.
                if (queue.length > 0 && !module._drainId) {
                    module._drainId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                        module._drainId = 0;
                        this._updateState?.();
                        return GLib.SOURCE_REMOVE;
                    });
                }
                return undefined;
            });
    }

    _wants() {
        return this._settings.get_boolean('notifications') && this._isNotchShowing();
    }

    _enqueue(notification) {
        if (notification === this._current) {
            // An update to the one on screen (or the same one shown again):
            // refresh it and keep it longer. Marked seen again, as GNOME does,
            // so it can be re-shown later.
            notification.acknowledged = true;
            this.peekView.setNotification(notification);
            this._restartTimer(SHOW_MS);
            return;
        }
        if (this._queue.includes(notification))
            return;

        notification.connectObject('destroy', () => this._onDestroyed(notification), this);
        this._queue.push(notification);
        this._queue.sort((a, b) => b.urgency - a.urgency);
        if (!this._current)
            this._showNext();
    }

    _showNext() {
        const notification = this._queue.shift() ?? null;
        this._current = notification;
        if (notification) {
            // What GNOME does when it shows a banner.
            notification.acknowledged = true;
            notification.playSound();
            notification.connectObject('notify', () => {
                if (this._current === notification)
                    this.peekView.setNotification(notification);
            }, this);
            this.peekView.setNotification(notification);
            if (this._idleMonitor.get_idletime() > IDLE_MS) {
                this._activeWatchId = this._idleMonitor.add_user_active_watch(() => {
                    this._activeWatchId = 0;
                    this._restartTimer(AFTER_RETURN_MS);
                });
            } else {
                this._restartTimer(SHOW_MS);
            }
        }
        this.emit('changed');
    }

    _restartTimer(delay) {
        this._clearTimer();
        const notification = this._current;
        // Critical ones stay until dealt with; nothing hides under the pointer.
        if (!notification || notification.urgency === Urgency.CRITICAL || this.peekView.hover)
            return;

        this._hideId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._hideId = 0;
            this._finish(notification, true);
            return GLib.SOURCE_REMOVE;
        });
    }

    _clearTimer() {
        if (this._hideId) {
            GLib.source_remove(this._hideId);
            this._hideId = 0;
        }
    }

    _clearActiveWatch() {
        if (this._activeWatchId) {
            this._idleMonitor.remove_watch(this._activeWatchId);
            this._activeWatchId = 0;
        }
    }

    // Stops showing the notification; when it simply timed out, transient
    // ones are dropped from the list, as GNOME does after a banner.
    _finish(notification, expired) {
        if (notification !== this._current)
            return;
        this._clearTimer();
        this._clearActiveWatch();
        notification.disconnectObject(this);
        if (expired && notification.isTransient)
            notification.destroy(NotificationDestroyedReason.EXPIRED);
        this._showNext();
    }

    _onDestroyed(notification) {
        if (notification === this._current) {
            this._finish(notification, false);
        } else {
            this._queue = this._queue.filter(n => n !== notification);
            notification.disconnectObject(this);
        }
    }

    destroy() {
        this._injections.clear();
        this._clearTimer();
        this._clearActiveWatch();
        if (this._drainId) {
            GLib.source_remove(this._drainId);
            this._drainId = 0;
        }
        for (const notification of [this._current, ...this._queue].filter(Boolean))
            notification.disconnectObject(this);
        this._queue = [];
        this._current = null;
        this.peekView.destroy();
    }
}
