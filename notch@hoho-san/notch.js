import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import GnomeDesktop from 'gi://GnomeDesktop';
import Graphene from 'gi://Graphene';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Spring, SPRING_CLOSE, SPRING_OPEN} from './spring.js';
import {centeredPill, traceNotch} from './shape.js';

// Geometry constants are logical px, multiplied by the scale factor at use.
const EAR = 8;
const COMPACT_RADIUS_RATIO = 0.36; // of the compact height
const EXPANDED_RADIUS = 24;
const FALLBACK_PANEL_HEIGHT = 32;
// Compact activity: actors hug the pill's edges, this far in, with this much
// space between them and the clock.
const EDGE_INSET = 8;
const EDGE_GAP = 12;

// After a stall (e.g. a long frame), don't simulate more than this at once.
const MAX_FRAME_DT = 1 / 20;
// While a module is busy (e.g. a slider drag), recheck this often whether
// the notch may close.
const BUSY_RECHECK_MS = 300;

export const State = Object.freeze({
    COMPACT: 'compact',
    EXPANDED: 'expanded',
});

// Layout, top to bottom:
//
//   header  the clock, always visible, centred in a band as tall as the
//           compact notch. In compact state a module's activity actors sit
//           at the band's far edges.
//   body    module views, stacked; only while open. The notch opens on
//           hover, or by itself while a module "peeks" (e.g. a new
//           notification), in which case the body shows only that
//           module's peek view.
//
// The pill's shape is painted separately behind both and springs between
// sizes; the content layer clips to it.
//
// Modules (see modules/) provide:
//   activityStart / activityEnd  optional: actors for the header band's edges
//   hasActivity                  whether those should be showing; the first
//                                module (in priority order) with one wins
//   activityWhenExpanded         optional: keep showing them when expanded
//   body                         optional: actor stacked in the body
//   peekView / peeking           optional: an actor to open the notch with,
//                                and whether to show it now
//   busy                         true mid-interaction (e.g. a drag), so the
//                                notch doesn't close under the pointer
// and emit 'changed' whenever any of these may have changed.
export const Notch = GObject.registerClass(
class Notch extends St.Widget {
    /**
     * @param {Gio.Settings} settings - the extension's settings
     * @param {?PanelMenu.Button} dateMenu - the top-bar clock button the
     *   notch stands in for; its menu is the calendar we open on click
     * @param {object[]} modules - in priority order; the notch takes
     *   ownership and destroys them with itself
     */
    _init(settings, dateMenu, modules) {
        super._init({
            name: 'notch',
            reactive: true,
            track_hover: true,
        });

        this._settings = settings;
        this._dateMenu = dateMenu;
        this._modules = modules;
        this._state = State.COMPACT;
        this._pendingId = 0;
        this._metrics = null;
        this._activityModule = null;
        this._peekModule = null;
        this._open = false;
        this._calendarOpen = false;

        this._width = new Spring();
        this._height = new Spring();
        this._radius = new Spring();
        this._springs = [this._width, this._height, this._radius];

        this._background = new St.DrawingArea();
        this._background.connect('repaint', area => this._repaint(area));
        this.add_child(this._background);

        this._content = new St.Widget({clip_to_allocation: true});
        this.add_child(this._content);

        this._buildHeader();
        this._buildBody();

        this._wallClock = new GnomeDesktop.WallClock();
        this._wallClock.connectObject('notify::clock', () => this._syncClock(), this);
        this._syncClock();

        this._timeline = new Clutter.Timeline({
            actor: this,
            duration: 1000,
            repeat_count: -1,
        });
        this._timeline.connect('new-frame', () => this._tick());

        this.connect('notify::hover', () => this._onHoverChanged());
        this.connect('destroy', () => this._onDestroy());

        for (const module of this._modules)
            module.connectObject('changed', () => this._onModuleChanged(), this);

        this._settings.connectObject('changed', () => this._updateTargets(), this);
        Main.panel.connectObject('notify::height', () => this._updateTargets(), this);
        Main.layoutManager.connectObject('monitors-changed',
            () => this._updateTargets({animate: false}), this);
        St.ThemeContext.get_for_stage(global.stage).connectObject('notify::scale-factor',
            () => this._updateTargets({animate: false}), this);
        this._dateMenu?.menu.connectObject('open-state-changed', (_menu, isOpen) => {
            // Never cover the calendar popover, not even with a peek.
            this._calendarOpen = isOpen;
            if (isOpen) {
                this._cancelPending();
                this._state = State.COMPACT;
            }
            this._syncOpen();
        }, this);
    }

    get state() {
        return this._state;
    }

    // Must be called once the notch is on the stage: measuring needs theme
    // nodes, which only exist there.
    sync() {
        this._onModuleChanged({animate: false});
    }

    _buildHeader() {
        // Clicks anywhere in the header band open the calendar, like the
        // clock they replace. It sits under the header content, which isn't
        // reactive, so clicks fall through to it.
        this._headerHit = new St.Widget({reactive: true});
        const click = new Clutter.ClickGesture();
        click.connect('recognize', () => this._onHeaderClicked());
        this._headerHit.add_action(click);
        this._content.add_child(this._headerHit);

        this._clock = new St.BoxLayout({style_class: 'notch-clock-box'});

        // Mirror the unread-notification / do-not-disturb indicator of the
        // hidden top-bar clock, with a pad on the other side so the time
        // stays centred, the same trick the clock button itself uses.
        const indicator = this._dateMenu?._indicator;
        if (indicator) {
            const pad = new St.Widget();
            this._indicatorBindings = [
                indicator.bind_property('visible', pad, 'visible',
                    GObject.BindingFlags.SYNC_CREATE),
            ];
            pad.add_constraint(new Clutter.BindConstraint({
                source: indicator,
                coordinate: Clutter.BindCoordinate.SIZE,
            }));
            this._clock.add_child(pad);
        }

        this._clockLabel = new St.Label({
            style_class: 'notch-clock',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._clock.add_child(this._clockLabel);

        if (indicator) {
            const clone = new Clutter.Clone({
                source: indicator,
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._indicatorBindings.push(indicator.bind_property('visible',
                clone, 'visible', GObject.BindingFlags.SYNC_CREATE));
            this._clock.add_child(clone);
        }
        this._content.add_child(this._clock);

        for (const module of this._modules) {
            for (const actor of [module.activityStart, module.activityEnd]) {
                if (!actor)
                    continue;
                actor.opacity = 0;
                actor.visible = false;
                this._content.add_child(actor);
            }
        }
    }

    _buildBody() {
        this._body = new St.BoxLayout({
            style_class: 'notch-body',
            orientation: Clutter.Orientation.VERTICAL,
            opacity: 0,
            visible: false,
            scale_x: 0.96,
            scale_y: 0.96,
            pivot_point: new Graphene.Point({x: 0.5, y: 0}),
        });
        for (const module of this._modules) {
            if (module.body)
                this._body.add_child(module.body);
            if (module.peekView) {
                module.peekView.visible = false;
                this._body.add_child(module.peekView);
            }
        }
        this._content.add_child(this._body);
    }

    // While a module peeks, the body shows just its peek view.
    _syncBodyContent() {
        for (const module of this._modules) {
            if (module.body)
                module.body.visible = !this._peekModule;
            if (module.peekView)
                module.peekView.visible = module === this._peekModule;
        }
    }

    _syncClock() {
        this._clockLabel.text = this._wallClock.clock.trim();
        // The compact width follows the clock (e.g. 9:59 -> 10:00).
        this._updateTargets();
    }

    _onModuleChanged({animate = true} = {}) {
        const peek = this._modules.find(m => m.peeking) ?? null;
        if (peek !== this._peekModule) {
            this._peekModule = peek;
            this._syncBodyContent();
            // Swapping what's in an already-open body: fade the new content in.
            if (this._open) {
                this._body.opacity = 0;
                this._body.ease({
                    opacity: 255,
                    duration: 180,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
            }
            this._syncOpen();
        }

        const owner = this._modules.find(m => m.hasActivity) ?? null;
        const wasShowing = !!this._activityModule;
        if (owner !== this._activityModule) {
            this._showActivity(this._activityModule, false);
            this._activityModule = owner;
            this._syncActivityVisibility();
        }

        // The pill bounces when an activity appears, and settles when it goes.
        if (!this._open && wasShowing !== !!owner)
            this._setSpringFeel(owner ? SPRING_OPEN : SPRING_CLOSE);

        this._updateTargets({animate});
    }

    // Activities show in the compact pill. Some (e.g. the volume pop-up)
    // stay in the header band when expanded too, since the body has nothing
    // that replaces them.
    _syncActivityVisibility() {
        const module = this._activityModule;
        this._showActivity(module, !this._open || !!module?.activityWhenExpanded);
    }

    _showActivity(module, show) {
        if (!module)
            return;
        for (const actor of [module.activityStart, module.activityEnd]) {
            if (show) {
                actor.show();
                actor.ease({
                    opacity: 255,
                    delay: 90,
                    duration: 220,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
            } else {
                actor.ease({
                    opacity: 0,
                    duration: 100,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    // Hidden, not just transparent, so its animations stop.
                    onStopped: isFinished => {
                        if (isFinished)
                            actor.hide();
                    },
                });
            }
        }
    }

    _edgeWidth(module, scale) {
        if (!module)
            return 0;
        const widest = Math.max(
            module.activityStart.get_preferred_width(-1)[1],
            module.activityEnd.get_preferred_width(-1)[1]);
        return widest + (EDGE_INSET + EDGE_GAP) * scale;
    }

    _computeMetrics() {
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const s = this._settings;

        const compactHeight = s.get_int('compact-height') > 0
            ? s.get_int('compact-height') * scale
            : Main.panel.height || FALLBACK_PANEL_HEIGHT * scale;
        const [, clockWidth] = this._clock.get_preferred_width(compactHeight);
        const edge = this._edgeWidth(this._activityModule, scale);
        const compactWidth = Math.max(s.get_int('compact-width') * scale,
            clockWidth + 2 * edge);

        const expandedWidth = Math.max(s.get_int('expanded-width') * scale, compactWidth);
        const [, bodyHeight] = this._body.get_preferred_height(expandedWidth);

        return {
            scale,
            ear: Math.round(EAR * scale),
            [State.COMPACT]: {
                width: compactWidth,
                height: compactHeight,
                radius: compactHeight * COMPACT_RADIUS_RATIO,
            },
            [State.EXPANDED]: {
                width: expandedWidth,
                height: compactHeight + bodyHeight,
                radius: EXPANDED_RADIUS * scale,
            },
        };
    }

    _updateTargets({animate = true} = {}) {
        if (!this.get_stage())
            return;

        const metrics = this._computeMetrics();
        this._metrics = metrics;

        const target = metrics[this._open ? State.EXPANDED : State.COMPACT];
        this._width.target = target.width;
        this._height.target = target.height;
        this._radius.target = target.radius;

        this._body.width = metrics[State.EXPANDED].width;

        if (animate && St.Settings.get().enable_animations) {
            this._startAnimating();
        } else {
            this._timeline.stop();
            this._springs.forEach(spring => spring.snap());
        }
        this._applyGeometry();
    }

    _setSpringFeel([response, damping]) {
        this._springs.forEach(spring => spring.setParams(response, damping));
    }

    _startAnimating() {
        if (this._timeline.is_playing())
            return;
        this._lastFrameTime = GLib.get_monotonic_time();
        this._timeline.start();
    }

    _tick() {
        const now = GLib.get_monotonic_time();
        const dt = Math.min((now - this._lastFrameTime) / 1e6, MAX_FRAME_DT);
        this._lastFrameTime = now;

        this._springs.forEach(spring => spring.advance(dt));

        if (this._springs.every(spring => spring.settled)) {
            this._springs.forEach(spring => spring.snap());
            this._timeline.stop();
        }
        this._applyGeometry();
    }

    _applyGeometry() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!this._metrics || !monitor)
            return;

        const {ear, scale} = this._metrics;
        const compactHeight = this._metrics[State.COMPACT].height;
        const {x, width, bodyWidth} =
            centeredPill(monitor.x, monitor.width, this._width.value, ear);
        const height = Math.max(1, Math.round(this._height.value));

        this.set_position(x, monitor.y);
        this.set_size(width, height);

        this._background.set_size(width, height);
        this._background.queue_repaint();

        // Everything below is in body coordinates. Content keeps its own
        // size and stays centred while the body resizes around it, so text
        // never reflows mid-animation; the clip reveals it.
        this._content.set_position(ear, 0);
        this._content.set_size(bodyWidth, height);

        this._headerHit.set_position(0, 0);
        this._headerHit.set_size(bodyWidth, compactHeight);

        const [, clockWidth] = this._clock.get_preferred_width(-1);
        this._clock.set_position(Math.round((bodyWidth - clockWidth) / 2), 0);
        this._clock.height = compactHeight;

        const module = this._activityModule;
        if (module) {
            const inset = Math.round(EDGE_INSET * scale);
            const place = (actor, x) => {
                const [, w] = actor.get_preferred_width(-1);
                const [, h] = actor.get_preferred_height(w);
                actor.set_position(Math.round(x(w)), Math.round((compactHeight - h) / 2));
            };
            place(module.activityStart, () => inset);
            place(module.activityEnd, w => bodyWidth - inset - w);
        }

        const expandedWidth = this._metrics[State.EXPANDED].width;
        this._body.set_position(Math.round((bodyWidth - expandedWidth) / 2), compactHeight);
    }

    _repaint(area) {
        const cr = area.get_context();
        const [width, height] = area.get_surface_size();
        if (this._metrics &&
            traceNotch(cr, width, height, this._metrics.ear, this._radius.value)) {
            cr.setSourceRGBA(0, 0, 0, 1);
            cr.fill();
        }
        cr.$dispose();
    }

    _setState(state) {
        if (this._state === state)
            return;
        this._state = state;
        this._syncOpen();
    }

    // Open while hovered (EXPANDED) or while a module peeks.
    _syncOpen() {
        const open = !this._calendarOpen &&
            (this._state === State.EXPANDED || !!this._peekModule);
        if (open === this._open)
            return;
        this._open = open;

        this._setSpringFeel(open ? SPRING_OPEN : SPRING_CLOSE);
        this._fadeBody(open);
        this._syncActivityVisibility();
        this._updateTargets();
    }

    _fadeBody(opening) {
        const mode = Clutter.AnimationMode.EASE_OUT_QUAD;
        if (opening) {
            this._body.show();
            this._body.ease({
                opacity: 255,
                scale_x: 1,
                scale_y: 1,
                delay: 80,
                duration: 240,
                mode,
            });
        } else {
            this._body.ease({
                opacity: 0,
                scale_x: 0.96,
                scale_y: 0.96,
                duration: 120,
                mode,
                onStopped: isFinished => {
                    if (isFinished && !this._open)
                        this._body.hide();
                },
            });
        }
    }

    _onHoverChanged() {
        this._cancelPending();

        if (this.hover) {
            if (this._dateMenu?.menu.isOpen)
                return;
            this._schedule(this._settings.get_int('hover-delay'),
                () => this._setState(State.EXPANDED));
        } else {
            this._scheduleCollapse(this._settings.get_int('collapse-delay'));
        }
    }

    _scheduleCollapse(delayMs) {
        this._schedule(delayMs, () => {
            // Don't close under a drag that wandered outside the notch.
            if (this._modules.some(m => m.busy)) {
                this._scheduleCollapse(BUSY_RECHECK_MS);
                return;
            }
            // Trust the hover state from crossing events. Re-reading it with
            // sync_hover() is wrong after a press that was released outside
            // the notch: it still reports the pressed button as hovered.
            if (!this.hover)
                this._setState(State.COMPACT);
        });
    }

    _onHeaderClicked() {
        // The header keeps the old clock's job: toggling the calendar.
        this._cancelPending();
        this._setState(State.COMPACT);
        this._dateMenu?.menu.toggle();
    }

    _schedule(delayMs, callback) {
        this._pendingId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delayMs, () => {
            this._pendingId = 0;
            callback();
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelPending() {
        if (this._pendingId) {
            GLib.source_remove(this._pendingId);
            this._pendingId = 0;
        }
    }

    _onDestroy() {
        // Other connectObject(..., this) signals are dropped automatically
        // when this actor is destroyed. The clock is disconnected by hand
        // first, because disposing it before that auto-disconnect runs
        // leaves it poking at a dead object.
        this._cancelPending();
        this._timeline.stop();
        this._indicatorBindings?.forEach(binding => binding.unbind());
        this._indicatorBindings = null;
        this._wallClock.disconnectObject(this);
        this._wallClock.run_dispose();
        this._wallClock = null;

        // Children are still alive while 'destroy' handlers run, so modules
        // can tear down their own actors cleanly.
        for (const module of this._modules) {
            module.disconnectObject(this);
            module.destroy();
        }
        this._modules = [];
        this._activityModule = null;
        this._peekModule = null;
    }
});
