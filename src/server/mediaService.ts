import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { MediaAssetRecord, QuestionItem, StimulusGroup, VisualSpec } from '../shared/contracts.ts';
import { getAdminStorage, isStorageBucketConfigured } from './firebaseAdmin.ts';

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const EXT_TO_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

export function sanitizeSvgBuffer(buf: Buffer): Buffer {
  const raw = buf.toString('utf8');
  const cleaned = raw
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/javascript:/gi, '');
  return Buffer.from(cleaned, 'utf8');
}

export function validateAndDecodeUpload(input: {
  questionId?: string;
  filename: string;
  imageBase64: string;
}): { ext: string; mimeType: string; buffer: Buffer; sha256: string; objectKey: string; assetId: string } {
  const ext = path.extname(String(input.filename || '')).toLowerCase();
  const mimeType = EXT_TO_MIME[ext];
  if (!mimeType) {
    throw new Error('Unsupported image extension. Allowed: .png, .jpg, .jpeg, .webp, .svg.');
  }

  const rawB64 = String(input.imageBase64 || '').replace(/^data:[^;]+;base64,/, '');
  if (!rawB64) {
    throw new Error('Empty image payload.');
  }

  let buffer: Buffer = Buffer.from(rawB64, 'base64');
  if (buffer.length === 0) {
    throw new Error('Decoded image payload is empty.');
  }
  if (buffer.length > MAX_UPLOAD_BYTES) {
    throw new Error('Image upload exceeds maximum size of 5 MB.');
  }

  if (ext === '.svg') {
    buffer = sanitizeSvgBuffer(buffer);
  }

  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const safeQid = (input.questionId || 'bank').replace(/[^a-zA-Z0-9_-]/g, '_');
  const shortHash = sha256.slice(0, 12);
  const objectKey = `question-media/${safeQid}/${shortHash}${ext}`;
  const assetId = `med_${safeQid}_${shortHash}`;
  return { ext, mimeType, buffer, sha256, objectKey, assetId };
}

export async function storeMediaUpload(input: {
  questionId?: string;
  filename: string;
  imageBase64: string;
  uploadsDir: string;
}): Promise<MediaAssetRecord> {
  const decoded = validateAndDecodeUpload(input);
  const nowIso = new Date().toISOString();

  if (isStorageBucketConfigured()) {
    const bucket = getAdminStorage().bucket();
    const file = bucket.file(decoded.objectKey);
    await file.save(decoded.buffer, {
      resumable: false,
      metadata: {
        contentType: decoded.mimeType,
        cacheControl: 'public, max-age=31536000, immutable',
        metadata: {
          assetId: decoded.assetId,
          questionId: input.questionId || '',
          sha256: decoded.sha256,
        },
      },
    });
    return {
      assetId: decoded.assetId,
      questionId: input.questionId,
      objectKey: decoded.objectKey,
      url: `/api/media/${decoded.assetId}`,
      mimeType: decoded.mimeType,
      sizeBytes: decoded.buffer.length,
      sha256: decoded.sha256,
      storageProvider: 'gcs',
      createdAtIso: nowIso,
    };
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'Cloud Storage bucket configuration is required for media uploads in production.'
    );
  }

  await fs.mkdir(input.uploadsDir, { recursive: true });
  const localFilename = `${decoded.assetId}${decoded.ext}`;
  await fs.writeFile(path.join(input.uploadsDir, localFilename), decoded.buffer);

  return {
    assetId: decoded.assetId,
    questionId: input.questionId,
    objectKey: decoded.objectKey,
    url: `/assets/uploads/${localFilename}`,
    mimeType: decoded.mimeType,
    sizeBytes: decoded.buffer.length,
    sha256: decoded.sha256,
    storageProvider: 'local_temp',
    createdAtIso: nowIso,
  };
}

export async function readMediaBytesFromStorage(asset: MediaAssetRecord, uploadsDir: string): Promise<Buffer | null> {
  if (asset.storageProvider === 'gcs' && isStorageBucketConfigured()) {
    const bucket = getAdminStorage().bucket();
    const file = bucket.file(asset.objectKey);
    const [exists] = await file.exists();
    if (!exists) return null;
    const [contents] = await file.download();
    return contents;
  }

  const fileName = path.basename(asset.url);
  try {
    return await fs.readFile(path.join(uploadsDir, fileName));
  } catch {
    return null;
  }
}

