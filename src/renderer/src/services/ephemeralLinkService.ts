import {
  supabase,
  BUCKET_NAME,
  supabaseConfigurationError,
} from '../../../shared/supabaseClient'

const DEFAULT_EXPIRY_SECONDS = 604800
let expiryCleanupStarted = false

async function cleanupExpiredSnapshotAssets(): Promise<void> {
  if (expiryCleanupStarted || supabaseConfigurationError) return
  expiryCleanupStarted = true
  try {
    const { data, error } = await supabase.rpc('list_expired_qa_object_paths', { batch_size: 100 })
    if (error) throw error
    const paths = (Array.isArray(data) ? data : [])
      .map((row) => String((row as { object_path?: unknown }).object_path || ''))
      .filter(Boolean)
    if (!paths.length) return
    const { error: removeError } = await supabase.storage.from(BUCKET_NAME).remove(paths)
    if (removeError) throw removeError
    const { error: finalizeError } = await supabase.rpc('finalize_expired_qa_cleanup', { object_paths: paths })
    if (finalizeError) throw finalizeError
  } catch (error) {
    console.warn('Expired QA asset cleanup was deferred:', error)
    expiryCleanupStarted = false
  }
}

function richAssetPath(site: string, masterId: string, scope: string, index: number): string {
  const safeScope = scope.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-|-$/g, '') || 'note'
  return `sites/${site}/${masterId}/assets/${safeScope}_${index}.webp`
}

async function prepareRichTextAssets(params: {
  html?: string
  siteSlug: string
  masterId: string
  scope: string
  expiresAt: string
}): Promise<string> {
  const html = params.html || ''
  if (!html || !html.includes('<img')) return html
  const documentNode = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
  const images = Array.from(documentNode.body.querySelectorAll('img'))
  const site = normalizeSiteSlug(params.siteSlug)

  for (let index = 0; index < images.length; index += 1) {
    const image = images[index]
    if (image.dataset.qaAsset) {
      image.removeAttribute('src')
      continue
    }
    const source = image.getAttribute('src') || ''
    if (!/^data:image\/(?:png|jpe?g|webp|gif);base64,/i.test(source)) {
      image.remove()
      continue
    }
    const blob = await (await fetch(source)).blob()
    if (!blob.type.startsWith('image/')) throw new Error('An attached description image is invalid.')
    if (blob.size > 5 * 1024 * 1024) throw new Error('A compressed description image exceeds 5 MB.')
    const objectPath = richAssetPath(site, params.masterId, params.scope, index)
    const { error: registryError } = await supabase
      .from('qa_snapshot_assets')
      .upsert({
        site_slug: site,
        master_id: params.masterId,
        object_path: objectPath,
        expires_at: params.expiresAt,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'object_path' })
    if (registryError) throw new Error(errorMessage('Could not register a rich-text image', registryError))
    const { error: uploadError } = await supabase.storage
      .from(BUCKET_NAME)
      .upload(objectPath, blob, { contentType: 'image/webp', upsert: true })
    if (uploadError) throw new Error(errorMessage('Rich-text image upload failed', uploadError))
    image.dataset.qaAsset = objectPath
    image.removeAttribute('src')
    image.alt = image.alt || 'Attached image'
  }

  return documentNode.body.innerHTML
}

async function prepareAnnotationsForSharing(
  annotations: unknown[],
  siteSlug: string,
  masterId: string,
  expiresAt: string,
): Promise<unknown[]> {
  return Promise.all(annotations.map(async (entry, index) => {
    if (!entry || typeof entry !== 'object' || !('notes' in entry)) return entry
    const annotation = entry as Record<string, unknown>
    const notes = typeof annotation.notes === 'string' ? annotation.notes : ''
    return {
      ...annotation,
      notes: await prepareRichTextAssets({
        html: notes,
        siteSlug,
        masterId,
        scope: `annotation-${String(annotation.id || index)}`,
        expiresAt,
      }),
    }
  }))
}

export interface EphemeralCropParams {
  masterDataUrl: string
  cropRect: {
    x: number
    y: number
    width: number
    height: number
  }
  badgeNumber: number
  title?: string
  notes?: string
  color?: string
  siteSlug?: string
  masterId?: string
  annotation?: Record<string, unknown>
  inspectionOverlays?: unknown[]
  viewport?: {
    key: string
    name: string
    width: number
    height: number
    deviceType?: string
  }
  expiresInSeconds?: number
}

