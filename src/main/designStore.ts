import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import sharp from 'sharp'
import { BREAKPOINTS, detectDesignScale, isBreakpoint, type Breakpoint } from '../shared/designScale'
import type {
  DesignListResult,
  DesignPutOptions,
  DesignPutResponse,
  DesignSlots,
  DesignUpdateOptions,
  DesignUpdateResponse,
} from '../shared/qaAgent'

// Figma exports per breakpoint, owned by the main process so the QA agent can read
// them without the renderer. The root folder is injected so tests can use a temp dir.

export const MAX_DESIGN_BYTES = 100 * 1024 * 1024
const THUMBNAIL_WIDTH = 360
const SCALES = new Set([1, 1.5, 2, 3, 4])

interface StoreMeta {
  version: 1
  slots: DesignSlots
}

function directoryName(projectKey: string): string {
  const safe = projectKey.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60) || 'project'
  return `${safe}-${createHash('sha256').update(projectKey).digest('hex').slice(0, 8)}`
}

function hasImageSignature(bytes: Buffer): boolean {
  const png = bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  const jpeg = bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  const webp = bytes.length > 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
  return png || jpeg || webp
}

function writeAtomic(file: string, data: string | Buffer): void {
  const temporary = `${file}.tmp`
  writeFileSync(temporary, data)
  try {
    renameSync(temporary, file)
  } catch {
    rmSync(file, { force: true })
    renameSync(temporary, file)
  }
}