export interface MediaMigrationItem {
  sourcePath: string;
  referencedByIds: string[];
  existsLocally: boolean;
  sizeBytes?: number;
  sha256?: string;
  suggestedObjectKey: string;
  status: 'needs_upload' | 'missing_file' | 'already_gcs';
}

export interface MediaMigrationManifest {
  generatedAtIso: string;
  uploadsDir: string;
  totalLocalFiles: number;
  totalReferencedUploadUrls: number;
  missingFilesCount: number;
  needsUploadCount: number;
  alreadyGcsCount: number;
  items: MediaMigrationItem[];
}

function collectUploadUrlsFromVisual(v: VisualSpec | undefined, ownerId: string, out: Map<string, Set<string>>) {
  if (!v?.imageUrl) return;
  if (v.imageUrl.startsWith('/assets/uploads/') || v.imageUrl.startsWith('/api/media/')) {
    const set = out.get(v.imageUrl) || new Set<string>();
    set.add(ownerId);
    out.set(v.imageUrl, set);
  }
}

export async function buildMediaMigrationManifest(input: {
  questions: QuestionItem[];
  stimuli: StimulusGroup[];
  mediaAssets: MediaAssetRecord[];
  uploadsDir: string;
}): Promise<MediaMigrationManifest> {
  const refs = new Map<string, Set<string>>();
  for (const q of input.questions) {
    collectUploadUrlsFromVisual(q.visual, q.questionId, refs);
    for (const p of q.parts) {
      for (const o of p.options) {
        collectUploadUrlsFromVisual(o.visual, `${q.questionId}#${p.partId}:${o.key}`, refs);
      }
    }
  }
  for (const s of input.stimuli) {
    collectUploadUrlsFromVisual(s.visual, s.stimulusId, refs);
  }

  let localFiles: string[] = [];
  try {
    const entries = await fs.readdir(input.uploadsDir, { withFileTypes: true });
    localFiles = entries.filter((e) => e.isFile()).map((e) => e.name);
  } catch {
    localFiles = [];
  }

  const allUrls = new Set<string>(refs.keys());
  for (const f of localFiles) {
    allUrls.add(`/assets/uploads/${f}`);
  }

  const assetsByUrl = new Map(input.mediaAssets.map((a) => [a.url, a]));
  const items: MediaMigrationItem[] = [];

  for (const urlPath of Array.from(allUrls).sort()) {
    const owners = Array.from(refs.get(urlPath) || []);
    const existingAsset = assetsByUrl.get(urlPath);
    if (existingAsset?.storageProvider === 'gcs') {
      items.push({
        sourcePath: urlPath,
        referencedByIds: owners,
        existsLocally: false,
        sizeBytes: existingAsset.sizeBytes,
        sha256: existingAsset.sha256,
        suggestedObjectKey: existingAsset.objectKey,
        status: 'already_gcs',
      });
      continue;
    }

    const baseName = path.basename(urlPath);
    const fullPath = path.join(input.uploadsDir, baseName);
    try {
      const buf = await fs.readFile(fullPath);
      const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
      const ext = path.extname(baseName).toLowerCase() || '.png';
      const ownerPrefix = (owners[0] || 'unreferenced').replace(/[^a-zA-Z0-9_-]/g, '_');
      items.push({
        sourcePath: urlPath,
        referencedByIds: owners,
        existsLocally: true,
        sizeBytes: buf.length,
        sha256,
        suggestedObjectKey: `question-media/${ownerPrefix}/${sha256.slice(0, 12)}${ext}`,
        status: 'needs_upload',
      });
    } catch {
      items.push({
        sourcePath: urlPath,
        referencedByIds: owners,
        existsLocally: false,
        suggestedObjectKey: `question-media/missing/${baseName}`,
        status: 'missing_file',
      });
    }
  }

  return {
    generatedAtIso: new Date().toISOString(),
    uploadsDir: input.uploadsDir,
    totalLocalFiles: localFiles.length,
    totalReferencedUploadUrls: refs.size,
    missingFilesCount: items.filter((i) => i.status === 'missing_file').length,
    needsUploadCount: items.filter((i) => i.status === 'needs_upload').length,
    alreadyGcsCount: items.filter((i) => i.status === 'already_gcs').length,
    items,
  };
}