export interface EphemeralLinkResult {
  success: boolean
  shareUrl?: string
  signedStorageUrl?: string
  snapshotId?: string
  expiresAt?: string
  error?: string
}

export interface MasterUploadResult {
  success: boolean
  signedStorageUrl?: string
  objectPath?: string
  expiresAt?: string
  error?: string
}

interface SnapshotMetadataParams {
  siteSlug: string
  masterId: string
  itemNumber: number
  title?: string
  notes?: string
  color?: string
  objectPath: string
  annotations?: unknown[]
  expiresAt: string
}

export function normalizeSiteSlug(value?: string): string {
  return (value || 'website-default')
    .toLowerCase()
    .replace(/^https?:\/\//i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'website-default'
}

function errorMessage(prefix: string, error: unknown): string {
  const detail =
    typeof error === 'object' && error && 'message' in error
      ? String((error as { message?: unknown }).message || '')
      : String(error || '')
  return detail ? `${prefix}: ${detail}` : prefix
}

function requireSupabaseConfiguration(): string | null {
  return supabaseConfigurationError
}

async function saveSnapshotMetadata(params: SnapshotMetadataParams): Promise<string | null> {
  const { error } = await supabase
    .from('qa_snapshots')
    .upsert(
      {
        site_slug: normalizeSiteSlug(params.siteSlug),
        master_id: params.masterId,
        item_number: params.itemNumber,
        title: params.title || '',
        notes: params.notes || '',
        color: params.color || '#ff0055',
        object_path: params.objectPath,
        annotations: params.annotations || [],
        expires_at: params.expiresAt,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'site_slug,master_id,item_number' },
    )

  return error ? errorMessage('Could not save snapshot metadata', error) : null
}

export async function updateMasterAnnotations(params: {
  siteSlug: string
  masterId: string
  objectPath: string
  annotations: unknown[]
  expiresAt: string
}): Promise<{ success: boolean; error?: string }> {
  const configError = requireSupabaseConfiguration()
  if (configError) return { success: false, error: configError }

  try {
    const preparedAnnotations = await prepareAnnotationsForSharing(
      params.annotations,
      params.siteSlug,
      params.masterId,
      params.expiresAt,
    )
    const metadataError = await saveSnapshotMetadata({
      siteSlug: params.siteSlug,
      masterId: params.masterId,
      itemNumber: 0,
      title: `${params.siteSlug} full-site capture`,
      objectPath: params.objectPath,
      annotations: preparedAnnotations,
      expiresAt: params.expiresAt,
    })
    return metadataError ? { success: false, error: metadataError } : { success: true }
  } catch (error) {
    return { success: false, error: errorMessage('Could not update annotations', error) }
  }
}

export async function cropRegionToBlob(
  masterDataUrl: string,
  rect: { x: number; y: number; width: number; height: number },
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const sourceX = Math.max(0, Math.min(img.naturalWidth - 1, Math.round(rect.x)))
      const sourceY = Math.max(0, Math.min(img.naturalHeight - 1, Math.round(rect.y)))
      const sourceWidth = Math.max(1, Math.min(img.naturalWidth - sourceX, Math.round(rect.width)))
      const sourceHeight = Math.max(1, Math.min(img.naturalHeight - sourceY, Math.round(rect.height)))
      const canvas = document.createElement('canvas')
      canvas.width = sourceWidth
      canvas.height = sourceHeight
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        reject(new Error('The browser could not create the crop canvas.'))
        return
      }

      ctx.drawImage(
        img,
        sourceX,
        sourceY,
        sourceWidth,
        sourceHeight,
        0,
        0,
        sourceWidth,
        sourceHeight,
      )

      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('The crop could not be encoded as PNG.'))),
        'image/png',
      )
    }
    img.onerror = () => reject(new Error('The captured page image could not be decoded.'))
    img.src = masterDataUrl
  })
}

