import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../config.js';

// Saves a submitted photo and returns a URL the dashboard can show.
// Azure Blob Storage when configured, otherwise the local uploads/ folder.
export function createPhotoStore(env = process.env) {
  if (env.AZURE_STORAGE_CONNECTION_STRING) {
    let container;
    return {
      kind: 'azure-blob',
      async save(name, buffer, contentType) {
        if (!container) {
          const { BlobServiceClient } = await import('@azure/storage-blob');
          container = BlobServiceClient.fromConnectionString(env.AZURE_STORAGE_CONNECTION_STRING)
            .getContainerClient(env.AZURE_BLOB_CONTAINER || 'tree-photos');
          await container.createIfNotExists({ access: 'blob' });
        }
        const blob = container.getBlockBlobClient(name);
        await blob.uploadData(buffer, { blobHTTPHeaders: { blobContentType: contentType } });
        return blob.url;
      },
    };
  }
  const dir = env.UPLOAD_DIR || path.join(ROOT, 'uploads');
  return {
    kind: 'local',
    dir,
    async save(name, buffer) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, name), buffer);
      return `/uploads/${name}`;
    },
  };
}
