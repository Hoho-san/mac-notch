// Copying posts a "Copied to clipboard" notification, the same as
//     notify-send -e -i edit-copy-symbolic "Copied to clipboard"
// would: transient (gone from the list once shown), so it opens the notch
// like any notification. What was copied is never read.
//
// Copying again while it's still up shows the same notification again
// rather than queueing another one behind it.

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

const ICON = 'edit-copy-symbolic';
// When an app gives up the clipboard (it quits, or swaps in a new copy),
// mutter puts back a saved copy of the contents straight away. That restore
// isn't something the user copied.
const RESTORE_WINDOW_US = 100 * 1000;

export class ClipboardModule extends EventEmitter {
    /**
     * @param {Gio.Settings} settings
     * @param {() => boolean} isNotchShowing - whether the notch is on screen
     */
    constructor(settings, isNotchShowing) {
        super();
        this._settings = settings;
        this._isNotchShowing = isNotchShowing;
        this._ownerGoneAt = 0;
        this._source = null;
        this._notification = null;

        // Shows through the notifications module, not on the pill's edges.
        this.hasActivity = false;
        this.busy = false;

        global.display.get_selection().connectObject('owner-changed',
            (_selection, type, source) => this._onOwnerChanged(type, source), this);
    }

    _onOwnerChanged(type, source) {
        if (type !== Meta.SelectionType.SELECTION_CLIPBOARD)
            return;

        const now = GLib.get_monotonic_time();
        if (!source) {
            this._ownerGoneAt = now;
            return;
        }
        const restored = source instanceof Meta.SelectionSourceMemory &&
            now - this._ownerGoneAt < RESTORE_WINDOW_US;
        if (!restored)
            this._onCopied();
    }

    _onCopied() {
        // Not while a full-screen app hides the notch: GNOME would hold the
        // banner back and show it, stale, afterwards.
        if (!this._settings.get_boolean('clipboard') || !this._isNotchShowing())
            return;

        const source = this._ensureSource();
        // Under Do Not Disturb it wouldn't show, only pile up in the list.
        if (!source.policy.showBanners)
            return;

        if (this._notification) {
            // Still up (or queued): show it again.
            this._notification.acknowledged = false;
            return;
        }

        const notification = new MessageTray.Notification({
            source,
            iconName: ICON,
            title: 'Copied to clipboard',
            isTransient: true,
        });
        notification.connect('destroy', () => {
            if (this._notification === notification)
                this._notification = null;
        });
        this._notification = notification;
        source.addNotification(notification);
    }

    // GNOME destroys a source once its last notification goes, so it's
    // recreated as needed.
    _ensureSource() {
        if (!this._source) {
            this._source = new MessageTray.Source({title: 'Clipboard', iconName: ICON});
            this._source.connect('destroy', () => {
                this._source = null;
                this._notification = null;
            });
            Main.messageTray.add(this._source);
        }
        return this._source;
    }

    destroy() {
        global.display.get_selection().disconnectObject(this);
        this._source?.destroy(MessageTray.NotificationDestroyedReason.SOURCE_CLOSED);
        this._source = null;
        this._notification = null;
    }
}
