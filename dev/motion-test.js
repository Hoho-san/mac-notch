// Checks the notch's motion without a shell: steps its springs exactly as
// notch.js does (60 frames a second) through opening, closing and
// interrupted moves, and checks that nothing overshoots and that the pill's
// pixels move without jitter.
//
// usage: gjs -m dev/motion-test.js
import System from 'system';

import {Spring, SPRING_CLOSE, SPRING_OPEN} from '../notch@hoho-san/spring.js';
import {centeredPill} from '../notch@hoho-san/shape.js';

const FRAME = 1 / 60;
const MONITOR = {x: 0, width: 1920};
const EAR = 8;
const failures = [];

function check(what, ok, detail = '') {
    print(`${ok ? 'PASS' : 'FAIL'} ${what}${ok || !detail ? '' : ` (${detail})`}`);
    if (!ok)
        failures.push(what);
}

// Runs a spring from `from` towards `to`; `retarget` can change the target
// partway, as hovering in and out quickly or content changing would.
function run({from, to, feel, retarget}) {
    const spring = new Spring(from);
    spring.setParams(...feel);
    spring.target = to;
    const frames = [];
    for (let t = 0; t < 3; t += FRAME) {
        if (retarget && t >= retarget.at && spring.target !== retarget.to) {
            spring.setParams(...retarget.feel);
            spring.target = retarget.to;
        }
        spring.advance(FRAME);
        frames.push({value: spring.value, target: spring.target});
        if (spring.settled) {
            spring.snap();
            frames.push({value: spring.value, target: spring.target});
            return {frames, seconds: t + FRAME};
        }
    }
    return {frames, seconds: Infinity};
}

// Never passes the target it is heading for.
function overshoot(frames) {
    let worst = 0;
    let start = frames[0];
    for (const f of frames) {
        if (f.target !== start.target)
            start = f;
        const dir = Math.sign(start.target - start.value);
        worst = Math.max(worst, dir * (f.value - f.target));
    }
    return worst;
}

// Pixel geometry per frame: both edges move by the same amount, and the
// centred clock (odd and even widths) never moves.
function jitter(frames) {
    let problems = 0;
    let previous = null;
    const clockX = clockWidth => {
        return frame => {
            const pill = centeredPill(MONITOR.x, MONITOR.width, frame.value, EAR);
            return pill.x + EAR + Math.round((pill.bodyWidth - clockWidth) / 2);
        };
    };
    const clocks = [clockX(127), clockX(128)].map(f => new Set(frames.map(f)));
    if (clocks.some(set => set.size !== 1))
        problems++;
    for (const frame of frames) {
        const pill = centeredPill(MONITOR.x, MONITOR.width, frame.value, EAR);
        const edges = {left: pill.x, right: pill.x + pill.width};
        if (previous && (edges.left - previous.left) !== -(edges.right - previous.right))
            problems++;
        previous = edges;
    }
    return problems;
}

const cases = {
    'opening (160 -> 440 px)': {from: 160, to: 440, feel: SPRING_OPEN},
    'closing (440 -> 160 px)': {from: 440, to: 160, feel: SPRING_CLOSE},
    'height opening (32 -> 172 px)': {from: 32, to: 172, feel: SPRING_OPEN},
    'music appearing (160 -> 212 px)': {from: 160, to: 212, feel: SPRING_OPEN},
    'music going (212 -> 160 px)': {from: 212, to: 160, feel: SPRING_CLOSE},
    'hover out mid-open': {
        from: 160, to: 440, feel: SPRING_OPEN,
        retarget: {at: 0.15, to: 160, feel: SPRING_CLOSE},
    },
    'content growing mid-open': {
        from: 32, to: 120, feel: SPRING_OPEN,
        retarget: {at: 0.12, to: 186, feel: SPRING_OPEN},
    },
};

for (const [name, c] of Object.entries(cases)) {
    const {frames, seconds} = run(c);
    const over = overshoot(frames);
    check(`${name}: no overshoot`, over <= 0.001, `${over.toFixed(2)} px past`);
    check(`${name}: settles in ${seconds.toFixed(2)}s`, seconds < 1.2);
    if (!name.startsWith('height')) {
        const problems = jitter(frames);
        check(`${name}: edges move together, clock stays still`, problems === 0,
            `${problems} jittery frames`);
    }
}

print(failures.length ? `\n${failures.length} check(s) failed` : '\nall checks passed');
System.exit(failures.length ? 1 : 0);