export async function uploadMasterImage(
  masterDataUrl: string,
  siteSlug: string,
  masterId: string,
  annotations: unknown[] = [],
  expiresInSeconds = DEFAULT_EXPIRY_SECONDS,
): Promise<MasterUploadResult> {
  void cleanupExpiredSnapshotAssets()
  const configError = requireSupabaseConfiguration()
  if (configError) return { success: false, error: configError }
  if (!masterDataUrl.startsWith('data:image/')) {
    return { success: false, error: 'The full-page capture is missing or invalid.' }
  }

  try {
    const site = normalizeSiteSlug(siteSlug)
    const filePath = `sites/${site}/${masterId}_master.png`
    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString()
    const response = await fetch(masterDataUrl)
    if (!response.ok) throw new Error(`Capture conversion failed (${response.status}).`)
    const blob = await response.blob()

    const preparedAnnotations = await prepareAnnotationsForSharing(
      annotations,
      site,
      masterId,
      expiresAt,
    )
    const metadataError = await saveSnapshotMetadata({
      siteSlug: site,
      masterId,
      itemNumber: 0,
      title: `${siteSlug} full-site capture`,
      objectPath: filePath,
      annotations: preparedAnnotations,
      expiresAt,
    })
    if (metadataError) return { success: false, error: metadataError }

    // The private bucket's SELECT policy only exposes objects with active
    // metadata. Register first because Storage uploads use INSERT … RETURNING
    // (and upserts also require SELECT permission on the returned object).
    const { error: uploadError } = await supabase.storage
      .from(BUCKET_NAME)
      .upload(filePath, blob, { contentType: 'image/png', upsert: true })
    if (uploadError) return { success: false, error: errorMessage('Master image upload failed', uploadError) }

    return {
      success: true,
      objectPath: filePath,
      expiresAt,
    }
  } catch (error) {
    return { success: false, error: errorMessage('Master image upload failed', error) }
  }
}

export async function generateEphemeralLink(
  params: EphemeralCropParams,
): Promise<EphemeralLinkResult> {
  void cleanupExpiredSnapshotAssets()
  const configError = requireSupabaseConfiguration()
  if (configError) return { success: false, error: configError }

  try {
    const {
      masterDataUrl,
      cropRect,
      badgeNumber,
      title,
      notes,
      color,
      siteSlug,
      masterId,
      annotation,
      inspectionOverlays = [],
      viewport,
      expiresInSeconds = DEFAULT_EXPIRY_SECONDS,
    } = params

    if (![cropRect.x, cropRect.y, cropRect.width, cropRect.height].every(Number.isFinite)) {
      return { success: false, error: 'The annotation crop coordinates are invalid.' }
    }
    if (cropRect.width <= 0 || cropRect.height <= 0) {
      return { success: false, error: 'The annotation crop is empty.' }
    }

    const site = normalizeSiteSlug(siteSlug)
    const sessionMasterId = masterId || `snap_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 7)}`
    const blob = await cropRegionToBlob(masterDataUrl, cropRect)
    const snapshotId = `item_${badgeNumber}_${Math.random().toString(36).substring(2, 7)}`
    const filePath = `sites/${site}/${sessionMasterId}_${snapshotId}.png`
    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString()

    const processedNotes = await prepareRichTextAssets({
      html: notes,
      siteSlug: site,
      masterId: sessionMasterId,
      scope: `annotation-${String(annotation?.id || badgeNumber)}`,
      expiresAt,
    })
    const preparedAnnotation = annotation
      ? { ...annotation, notes: processedNotes }
      : annotation
    const metadataError = await saveSnapshotMetadata({
      siteSlug: site,
      masterId: sessionMasterId,
      itemNumber: badgeNumber,
      title: title || `Item #${badgeNumber}`,
      notes: processedNotes,
      color,
      objectPath: filePath,
      annotations: [
        ...(preparedAnnotation ? [preparedAnnotation] : []),
        ...(inspectionOverlays.length
          ? [{ id: '__inspection_manifest__', kind: 'inspection-manifest', overlays: inspectionOverlays, viewport }]
          : []),
      ],
      expiresAt,
    })
    if (metadataError) return { success: false, error: metadataError }

    const { error: uploadError } = await supabase.storage
      .from(BUCKET_NAME)
      .upload(filePath, blob, { contentType: 'image/png', upsert: false })
    if (uploadError) return { success: false, error: errorMessage('Item image upload failed', uploadError) }

    const viewerBaseUrl = import.meta.env?.VITE_EPHEMERAL_VIEWER_URL || 'https://qa-snapshots.pages.dev'
    const queryParams = new URLSearchParams({
      site,
      id: sessionMasterId,
      item: String(badgeNumber),
    })

    return {
      success: true,
      shareUrl: `${viewerBaseUrl}/?${queryParams.toString()}`,
      snapshotId,
      expiresAt,
    }
  } catch (error) {
    return { success: false, error: errorMessage('Item link generation failed', error) }
  }
}
