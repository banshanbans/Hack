export interface ExtractedVideoFrame {
  id: string;
  blob: Blob;
  width: number;
  height: number;
  frameIndex: number;
  capturedAtMs: number;
  perceptualHash: string;
  brightness: number;
  sharpness: number;
}

interface Candidate extends ExtractedVideoFrame {
  qualityScore: number;
}

function waitFor(target: EventTarget, event: string, errorEvent = 'error'): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => { cleanup(); resolve(); };
    const failed = () => { cleanup(); reject(new Error('视频无法解码，请改用截图或照片')); };
    const cleanup = () => {
      target.removeEventListener(event, done);
      target.removeEventListener(errorEvent, failed);
    };
    target.addEventListener(event, done, {once: true});
    target.addEventListener(errorEvent, failed, {once: true});
  });
}

export function hammingDistance(left: string, right: string): number {
  if (left.length !== right.length) return Number.MAX_SAFE_INTEGER;
  let distance = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = Number.parseInt(left[index], 16);
    const b = Number.parseInt(right[index], 16);
    let value = a ^ b;
    while (value) { distance += value & 1; value >>= 1; }
  }
  return distance;
}

export function inspectPixels(data: Uint8ClampedArray, width: number, height: number): {brightness: number; sharpness: number; hash: string} {
  let luminanceSum = 0;
  let edgeSum = 0;
  let samples = 0;
  const step = Math.max(1, Math.floor(Math.min(width, height) / 80));
  const luminanceAt = (x: number, y: number) => {
    const offset = (y * width + x) * 4;
    return data[offset] * 0.299 + data[offset + 1] * 0.587 + data[offset + 2] * 0.114;
  };
  for (let y = step; y < height - step; y += step) {
    for (let x = step; x < width - step; x += step) {
      const center = luminanceAt(x, y);
      luminanceSum += center;
      edgeSum += Math.abs(center * 4 - luminanceAt(x - step, y) - luminanceAt(x + step, y) - luminanceAt(x, y - step) - luminanceAt(x, y + step));
      samples += 1;
    }
  }
  let bits = '';
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      const leftX = Math.min(width - 1, Math.floor((x / 9) * width));
      const rightX = Math.min(width - 1, Math.floor(((x + 1) / 9) * width));
      const sampleY = Math.min(height - 1, Math.floor(((y + 0.5) / 8) * height));
      bits += luminanceAt(leftX, sampleY) < luminanceAt(rightX, sampleY) ? '1' : '0';
    }
  }
  let hash = '';
  for (let index = 0; index < bits.length; index += 4) hash += Number.parseInt(bits.slice(index, index + 4), 2).toString(16);
  return {brightness: samples ? luminanceSum / samples : 0, sharpness: samples ? edgeSum / samples : 0, hash};
}

function selectRepresentativeFrames(candidates: Candidate[], target: number): Candidate[] {
  const usable = candidates.filter(item => item.brightness >= 28 && item.brightness <= 232 && item.sharpness >= 5);
  const pool = usable.length >= Math.min(3, target) ? usable : candidates;
  if (!pool.length) return [];
  const sorted = [...pool].sort((a, b) => b.qualityScore - a.qualityScore);
  const selected: Candidate[] = [sorted[0]];
  while (selected.length < Math.min(target, pool.length)) {
    const remaining = pool.filter(item => !selected.includes(item));
    const next = remaining.sort((a, b) => {
      const aDistance = Math.min(...selected.map(item => hammingDistance(a.perceptualHash, item.perceptualHash)));
      const bDistance = Math.min(...selected.map(item => hammingDistance(b.perceptualHash, item.perceptualHash)));
      return (bDistance * 10 + b.qualityScore) - (aDistance * 10 + a.qualityScore);
    })[0];
    if (!next) break;
    const distance = Math.min(...selected.map(item => hammingDistance(next.perceptualHash, item.perceptualHash)));
    if (distance < 4 && selected.length >= 3) break;
    selected.push(next);
  }
  return selected.sort((a, b) => a.capturedAtMs - b.capturedAtMs);
}

export async function extractVideoFrames(file: File, onProgress?: (progress: number) => void): Promise<ExtractedVideoFrame[]> {
  if (!file.type.startsWith('video/')) throw new Error('请选择视频文件');
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.preload = 'metadata';
  video.muted = true;
  video.playsInline = true;
  video.src = url;
  try {
    await waitFor(video, 'loadedmetadata');
    if (!Number.isFinite(video.duration) || video.duration <= 0 || !video.videoWidth || !video.videoHeight) throw new Error('视频无法解码，请改用截图或照片');
    const sampleCount = Math.max(8, Math.min(16, Math.ceil(video.duration / 2)));
    const targetCount = video.duration < 15 ? 3 : video.duration < 35 ? 4 : 6;
    const scale = Math.min(1, 960 / Math.max(video.videoWidth, video.videoHeight));
    const width = Math.max(1, Math.round(video.videoWidth * scale));
    const height = Math.max(1, Math.round(video.videoHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', {alpha: false, willReadFrequently: true});
    if (!context) throw new Error('当前浏览器无法处理视频，请改用截图或照片');
    const candidates: Candidate[] = [];
    for (let index = 0; index < sampleCount; index += 1) {
      const time = Math.min(Math.max(0, video.duration - 0.05), ((index + 0.5) / sampleCount) * video.duration);
      const seeked = waitFor(video, 'seeked');
      video.currentTime = time;
      await seeked;
      context.drawImage(video, 0, 0, width, height);
      const pixels = context.getImageData(0, 0, width, height);
      const inspected = inspectPixels(pixels.data, width, height);
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.86));
      if (!blob) continue;
      candidates.push({
        id: `${index}-${Math.round(time * 1000)}`, blob, width, height, frameIndex: index,
        capturedAtMs: Math.round(time * 1000), perceptualHash: inspected.hash,
        brightness: inspected.brightness, sharpness: inspected.sharpness,
        qualityScore: Math.min(inspected.sharpness, 40) - Math.abs(inspected.brightness - 128) / 12,
      });
      onProgress?.((index + 1) / sampleCount);
    }
    const selected = selectRepresentativeFrames(candidates, targetCount);
    if (!selected.length) throw new Error('没有找到可用画面，请改用截图或照片');
    return selected.map(({qualityScore: _qualityScore, ...frame}) => frame);
  } finally {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}
