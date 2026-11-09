// Arcade drone physics on the XZ plane with automatically stabilised altitude.
// Deterministic, fixed timestep, no rendering dependencies.

import { clamp, damp, wrapAngle } from './math';
import { obstaclePush, trackSdf, type SdfResult, type Track } from './track';

export interface DroneInput {
  throttle: number; // 0..1
  brake: number; // 0..1
  steer: number; // -1 (left) .. 1 (right)
  boost: boolean;
}

export const NO_INPUT: Readonly<DroneInput> = Object.freeze({ throttle: 0, brake: 0, steer: 0, boost: false });

export interface DroneState {
  x: number;
  y: number;
  z: number;
  vx: number;
  vz: number;
  yaw: number;
  yawRate: number;
  /** Visual tilt (radians), part of the state so ghosts reproduce it. */
  pitch: number;
  roll: number;
  boost: number; // 0..1 energy
  boosting: boolean;
  boostCooldown: number;
  /** Time accumulator for the hover bob. */
  hoverT: number;
  /** Seconds left of collision flash (feedback). */
  hitFlash: number;
}

export const DRONE = {
  radius: 0.95,
  hoverHeight: 2.2,
  maxSpeed: 31,
  boostMaxSpeed: 44,
  accel: 30,
  boostAccel: 22,
  coastDrag: 0.45,
  brakeDecel: 42,
  reverseMax: 9,
  lateralGrip: 7.5,
  boostLateralGrip: 5.5,
  turnRateLow: 2.9,
  turnRateHigh: 1.85,
  turnResponse: 13,
  boostDrain: 0.38,
  boostRegen: 0.16,
  boostRegenDelay: 0.7,
  boostMinToStart: 0.12,
  wallRestitution: 0.12,
  wallFriction: 0.35,
} as const;

/** Maximum yaw rate (rad/s) at a given forward speed. */
export function turnRateAt(speed: number): number {
  const sNorm = clamp(Math.abs(speed) / DRONE.maxSpeed, 0, 1);
  return DRONE.turnRateLow + (DRONE.turnRateHigh - DRONE.turnRateLow) * sNorm;
}

/**
 * Highest speed that can hold a curve of curvature k (1/radius): the drone
 * keeps its forward speed while yawing, so the limit is the yaw rate
 * (v * k <= turnRate(v)), scaled by a safety margin (0..1).
 */
export function cornerSpeed(k: number, margin: number): number {
  if (k < 1e-5) return Infinity;
  let v: number = DRONE.boostMaxSpeed;
  for (let i = 0; i < 4; i++) v = (turnRateAt(v) * margin) / k;
  return v;
}

export function createDrone(x: number, z: number, yaw: number): DroneState {
  return {
    x,
    y: DRONE.hoverHeight,
    z,
    vx: 0,
    vz: 0,
    yaw,
    yawRate: 0,
    pitch: 0,
    roll: 0,
    boost: 1,
    boosting: false,
    boostCooldown: 0,
    hoverT: 0,
    hitFlash: 0,
  };
}

export function copyDrone(src: DroneState, dst: DroneState): DroneState {
  dst.x = src.x;
  dst.y = src.y;
  dst.z = src.z;
  dst.vx = src.vx;
  dst.vz = src.vz;
  dst.yaw = src.yaw;
  dst.yawRate = src.yawRate;
  dst.pitch = src.pitch;
  dst.roll = src.roll;
  dst.boost = src.boost;
  dst.boosting = src.boosting;
  dst.boostCooldown = src.boostCooldown;
  dst.hoverT = src.hoverT;
  dst.hitFlash = src.hitFlash;
  return dst;
}

export function speedOf(d: DroneState): number {
  return Math.hypot(d.vx, d.vz);
}

/** Signed forward speed. */
export function forwardSpeed(d: DroneState): number {
  return d.vx * Math.sin(d.yaw) + d.vz * Math.cos(d.yaw);
}

export interface CollisionInfo {
  /** Impact speed along the normal (m/s), 0 if no collision this step. */
  impact: number;
  x: number;
  z: number;
}

const sdf: SdfResult = { d: 0, nx: 0, nz: 0 };
const push = { nx: 0, nz: 0 };

/**
 * Advances the drone by dt. Returns collision information for feedback.
 */
