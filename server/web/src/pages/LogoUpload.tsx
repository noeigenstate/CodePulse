import {
  PLUGIN_LOGO_MAX_BYTES,
  PLUGIN_LOGO_MAX_PX,
  PLUGIN_LOGO_MIN_PX,
  PLUGIN_LOGO_TYPES,
  type PluginLogoType,
} from '@codepulse/shared'
import { useRef, useState } from 'react'
import { api, type DevPlugin } from '../api'
import { useAction } from '../hooks'
import { Button, ErrorLine, Icon } from '../ui'

interface Picked {
  type: PluginLogoType
  dataUrl: string
}

const readDataUrl = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('读取图片失败'))
    reader.readAsDataURL(file)
  })

const loadImage = (src: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('图片无法解码，请换一张'))
    image.src = src
  })

/** Mirrors the server's rules so mistakes show before uploading; the server stays the authority. */
async function checkLogo(file: File): Promise<Picked> {
  const type = PLUGIN_LOGO_TYPES.find((t) => t === file.type)
  if (!type) throw new Error('只支持 PNG、JPEG 和 WebP 图片')
  if (file.size > PLUGIN_LOGO_MAX_BYTES)
    throw new Error(`图片不能超过 ${PLUGIN_LOGO_MAX_BYTES / 1024} KB`)
  const dataUrl = await readDataUrl(file)
  const { naturalWidth: w, naturalHeight: h } = await loadImage(dataUrl)
  if (w !== h) throw new Error(`图标必须是正方形，当前是 ${w} × ${h}`)
  if (w < PLUGIN_LOGO_MIN_PX || w > PLUGIN_LOGO_MAX_PX)
    throw new Error(`边长要在 ${PLUGIN_LOGO_MIN_PX} 到 ${PLUGIN_LOGO_MAX_PX} 像素之间，当前是 ${w}`)
  return { type, dataUrl }
}

/** One plugin's logo: choose a file, preview it, then upload; or remove the current one. */
export function LogoRow({ plugin, onChanged }: { plugin: DevPlugin; onChanged: () => void }) {
  const [picked, setPicked] = useState<Picked | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const { busy, error, run } = useAction()

  const upload = ({ type, dataUrl }: Picked) =>
    run(async () => {
      await api.uploadLogo(plugin.id, { type, data: dataUrl.slice(dataUrl.indexOf(',') + 1) })
      setPicked(null)
      onChanged()
    })
  const remove = () =>
    run(async () => {
      await api.deleteLogo(plugin.id)
      onChanged()
    })

  return (
    <div className="logo-row">
      <Icon name={plugin.name} logoUrl={picked?.dataUrl ?? plugin.logoUrl} />
      <div className="logo-meta">
        <div>{plugin.name}</div>
        {picked && <div className="meta">预览，确认后上传</div>}
      </div>
      <div className="actions">
        <input
          ref={input}
          type="file"
          hidden
          accept={PLUGIN_LOGO_TYPES.join(',')}
          aria-label={`选择 ${plugin.name} 的图标文件`}
          onChange={(e) => {
            const file = e.target.files?.[0]
            e.target.value = '' // so choosing the same file again still fires
            if (file) run(async () => setPicked(await checkLogo(file)))
          }}
        />
        {picked ? (
          <>
            <Button compact busy={busy} onClick={() => upload(picked)}>
              上传
            </Button>
            <Button compact disabled={busy} onClick={() => setPicked(null)}>
              取消
            </Button>
          </>
        ) : (
          <>
            <Button compact disabled={busy} onClick={() => input.current?.click()}>
              上传图标
            </Button>
            {plugin.logoUrl && (
              <Button compact busy={busy} onClick={remove}>
                移除图标
              </Button>
            )}
          </>
        )}
      </div>
      <ErrorLine reason={error} />
    </div>
  )
}
