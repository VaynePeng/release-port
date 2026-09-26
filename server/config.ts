import path from 'node:path'

const root = process.cwd()

export const config = {
  port: Number(process.env.RELEASE_PORT_API_PORT ?? 8787),
  dataDir: path.resolve(root, process.env.RELEASE_PORT_DATA_DIR ?? 'data'),
  uploadDir: path.resolve(root, process.env.RELEASE_PORT_UPLOAD_DIR ?? 'uploads'),
  seedDemo: process.env.RELEASE_PORT_SEED_DEMO === 'true',
}
