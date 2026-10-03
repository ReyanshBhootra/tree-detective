// Shrinks a phone photo to a JPEG about 1600px wide before upload. Phone
// photos are often 4-12 MB, which is slow on campus wifi and too big for some
// image services. iPhone HEIC photos come out as JPEG too, where the browser
// can decode them. If anything fails, the original file is sent as-is.
export async function shrinkPhoto(file, max = 1600, quality = 0.85) {
  if (!file?.size) return file;
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    if (scale === 1 && file.type === 'image/jpeg' && file.size < 3_500_000) return file;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close?.();
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', quality));
    return blob ? new File([blob], 'tree.jpg', { type: 'image/jpeg' }) : file;
  } catch {
    return file;
  }
}
