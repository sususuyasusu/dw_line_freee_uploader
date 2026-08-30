'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAGIC = {
  jpeg: Buffer.from([0xff, 0xd8, 0xff]),
  png: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
};

function detectImageType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) return null;
  if (buffer.subarray(0, 3).equals(MAGIC.jpeg)) return 'jpeg';
  if (buffer.subarray(0, 8).equals(MAGIC.png)) return 'png';
  return null;
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function extensionFor(type) {
  if (type === 'jpeg') return 'jpg';
  if (type === 'png') return 'png';
  throw new Error(`Unsupported image type: ${type}`);
}

function contentTypeFor(type) {
  if (type === 'jpeg') return 'image/jpeg';
  if (type === 'png') return 'image/png';
  throw new Error(`Unsupported image type: ${type}`);
}

async function compressIfNeeded(buffer, type, maxBytes) {
  if (buffer.length <= maxBytes) return { buffer, type };
  // Lazy require — sharp is a heavy native dep; only load when we actually need it.
  const sharp = require('sharp');
  let quality = 80;
  let current = buffer;
  for (let i = 0; i < 4; i += 1) {
    const pipeline = sharp(current).rotate();
    const out =
      type === 'png'
        ? await pipeline.png({ compressionLevel: 9, quality }).toBuffer()
        : await pipeline.jpeg({ quality, mozjpeg: true }).toBuffer();
    if (out.length <= maxBytes) return { buffer: out, type };
    current = out;
    quality = Math.max(40, quality - 15);
  }
  // Last resort: downscale.
  const downscaled = await sharp(current)
    .rotate()
    .resize({ width: 2000, withoutEnlargement: true })
    .jpeg({ quality: 70, mozjpeg: true })
    .toBuffer();
  return { buffer: downscaled, type: 'jpeg' };
}

async function persistTemp(tmpDir, buffer, basename) {
  fs.mkdirSync(tmpDir, { recursive: true });
  const filepath = path.join(tmpDir, basename);
  await fs.promises.writeFile(filepath, buffer);
  return filepath;
}

async function safeUnlink(filepath) {
  try {
    await fs.promises.unlink(filepath);
  } catch (_err) {
    /* ignore */
  }
}

module.exports = {
  detectImageType,
  sha256,
  extensionFor,
  contentTypeFor,
  compressIfNeeded,
  persistTemp,
  safeUnlink,
};
