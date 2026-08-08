import type {EaseName, ScalarKeyframe, Vec3Tuple, VectorKeyframe} from './hero.config';

export function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function applyEase(value: number, easing: EaseName): number {
  const t = clamp(value);
  if (t === 0 || t === 1) return t;
  if (easing === 'linear') return t;
  if (easing === 'sine') return -(Math.cos(Math.PI * t) - 1) / 2;
  if (easing === 'quint') {
    return t < 0.5 ? 16 * t ** 5 : 1 - ((-2 * t + 2) ** 5) / 2;
  }
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function segment<T extends {time: number; ease?: EaseName}>(time: number, frames: readonly T[]): [T, T, number] {
  if (frames.length === 0) throw new Error('Timeline requires at least one keyframe.');
  if (time <= frames[0].time) return [frames[0], frames[0], 0];
  const last = frames[frames.length - 1];
  if (time >= last.time) return [last, last, 0];
  for (let index = 1; index < frames.length; index += 1) {
    const next = frames[index];
    if (time <= next.time) {
      const previous = frames[index - 1];
      const progress = (time - previous.time) / (next.time - previous.time);
      return [previous, next, applyEase(progress, next.ease ?? 'cinematic')];
    }
  }
  return [last, last, 0];
}

export function sampleScalar(time: number, frames: readonly ScalarKeyframe[]): number {
  const [from, to, progress] = segment(time, frames);
  return from.value + (to.value - from.value) * progress;
}

export function sampleVector(time: number, frames: readonly VectorKeyframe[]): Vec3Tuple {
  const [from, to, progress] = segment(time, frames);
  return [
    from.value[0] + (to.value[0] - from.value[0]) * progress,
    from.value[1] + (to.value[1] - from.value[1]) * progress,
    from.value[2] + (to.value[2] - from.value[2]) * progress,
  ];
}
