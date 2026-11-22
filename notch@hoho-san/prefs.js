import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {gitTraceTarget} from './gitTrace.js';

const TRACE_KEY = 'trace2.eventTarget';

// Runs git; resolves to its output, '' when it fails (e.g. the key isn't
// set), or null when git isn't installed.
function runGit(args) {
    return new Promise(resolve => {
        let proc;
        try {
            proc = Gio.Subprocess.new(['git', ...args],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch {
            resolve(null);
            return;
        }
        proc.communicate_utf8_async(null, null, (p, res) => {
            try {
                const [, stdout] = p.communicate_utf8_finish(res);
                resolve(p.get_successful() ? stdout.trim() : '');
            } catch {
                resolve('');
            }
        });
    });
}

const SIZE_ROWS = [
    ['compact-width', 'Compact width', 'Minimum; grows to fit the clock', 60, 800, 2],
    ['compact-height', 'Compact height', '0 matches the top bar', 0, 120, 1],
    ['expanded-width', 'Expanded width', 'Height follows the content', 200, 1200, 2],
];

const TIMING_ROWS = [
    ['hover-delay', 'Expand delay', 'Milliseconds of hovering before it opens', 0, 2000, 10],
    ['collapse-delay', 'Collapse delay', 'Milliseconds after the pointer leaves', 0, 3000, 10],
];

export default class NotchPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage();

        page.add(this._group(settings, 'Size', SIZE_ROWS));
        page.add(this._group(settings, 'Timing', TIMING_ROWS));

        page.add(this._switches(settings, 'Show in the notch', [
            ['media-activity', 'Music',
                'Album art and a visualizer at its edges while something plays'],
            ['smooth-visualizer', 'Smooth visualizer',
                'Off: the bars step instead of glide, for about a fifth of the CPU'],
            ['osd', 'Volume and brightness',
                "Replaces GNOME's pop-up. Full-screen apps still get GNOME's"],
            ['clipboard', 'Copying',
                'A "Copied to clipboard" notification when you copy something'],
            ['notifications', 'Notifications',
                "Replaces GNOME's banners. They still go to the notification list"],
            ['battery', 'Charging and low battery',
                'A short pulse when plugged in, and a warning below 20%'],
            ['git', 'Git',
                'Push, pull, commit and more, run in a terminal, with a loading bar'],
        ]));
        page.add(this._gitGroup());

        window.add(page);
    }

    // Git tells the notch what it's doing once trace2.eventTarget in
    // ~/.gitconfig points at it.
    _gitGroup() {
        const target = gitTraceTarget();
        const group = new Adw.PreferencesGroup({title: 'Git'});
        // Plain text: the subtitle may quote the user's own setting.
        const row = new Adw.ActionRow({title: 'Connect git to the notch', use_markup: false});
        const button = new Gtk.Button({valign: Gtk.Align.CENTER});
        row.add_suffix(button);
        group.add(row);

        let current = null;
        const refresh = async () => {
            button.sensitive = false;
            current = await runGit(['config', '--global', '--get', TRACE_KEY]);
            if (current === null) {
                row.subtitle = "git isn't installed";
                button.label = 'Connect';
                return;
            }
            if (current === target) {
                row.subtitle = `Connected: ${TRACE_KEY} in ~/.gitconfig points here`;
                button.label = 'Disconnect';
            } else if (current) {
                row.subtitle = `${TRACE_KEY} is already set to ${current}`;
                button.label = 'Replace';
            } else {
                row.subtitle = `Sets ${TRACE_KEY} in ~/.gitconfig, so git reports to the notch`;
                button.label = 'Connect';
            }
            button.sensitive = true;
        };
        button.connect('clicked', async () => {
            button.sensitive = false;
            if (current === target)
                await runGit(['config', '--global', '--unset', TRACE_KEY]);
            else
                await runGit(['config', '--global', TRACE_KEY, target]);
            await refresh();
        });
        refresh();
        return group;
    }

    _switches(settings, title, rows) {
        const group = new Adw.PreferencesGroup({title});
        for (const [key, rowTitle, subtitle] of rows) {
            const row = new Adw.SwitchRow({title: rowTitle, subtitle});
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            group.add(row);
        }
        return group;
    }

    _group(settings, title, rows) {
        const group = new Adw.PreferencesGroup({title});
        for (const [key, rowTitle, subtitle, min, max, step] of rows) {
            const row = Adw.SpinRow.new_with_range(min, max, step);
            row.title = rowTitle;
            if (subtitle)
                row.subtitle = subtitle;
            settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
            group.add(row);
        }
        return group;
    }
}
