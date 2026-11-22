UUID     := notch@hoho-san
SRC      := $(CURDIR)/$(UUID)
EXT_DIR  := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
SOURCES  := notch.js spring.js shape.js mpris.js art.js gitTrace.js modules icons

.PHONY: schemas install uninstall test perf nested logs prefs pack clean

schemas:
	glib-compile-schemas $(SRC)/schemas

# Symlinks the source folder into your extensions dir, so edits are picked up
# on the next shell start. On Wayland that means logging out and back in.
install: schemas
	mkdir -p $(dir $(EXT_DIR))
	ln -sfn $(SRC) $(EXT_DIR)
	@echo "Linked. Log out and back in, then: gnome-extensions enable $(UUID)"

uninstall:
	-gnome-extensions disable $(UUID)
	rm -f $(EXT_DIR)

# The motion check (springs, no shell needed), then headless shells with
# throwaway settings testing the packed zip (the thing you'd install): the
# full scenario, then a two-monitor one.
# Screenshots + shell logs land in dev/out*/. Doesn't touch your session.
test: pack
	gjs -m dev/motion-test.js
	PACKAGE=dist/$(UUID).shell-extension.zip dev/headless-test.sh dev/out
	PACKAGE=dist/$(UUID).shell-extension.zip SCENARIO=multimonitor \
		MONITORS="1920x1080 1280x720" dev/headless-test.sh dev/out-multimonitor

# Rough CPU cost of the shell while idle / playing music / open.
perf: pack
	PACKAGE=dist/$(UUID).shell-extension.zip SCENARIO=perf dev/headless-test.sh dev/out-perf

# Nested shell in a window, for poking at it by hand.
# Needs: sudo apt install mutter-dev-bin
nested: install
	dbus-run-session -- gnome-shell --devkit

logs:
	journalctl -f -o cat /usr/bin/gnome-shell

prefs:
	gnome-extensions prefs $(UUID)

pack:
	mkdir -p dist
	gnome-extensions pack $(SRC) --force --out-dir=dist \
		$(foreach f,$(SOURCES),--extra-source=$(f))

clean:
	rm -rf dist dev/out dev/out-* $(SRC)/schemas/gschemas.compiled
