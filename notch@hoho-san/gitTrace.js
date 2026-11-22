// Where git sends its trace2 events for the notch to read. Shared by the
// extension, which listens there, and its preferences, which point git at
// it (trace2.eventTarget in ~/.gitconfig).
import GLib from 'gi://GLib';

export function gitSocketPath() {
    return GLib.build_filenamev([GLib.get_user_runtime_dir(), 'notch-git.sock']);
}

// The value for `git config --global trace2.eventTarget`.
export function gitTraceTarget() {
    return `af_unix:stream:${gitSocketPath()}`;
}