export function stepDrone(d: DroneState, input: DroneInput, dt: number, track: Track, out: CollisionInfo): CollisionInfo {
  out.impact = 0;
  const fx = Math.sin(d.yaw);
  const fz = Math.cos(d.yaw);
  // Right vector (see track.ts for conventions: yaw decreases when turning right).
  const rx = -fz;
  const rz = fx;

  let vf = d.vx * fx + d.vz * fz;
  let vl = d.vx * rx + d.vz * rz;
  const prevVf = vf;

  const throttle = clamp(input.throttle, 0, 1);
  const brake = clamp(input.brake, 0, 1);
  const steer = clamp(input.steer, -1, 1);

  // --- Boost energy ---------------------------------------------------
  const wantsBoost = input.boost && throttle > 0.1;
  if (wantsBoost && (d.boosting ? d.boost > 0 : d.boost > DRONE.boostMinToStart)) {
    d.boosting = true;
    d.boost = Math.max(0, d.boost - DRONE.boostDrain * dt);
    d.boostCooldown = DRONE.boostRegenDelay;
  } else {
    d.boosting = false;
    if (d.boostCooldown > 0) d.boostCooldown -= dt;
    else d.boost = Math.min(1, d.boost + DRONE.boostRegen * dt);
  }
  if (d.boost <= 0) d.boosting = false;

  // --- Longitudinal ----------------------------------------------------
  const vmax = d.boosting ? DRONE.boostMaxSpeed : DRONE.maxSpeed;
  if (throttle > 0 && vf < vmax) {
    // Progressive: strong at low speed, tapering toward the cap.
    const k = 1 - clamp(vf / vmax, 0, 1);
    const a = (DRONE.accel * (0.35 + 0.65 * k) + (d.boosting ? DRONE.boostAccel : 0)) * throttle;
    vf = Math.min(vmax, vf + a * dt);
  } else if (vf > vmax) {
    // Coming off boost: bleed speed smoothly.
    vf = Math.max(vmax, vf - 14 * dt);
  }
  if (brake > 0) {
    if (vf > 0.5) vf = Math.max(0, vf - DRONE.brakeDecel * brake * dt);
    else vf = Math.max(-DRONE.reverseMax, vf - 12 * brake * dt); // gentle reverse
  }
  if (throttle <= 0 && brake <= 0) {
    vf -= vf * DRONE.coastDrag * dt;
    if (Math.abs(vf) < 0.05) vf = 0;
  }

  // --- Lateral grip (light inertia, little drift) ------------------------
  const grip = d.boosting ? DRONE.boostLateralGrip : DRONE.lateralGrip;
  vl *= Math.exp(-grip * dt);

  // --- Steering ----------------------------------------------------------
  const sp = Math.abs(vf);
  const turnRate = turnRateAt(sp);
  // Reversing flips steering like a car would feel natural.
  const dir = vf < -0.5 ? -1 : 1;
  const targetYawRate = -steer * turnRate * dir;
  d.yawRate += (targetYawRate - d.yawRate) * damp(DRONE.turnResponse, dt);
  d.yaw = wrapAngle(d.yaw + d.yawRate * dt);

  // Rebuild velocity in the *new* heading for forward part: this is what
  // makes turns feel responsive, while the lateral part carries inertia.
  const nfx = Math.sin(d.yaw);
  const nfz = Math.cos(d.yaw);
  const nrx = -nfz;
  const nrz = nfx;
  // Part of the old lateral velocity is transferred (slight slide in turns).
  d.vx = nfx * vf + nrx * vl;
  d.vz = nfz * vf + nrz * vl;

  // --- Integrate -------------------------------------------------------------
  d.x += d.vx * dt;
  d.z += d.vz * dt;

  // --- Collisions ------------------------------------------------------------
  let bestImpact = 0;
  for (let iter = 0; iter < 3; iter++) {
    let moved = false;
    for (const o of track.obstacles) {
      const pen = obstaclePush(o, d.x, d.z, DRONE.radius, push);
      if (pen > 0) {
        d.x += push.nx * pen;
        d.z += push.nz * pen;
        bestImpact = Math.max(bestImpact, resolveVelocity(d, push.nx, push.nz));
        out.x = d.x - push.nx * DRONE.radius;
        out.z = d.z - push.nz * DRONE.radius;
        moved = true;
      }
    }
    trackSdf(track, d.x, d.z, sdf);
    const pen = sdf.d + DRONE.radius;
    if (pen > 0) {
      // Outward normal points into the wall; push back inside.
      d.x -= sdf.nx * pen;
      d.z -= sdf.nz * pen;
      bestImpact = Math.max(bestImpact, resolveVelocity(d, -sdf.nx, -sdf.nz));
      out.x = d.x + sdf.nx * DRONE.radius;
      out.z = d.z + sdf.nz * DRONE.radius;
      moved = true;
    }
    if (!moved) break;
  }
  out.impact = bestImpact;
  if (bestImpact > 1.5) d.hitFlash = 0.35;
  else if (d.hitFlash > 0) d.hitFlash = Math.max(0, d.hitFlash - dt);

  // --- Visual attitude (part of state, recorded by the ghost) ---------------
  const newVf = d.vx * nfx + d.vz * nfz;
  const longAccel = (newVf - prevVf) / dt;
  const targetPitch = clamp(longAccel * 0.012, -0.32, 0.32) + clamp(newVf / DRONE.boostMaxSpeed, -0.2, 1) * 0.12;
  // Bank into the turn (turning right = negative yawRate = positive roll).
  const targetRoll = clamp(-d.yawRate * Math.min(1, sp / 12) * 0.32, -0.55, 0.55);
  d.pitch += (targetPitch - d.pitch) * damp(6, dt);
  d.roll += (targetRoll - d.roll) * damp(7, dt);

  d.hoverT += dt;
  d.y = DRONE.hoverHeight + Math.sin(d.hoverT * 2.1) * 0.07;

  return out;
}

/**
 * Removes the velocity component going into a surface (n = push direction,
 * pointing to free space). Returns the impact speed.
 */
function resolveVelocity(d: DroneState, nx: number, nz: number): number {
  const vn = d.vx * nx + d.vz * nz;
  if (vn >= 0) return 0;
  const impact = -vn;
  // Remove normal component, small bounce.
  d.vx -= (1 + DRONE.wallRestitution) * vn * nx;
  d.vz -= (1 + DRONE.wallRestitution) * vn * nz;
  // Speed loss proportional to how head-on the hit was.
  const sp = Math.hypot(d.vx, d.vz) + impact;
  const headOn = sp > 0 ? impact / sp : 0;
  // Scraping along a wall costs a little; a head-on hit costs a lot.
  const keep = 1 - DRONE.wallFriction * headOn - Math.min(0.04, impact * 0.008);
  d.vx *= keep;
  d.vz *= keep;
  // Head-on hits deflect sideways so the drone never gets pinned.
  if (headOn > 0.8 && impact > 1) {
    const tx = -nz;
    const tz = nx;
    const vt = d.vx * tx + d.vz * tz;
    const side = vt !== 0 ? Math.sign(vt) : 1;
    const kick = impact * 0.3;
    d.vx += tx * side * kick;
    d.vz += tz * side * kick;
  }
  return impact;
}
