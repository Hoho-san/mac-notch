// Traces the notch outline into a Cairo context: a body hanging from the top
// edge with rounded bottom corners, whose top corners flare outward into
// concave "ears" so it reads as part of the screen edge, like the MacBook
// notch meeting the bezel.
//
//     ear                         ear
//    ────╮                       ╭────   y = 0
//        │                       │
//        ╰───────────────────────╯       y = height (corners use `radius`)
//
// Returns false when there is nothing to draw.
export function traceNotch(cr, width, height, ear, radius) {
    const bodyWidth = width - 2 * ear;
    if (bodyWidth <= 0 || height <= ear)
        return false;

    const r = Math.max(0, Math.min(radius, bodyWidth / 2, height - ear));

    cr.newPath();
    cr.moveTo(0, 0);
    cr.lineTo(width, 0);
    // Right ear: quarter circle centred on (width, ear), from its top point
    // round to its left point.
    cr.arcNegative(width, ear, ear, -Math.PI / 2, -Math.PI);
    cr.lineTo(width - ear, height - r);
    cr.arc(width - ear - r, height - r, r, 0, Math.PI / 2);
    cr.lineTo(ear + r, height);
    cr.arc(ear + r, height - r, r, Math.PI / 2, Math.PI);
    cr.lineTo(ear, ear);
    // Left ear, mirrored, back to the origin.
    cr.arcNegative(0, ear, ear, 0, -Math.PI / 2);
    cr.closePath();
    return true;
}

// Where the pill goes on a monitor, in whole pixels, for a body width that's
// mid-animation. The body width is kept even so that, centred, both edges
// move by the same pixel each frame; with odd widths the left and right
// edges (and the centred clock) would take turns shifting, a visible jitter.
export function centeredPill(monitorX, monitorWidth, bodyWidth, ear) {
    const body = Math.max(2, 2 * Math.round(bodyWidth / 2));
    const width = body + 2 * ear;
    return {
        x: monitorX + Math.round((monitorWidth - width) / 2),
        width,
        bodyWidth: body,
    };
}
