import GLib from 'gi://GLib';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Notch} from './notch.js';
import {BatteryModule} from './modules/battery.js';
import {ClipboardModule} from './modules/clipboard.js';
import {GitModule} from './modules/git.js';
import {MediaModule} from './modules/media.js';
import {NotificationsModule} from './modules/notifications.js';
import {OsdModule} from './modules/osd.js';

export default class NotchExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._dateMenu = Main.panel.statusArea.dateMenu ?? null;

        const cacheDir = GLib.build_filenamev([GLib.get_user_cache_dir(), this.uuid]);
        const isNotchShowing = () => !!this._notch?.visible && this._notch.mapped;
        // In priority order: a volume change, a battery moment or a running
        // git command briefly takes over the pill's edges from the music,
        // and a notification shows before a git result.
        const modules = [
            new OsdModule(this._settings, isNotchShowing),
            new ClipboardModule(this._settings, isNotchShowing),
            new BatteryModule(this._settings),
            new NotificationsModule(this._settings, isNotchShowing),
            new GitModule(this._settings, this.path),
            new MediaModule(this._settings, GLib.build_filenamev([cacheDir, 'art'])),
        ];

        this._notch = new Notch(this._settings, this._dateMenu, modules);
        // trackFullscreen hides the notch while a fullscreen window covers
        // the monitor.
        const layout = Main.layoutManager;
        layout.addTopChrome(this._notch, {trackFullscreen: true});
        // addTopChrome() puts it above everything added before it, including
        // modal dialogs, the on-screen keyboard and panel menus. Sit where
        // the top bar effectively is instead: above windows, under those.
        layout.uiGroup.set_child_below_sibling(this._notch, layout.modalDialogGroup);
        this._notch.sync();

        // The notch now shows the clock. The original button is only made
        // invisible, not removed or made unreactive: it keeps anchoring the
        // calendar popover and keeps Super+V working.
        if (this._dateMenu)
            this._dateMenu.opacity = 0;
    }

    disable() {
        if (this._dateMenu)
            this._dateMenu.opacity = 255;
        this._dateMenu = null;

        // Destroys the modules too.
        this._notch?.destroy();
        this._notch = null;
        this._settings = null;
    }
}
