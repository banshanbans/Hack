export async function normalizeImage(file: File, maxDimension = 2048, quality = 0.84): Promise<{blob: Blob; width: number; height: number}> {
  let source: ImageBitmap | HTMLImageElement;
  try {
    source = await createImageBitmap(file, {imageOrientation: 'from-image'});
  } catch {
    source = await new Promise((resolve, reject) => {
      const image = new Image();
      const url = URL.createObjectURL(file);
      image.onload = () => {
        URL.revokeObjectURL(url);
        resolve(image);
      };
      image.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('照片处理失败'));
      };
      image.src = url;
    });
  }
  const scale = Math.min(1, maxDimension / Math.max(source.width, source.height));
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', {alpha: false});
  if (!context) throw new Error('照片处理失败');
  context.drawImage(source, 0, 0, width, height);
  if ('close' in source && typeof source.close === 'function') source.close();
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
  if (!blob) throw new Error('照片处理失败');
  return {blob, width, height};
}
