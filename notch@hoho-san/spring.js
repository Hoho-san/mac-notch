// A damped harmonic oscillator, parameterised the way SwiftUI's
// .spring(response:dampingFraction:) is: `response` is roughly the time in
// seconds to reach the target, `damping` 1 is critical.
// Springs keep their velocity when retargeted, so a hover-in/hover-out flick
// reverses smoothly instead of restarting the animation.
//
// A spring never passes its target. Critical damping alone ensures that for
// a move from rest, but a target that changes mid-motion (e.g. content
// growing while the notch opens) could still carry it past and back, a
// visible wiggle; so a step that would cross the target stops on it.

const SETTLE_DISTANCE = 0.3; // px
const SETTLE_SPEED = 3; // px/s
// Physics sub-step. Stiff springs go unstable with a single 16ms step.
const PHYSICS_STEP = 1 / 240;

// The notch's feel, as [response (s), damping fraction]. Both are critically
// damped: the notch eases straight into its new size without overshooting
// and swinging back.
export const SPRING_OPEN = [0.4, 1];
export const SPRING_CLOSE = [0.34, 1];

export class Spring {
    constructor(value = 0) {
        this.value = value;
        this.target = value;
        this.velocity = 0;
        this.setParams(...SPRING_OPEN);
    }

    setParams(response, damping) {
        const omega = 2 * Math.PI / response;
        this._stiffness = omega * omega;
        this._damping = 2 * damping * omega;
    }

    step(dt) {
        const accel = -this._stiffness * (this.value - this.target) -
            this._damping * this.velocity;
        // Semi-implicit Euler: update velocity first, then position.
        this.velocity += accel * dt;
        this.value += this.velocity * dt;
    }

    // Moves the spring forward by a frame's worth of time, in sub-steps.
    advance(dt) {
        const steps = Math.max(1, Math.ceil(dt / PHYSICS_STEP));
        for (let i = 0; i < steps; i++) {
            const before = this.value - this.target;
            this.step(dt / steps);
            const after = this.value - this.target;
            if (before !== 0 && Math.sign(after) !== Math.sign(before)) {
                this.snap();
                return;
            }
        }
    }

    get settled() {
        return Math.abs(this.value - this.target) < SETTLE_DISTANCE &&
            Math.abs(this.velocity) < SETTLE_SPEED;
    }

    snap() {
        this.value = this.target;
        this.velocity = 0;
    }
}
