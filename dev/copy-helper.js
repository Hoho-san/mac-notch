// A maximized window with two big buttons that copy to the clipboard the way
// apps do: "Copy text" (plain text) and "Copy password" (plain text plus the
// marker password managers add). Prints what it copied. Exits on SIGTERM.
//
// usage: gjs -m copy-helper.js   (with WAYLAND_DISPLAY set)
import Gdk from 'gi://Gdk?version=4.0';
import GLib from 'gi://GLib';
import GLibUnix from 'gi://GLibUnix';
import Gtk from 'gi://Gtk?version=4.0';

export const TEXT = 'Meeting notes for Friday: agenda, decisions and action items';
export const SECRET = 'correct-horse-battery-staple-42';

const bytes = s => new GLib.Bytes(new TextEncoder().encode(s));

const app = new Gtk.Application({application_id: 'dev.notch.CopyHelper'});
app.connect('activate', () => {
    const window = new Gtk.ApplicationWindow({application: app, title: 'Copy helper'});
    const box = new Gtk.Box({homogeneous: true});
    const button = (label, copy) => {
        const b = new Gtk.Button({label, hexpand: true, vexpand: true});
        b.connect('clicked', copy);
        box.append(b);
    };

    button('Copy text', () => {
        window.get_clipboard().set_content(
            Gdk.ContentProvider.new_for_bytes('text/plain;charset=utf-8', bytes(TEXT)));
        print('COPIED text');
    });
    button('Copy password', () => {
        window.get_clipboard().set_content(Gdk.ContentProvider.new_union([
            Gdk.ContentProvider.new_for_bytes('text/plain;charset=utf-8', bytes(SECRET)),
            Gdk.ContentProvider.new_for_bytes('x-kde-passwordManagerHint', bytes('secret')),
        ]));
        print('COPIED secret');
    });

    window.set_child(box);
    window.maximize();
    window.present();
    print('READY');
});
GLibUnix.signal_add(GLib.PRIORITY_DEFAULT, 15, () => {
    app.quit();
    return GLib.SOURCE_REMOVE;
});
app.run([]);
