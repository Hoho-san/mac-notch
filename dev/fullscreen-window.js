// Opens one full-screen window, for checking what the notch does while a
// full-screen app covers the screen. Exits on SIGTERM.
//
// usage: gjs -m fullscreen-window.js   (with WAYLAND_DISPLAY set)
import GLib from 'gi://GLib';
import GLibUnix from 'gi://GLibUnix';
import Gtk from 'gi://Gtk?version=4.0';

const app = new Gtk.Application({application_id: 'dev.notch.FullscreenTest'});
app.connect('activate', () => {
    const window = new Gtk.ApplicationWindow({application: app, title: 'Full screen'});
    window.set_child(new Gtk.Label({label: 'Full-screen test window'}));
    window.fullscreen();
    window.present();
    print('READY');
});
GLibUnix.signal_add(GLib.PRIORITY_DEFAULT, 15, () => {
    app.quit();
    return GLib.SOURCE_REMOVE;
});
app.run([]);
