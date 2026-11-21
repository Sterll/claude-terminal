/**
 * Project images - a picture of the user's choosing as a project's glyph.
 *
 * The picked file is read through the fs bridge (the file dialog granted it),
 * decoded from a blob: URL, cropped to a centred square and scaled down to
 * IMAGE_SIZE, then kept on the project itself as a small data: URL. Stored
 * inline rather than as a file of its own: a few kilobytes, nothing to clean
 * up when the project goes, and it travels with projects.json through the
 * three-way merge and cloud sync like any other field.
 *
 * Whatever comes back out of projects.json is re-checked before it reaches
 * a src attribute (isSafeImage): that file is writable by other processes.
 */

const IMAGE_SIZE = 96;
const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const SAFE_DATA_URL = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/;

/** True for a data: URL this module could have produced, and nothing else. */
function isSafeImage(value) {
  return typeof value === 'string' && value.length < 200_000 && SAFE_DATA_URL.test(value);
}

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp', svg: 'image/svg+xml' };

function decode(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('The image could not be read'));
    img.src = url;
  });
}

/**
 * Crop to a centred square and scale to `size`. WebP when the engine can
 * write it (smallest), PNG otherwise.
 * @returns {string} data: URL
 */
function toSquareDataUrl(img, size = IMAGE_SIZE) {
  const side = Math.min(img.naturalWidth || img.width, img.naturalHeight || img.height);
  if (!side) throw new Error('The image is empty');
  const sx = ((img.naturalWidth || img.width) - side) / 2;
  const sy = ((img.naturalHeight || img.height) - side) / 2;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
  const webp = canvas.toDataURL('image/webp', 0.86);
  return webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/png');
}

/**
 * Ask for an image file and return it as a project glyph, or null if the
 * user cancelled.
 * @param {{ api: object, fsp: object }} deps
 * @returns {Promise<string|null>}
 */
async function pickProjectImage({ api, fsp }) {
  const file = await api.dialog.selectFile({
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg'] }],
  });
  if (!file) return null;
  const ext = String(file).split('.').pop().toLowerCase();
  const bytes = await fsp.readFile(file);
  if (!bytes || bytes.length > MAX_SOURCE_BYTES) throw new Error('The image is too large (20 MB max)');
  const url = URL.createObjectURL(new Blob([bytes], { type: MIME[ext] || 'application/octet-stream' }));
  try {
    const img = await decode(url);
    const dataUrl = toSquareDataUrl(img);
    if (!isSafeImage(dataUrl)) throw new Error('The image could not be converted');
    return dataUrl;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** A stable, muted colour for a project without one, from its name. */
const AVATAR_PALETTE = ['#6366f1', '#0ea5e9', '#14b8a6', '#22c55e', '#eab308', '#f97316', '#ef4444', '#ec4899', '#a855f7', '#64748b'];
function avatarColor(name) {
  let h = 0;
  for (const ch of String(name || '')) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return AVATAR_PALETTE[h % AVATAR_PALETTE.length];
}

module.exports = { pickProjectImage, isSafeImage, toSquareDataUrl, avatarColor, IMAGE_SIZE };
