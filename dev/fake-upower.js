// A fake UPower battery on the session bus, for the headless test (the shell
// is told to look for it there via NOTCH_UPOWER_BUS=session). drive.js sets
// its state with dev.notch.FakeUPower.Set(state, percentage).
//
// usage: gjs -m fake-upower.js
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const PATH = '/org/freedesktop/UPower/devices/DisplayDevice';

const DEVICE_XML = `<node><interface name="org.freedesktop.UPower.Device">
  <property name="Type" type="u" access="read"/>
  <property name="State" type="u" access="read"/>
  <property name="Percentage" type="d" access="read"/>
  <property name="IsPresent" type="b" access="read"/>
</interface></node>`;

const CONTROL_XML = `<node><interface name="dev.notch.FakeUPower">
  <method name="Set">
    <arg direction="in" type="u" name="State"/>
    <arg direction="in" type="d" name="Percentage"/>
  </method>
</interface></node>`;

const device = {
    Type: 2, // battery
    State: 2, // discharging
    Percentage: 50,
    IsPresent: true,
};

const deviceExport = Gio.DBusExportedObject.wrapJSObject(DEVICE_XML, device);
const control = {
    Set(state, percentage) {
        print(`SET state=${state} percentage=${percentage}`);
        device.State = state;
        device.Percentage = percentage;
        deviceExport.emit_property_changed('State', new GLib.Variant('u', state));
        deviceExport.emit_property_changed('Percentage', new GLib.Variant('d', percentage));
        deviceExport.flush();
    },
};
const controlExport = Gio.DBusExportedObject.wrapJSObject(CONTROL_XML, control);
deviceExport.export(Gio.DBus.session, PATH);
controlExport.export(Gio.DBus.session, PATH);

const loop = new GLib.MainLoop(null, false);
Gio.bus_own_name_on_connection(Gio.DBus.session, 'org.freedesktop.UPower',
    Gio.BusNameOwnerFlags.NONE, () => print('READY'), () => loop.quit());
loop.run();