export function createDesignStore(root: string) {
  const directory = (projectKey: string) => join(root, directoryName(projectKey))
  const slotFile = (projectKey: string, breakpoint: Breakpoint) => join(directory(projectKey), `${breakpoint}.png`)
  const normalizedFile = (projectKey: string, breakpoint: Breakpoint) => join(directory(projectKey), `${breakpoint}@1x.png`)
  const metaFile = (projectKey: string) => join(directory(projectKey), 'meta.json')

  function readMeta(projectKey: string): StoreMeta {
    try {
      const parsed = JSON.parse(readFileSync(metaFile(projectKey), 'utf8')) as StoreMeta
      const slots: DesignSlots = {}
      for (const breakpoint of BREAKPOINTS) {
        const slot = parsed?.slots?.[breakpoint]
        if (slot && existsSync(slotFile(projectKey, breakpoint))) slots[breakpoint] = slot
      }
      return { version: 1, slots }
    } catch {
      return { version: 1, slots: {} }
    }
  }

  function writeMeta(projectKey: string, meta: StoreMeta): void {
    mkdirSync(directory(projectKey), { recursive: true })
    writeAtomic(metaFile(projectKey), JSON.stringify(meta, null, 2))
  }

  const dropNormalized = (projectKey: string, breakpoint: Breakpoint) => rmSync(normalizedFile(projectKey, breakpoint), { force: true })

  return {
    list(projectKey: string): DesignSlots {
      return readMeta(projectKey).slots
    },

    async listWithThumbnails(projectKey: string): Promise<DesignListResult> {
      const slots = readMeta(projectKey).slots
      const thumbnails: DesignListResult['thumbnails'] = {}
      for (const breakpoint of BREAKPOINTS) {
        if (!slots[breakpoint]) continue
        try {
          const jpeg = await sharp(slotFile(projectKey, breakpoint)).resize({ width: THUMBNAIL_WIDTH, withoutEnlargement: true }).jpeg({ quality: 70 }).toBuffer()
          thumbnails[breakpoint] = `data:image/jpeg;base64,${jpeg.toString('base64')}`
        } catch {
          // A broken thumbnail should not hide the slot.
        }
      }
      return { slots, thumbnails }
    },

    async put(projectKey: string, input: Uint8Array | Buffer, options: DesignPutOptions = {}): Promise<DesignPutResponse> {
      try {
        if (!projectKey) return { success: false, error: 'Open a project before adding a design.' }
        const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input)
        if (bytes.length > MAX_DESIGN_BYTES) return { success: false, error: 'Design images over 100 MB are not supported.' }
        if (!hasImageSignature(bytes)) return { success: false, error: 'That file is not a PNG, JPEG or WebP image.' }

        const sha256 = createHash('sha256').update(bytes).digest('hex')
        const meta = readMeta(projectKey)
        const existing = BREAKPOINTS.find((breakpoint) => meta.slots[breakpoint]?.sha256 === sha256)
        const wanted = options.target && options.target !== 'auto' ? options.target : undefined
        if (wanted && !isBreakpoint(wanted)) return { success: false, error: 'Unknown breakpoint.' }
        if (existing && (!wanted || wanted === existing)) return { success: true, assigned: existing, unchanged: true, slots: meta.slots }

        const info = await sharp(bytes).metadata()
        if (!info.width || !info.height) return { success: false, error: 'The image could not be read.' }
        const detected = detectDesignScale({ pixelWidth: info.width, fileName: options.fileName, slotHint: wanted })
        const breakpoint = wanted ?? detected.breakpoint

        const png = info.format === 'png' ? bytes : await sharp(bytes).png().toBuffer()
        mkdirSync(directory(projectKey), { recursive: true })
        writeAtomic(slotFile(projectKey, breakpoint), png)
        dropNormalized(projectKey, breakpoint)
        meta.slots[breakpoint] = {
          breakpoint,
          fileName: options.fileName,
          pagePath: options.pagePath,
          pixelWidth: info.width,
          pixelHeight: info.height,
          scale: detected.scale,
          frameWidth: detected.frameWidth,
          frameHeight: Math.round(info.height / detected.scale),
          detection: detected.detection,
          confidence: detected.confidence,
          sha256,
          addedAt: Date.now(),
        }
        writeMeta(projectKey, meta)
        return { success: true, assigned: breakpoint, unchanged: false, slots: meta.slots }
      } catch (error: any) {
        return { success: false, error: error?.message || 'The design could not be saved.' }
      }
    },

    update(projectKey: string, breakpoint: Breakpoint, options: DesignUpdateOptions): DesignUpdateResponse {
      try {
        if (!isBreakpoint(breakpoint)) return { success: false, error: 'Unknown breakpoint.' }
        const meta = readMeta(projectKey)
        const slot = meta.slots[breakpoint]
        if (!slot) return { success: false, error: 'There is no design in that slot.' }

        if (options.scale !== undefined) {
          if (!SCALES.has(options.scale)) return { success: false, error: 'Scale must be 1, 1.5, 2, 3 or 4.' }
          meta.slots[breakpoint] = {
            ...slot,
            scale: options.scale,
            frameWidth: Math.round(slot.pixelWidth / options.scale),
            frameHeight: Math.round(slot.pixelHeight / options.scale),
            detection: 'manual',
            confidence: 'high',
          }
          dropNormalized(projectKey, breakpoint)
        }

        if (options.moveTo && options.moveTo !== breakpoint) {
          if (!isBreakpoint(options.moveTo)) return { success: false, error: 'Unknown breakpoint.' }
          const target = options.moveTo
          const moving = meta.slots[breakpoint]!
          const displaced = meta.slots[target]
          const temporary = `${slotFile(projectKey, breakpoint)}.swap`
          if (displaced) {
            renameSync(slotFile(projectKey, target), temporary)
            renameSync(slotFile(projectKey, breakpoint), slotFile(projectKey, target))
            renameSync(temporary, slotFile(projectKey, breakpoint))
            meta.slots[breakpoint] = { ...displaced, breakpoint }
          } else {
            renameSync(slotFile(projectKey, breakpoint), slotFile(projectKey, target))
            delete meta.slots[breakpoint]
          }
          meta.slots[target] = { ...moving, breakpoint: target }
          dropNormalized(projectKey, breakpoint)
          dropNormalized(projectKey, target)
        }

        writeMeta(projectKey, meta)
        return { success: true, slots: meta.slots }
      } catch (error: any) {
        return { success: false, error: error?.message || 'The design could not be updated.' }
      }
    },

    remove(projectKey: string, breakpoint: Breakpoint): DesignSlots {
      if (!isBreakpoint(breakpoint)) return readMeta(projectKey).slots
      const meta = readMeta(projectKey)
      rmSync(slotFile(projectKey, breakpoint), { force: true })
      dropNormalized(projectKey, breakpoint)
      delete meta.slots[breakpoint]
      if (Object.keys(meta.slots).length) writeMeta(projectKey, meta)
      else rmSync(directory(projectKey), { recursive: true, force: true })
      return meta.slots
    },

    removeProject(projectKey: string): void {
      rmSync(directory(projectKey), { recursive: true, force: true })
    },

    /** Original export, used for evidence and for the QA agent. */
    readOriginal(projectKey: string, breakpoint: Breakpoint): Buffer | null {
      try {
        return readFileSync(slotFile(projectKey, breakpoint))
      } catch {
        return null
      }
    },

    /** Path of the image resized so that one image pixel is one CSS pixel. */
    async normalizedPath(projectKey: string, breakpoint: Breakpoint): Promise<string | null> {
      const slot = readMeta(projectKey).slots[breakpoint]
      if (!slot) return null
      if (slot.scale === 1) return slotFile(projectKey, breakpoint)
      const target = normalizedFile(projectKey, breakpoint)
      if (!existsSync(target)) {
        const resized = await sharp(slotFile(projectKey, breakpoint)).resize({ width: slot.frameWidth, kernel: 'lanczos3' }).png().toBuffer()
        writeAtomic(target, resized)
      }
      return target
    },
  }
}

export type DesignStore = ReturnType<typeof createDesignStore>
