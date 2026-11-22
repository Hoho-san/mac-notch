// Album art: turns an mpris:artUrl into a local file the theme engine can
// draw (downloading remote art into a small cache), and picks an accent
// colour from it for the visualizer.

import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

const MAX_CACHED_FILES = 64;
const MAX_CACHED_COLORS = 32;
const COLOR_SAMPLE_SIZE = 16;

function promise(fn) {
    return new Promise((resolve, reject) => {
        fn((source, result, finish) => {
            try {
                resolve(finish(result));
            } catch (e) {
                reject(e);
            }
        });
    });
}

export class ArtLoader {
    /** @param {string} cacheDir - where downloaded art is kept */
    constructor(cacheDir) {
        this._dir = Gio.File.new_for_path(cacheDir);
        this._cancellable = new Gio.Cancellable();
        this._session = new Soup.Session({timeout: 15});
        this._downloads = new Map(); // url -> Promise<uri>
        this._colors = new Map(); // uri -> css colour
        this._pruned = false;
    }

    /**
     * @param {string} url - an mpris:artUrl
     * @returns {Promise<?string>} a file:// URI, or null if there is no art
     */
    resolve(url) {
        if (url.startsWith('file://'))
            return Promise.resolve(url);
        if (!/^https?:\/\//i.test(url))
            return Promise.resolve(null);

        if (!this._downloads.has(url)) {
            const download = this._download(url).catch(e => {
                this._downloads.delete(url); // let a later track retry
                throw e;
            });
            this._downloads.set(url, download);
        }
        return this._downloads.get(url);
    }

    async _download(url) {
        const name = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA1, url, -1);
        const file = this._dir.get_child(name);
        if (file.query_exists(null))
            return file.get_uri();

        const message = Soup.Message.new('GET', url);
        if (!message)
            throw new Error(`invalid art URL ${url}`);
        const bytes = await promise(cb => this._session.send_and_read_async(
            message, GLib.PRIORITY_LOW, this._cancellable,
            (s, r) => cb(s, r, res => s.send_and_read_finish(res))));
        if (message.get_status() !== Soup.Status.OK)
            throw new Error(`HTTP ${message.get_status()} for ${url}`);

        GLib.mkdir_with_parents(this._dir.get_path(), 0o700);
        await promise(cb => file.replace_contents_bytes_async(bytes, null, false,
            Gio.FileCreateFlags.REPLACE_DESTINATION, this._cancellable,
            (f, r) => cb(f, r, res => f.replace_contents_finish(res))));

        if (!this._pruned) {
            this._pruned = true;
            this._prune().catch(() => {});
        }
        return file.get_uri();
    }

    // Keeps only the newest files; runs once per session.
    async _prune() {
        const enumerator = await promise(cb => this._dir.enumerate_children_async(
            'standard::name,time::modified', Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_LOW, this._cancellable,
            (d, r) => cb(d, r, res => d.enumerate_children_finish(res))));
        const infos = [];
        for (;;) {
            const batch = await promise(cb => enumerator.next_files_async(64,
                GLib.PRIORITY_LOW, this._cancellable,
                (e, r) => cb(e, r, res => e.next_files_finish(res))));
            if (batch.length === 0)
                break;
            infos.push(...batch);
        }
        infos.sort((a, b) => b.get_attribute_uint64('time::modified') -
            a.get_attribute_uint64('time::modified'));
        for (const info of infos.slice(MAX_CACHED_FILES))
            this._dir.get_child(info.get_name()).delete_async(GLib.PRIORITY_LOW, null, null);
    }

    /**
     * @param {string} uri - a file:// URI from resolve()
     * @returns {Promise<string>} a CSS colour that reads well on black
     */
    async accentColor(uri) {
        if (this._colors.has(uri))
            return this._colors.get(uri);

        const file = Gio.File.new_for_uri(uri);
        const stream = await promise(cb => file.read_async(GLib.PRIORITY_LOW,
            this._cancellable, (f, r) => cb(f, r, res => f.read_finish(res))));
        let pixbuf;
        try {
            pixbuf = await promise(cb => GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(
                stream, COLOR_SAMPLE_SIZE, COLOR_SAMPLE_SIZE, false, this._cancellable,
                (s, r) => cb(s, r, res => GdkPixbuf.Pixbuf.new_from_stream_finish(res))));
        } finally {
            stream.close_async(GLib.PRIORITY_LOW, null, null);
        }

        const color = vibrantColor(pixbuf);
        this._colors.set(uri, color);
        if (this._colors.size > MAX_CACHED_COLORS)
            this._colors.delete(this._colors.keys().next().value);
        return color;
    }

    destroy() {
        this._cancellable.cancel();
        this._session.abort();
        this._downloads.clear();
        this._colors.clear();
    }
}

// Averages the pixels weighted towards saturated, bright ones, then lifts
// the result so it stays visible on the black notch. Greyscale art gives
// near-white.
function vibrantColor(pixbuf) {
    const pixels = pixbuf.get_pixels();
    const {width, height, rowstride} = pixbuf;
    const channels = pixbuf.get_n_channels();

    let r = 0, g = 0, b = 0, total = 0;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = y * rowstride + x * channels;
            if (channels === 4 && pixels[i + 3] < 128)
                continue;
            const [pr, pg, pb] = [pixels[i], pixels[i + 1], pixels[i + 2]];
            const max = Math.max(pr, pg, pb), min = Math.min(pr, pg, pb);
            const saturation = max ? (max - min) / max : 0;
            const weight = saturation * saturation * (max / 255) + 0.002;
            r += pr * weight;
            g += pg * weight;
            b += pb * weight;
            total += weight;
        }
    }
    if (!total)
        return 'rgb(255, 255, 255)';

    let [h, s, l] = rgbToHsl(r / total, g / total, b / total);
    s = s < 0.12 ? 0 : Math.max(s, 0.55);
    l = Math.min(Math.max(l, 0.62), 0.8);
    const [cr, cg, cb] = hslToRgb(h, s, l);
    return `rgb(${cr}, ${cg}, ${cb})`;
}

function rgbToHsl(r, g, b) {
    r /= 255;
    g /= 255;
    b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min)
        return [0, 0, l];
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if (max === r)
        h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g)
        h = (b - r) / d + 2;
    else
        h = (r - g) / d + 4;
    return [h / 6, s, l];
}

function hslToRgb(h, s, l) {
    if (s === 0) {
        const v = Math.round(l * 255);
        return [v, v, v];
    }
    const hue = t => {
        t = (t + 1) % 1;
        if (t < 1 / 6)
            return p + (q - p) * 6 * t;
        if (t < 1 / 2)
            return q;
        if (t < 2 / 3)
            return p + (q - p) * (2 / 3 - t) * 6;
        return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    return [hue(h + 1 / 3), hue(h), hue(h - 1 / 3)].map(v => Math.round(v * 255));
}
