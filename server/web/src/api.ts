import type {
  PluginCard,
  PluginInstall,
  PluginKind,
  PluginListing,
  PluginLogoType,
  PluginManifest,
  PluginReviewState,
} from '@codepulse/shared'
import { devSession, storeSession, type TokenSlot } from './session'

export type InstallRow = PluginInstall & {
  status: { generatedAt: number | null; error: string }
}
export interface Developer {
  email: string
  name: string
  admin: boolean
}
export interface DevVersion {
  id: string
  version: string
  kind: PluginKind
  state: PluginReviewState
  note: string
  submittedAt: number
}
export interface DevPlugin {
  id: string
  name: string
  summary: string
  liveVersion: string | null
  logoUrl: string | null
  versions: DevVersion[]
}
export interface Review {
  versionId: string
  pluginId: string
  pluginName: string
  logoUrl: string | null
  version: string
  kind: PluginKind
  developer: string
  submittedAt: number
  cardCount: number | null
  endpoint: string | null
}
export interface VersionDraft {
  manifest: PluginManifest
  cards?: unknown[]
  endpoint?: string
}
export interface Generated {
  cards: PluginCard[]
  error: string
}

async function request<T>(
  method: string,
  path: string,
  auth?: TokenSlot,
  body?: unknown,
): Promise<T> {
  const token = auth?.get()
  const res = await fetch(`/api/v1${path}`, {
    method,
    headers: {
      ...(token && { Authorization: `Bearer ${token}` }),
      ...(body !== undefined && { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).catch(() => {
    throw new Error('无法连接插件平台')
  })
  const data = await res.json().catch(() => ({}))
  if (res.ok) return data
  if (res.status === 401) auth?.clear()
  throw new Error(data.error || '请求失败')
}

const get = <T>(path: string, auth?: TokenSlot) => request<T>('GET', path, auth)
// Fastify rejects a JSON content-type without a body, so writes always carry one.
const send = <T>(method: string, path: string, auth: TokenSlot | undefined, body?: unknown) =>
  request<T>(method, path, auth, body ?? {})
const enc = encodeURIComponent

const realApi = {
  storeSession: (code: string) =>
    send<{ token: string }>('POST', '/store/session', undefined, { code }),
  plugins: () => get<{ plugins: PluginListing[] }>('/plugins').then((r) => r.plugins),
  preview: (id: string) => get<Generated>(`/plugins/${enc(id)}/preview`),
  installs: () =>
    get<{ installs: InstallRow[] }>('/installs', storeSession).then((r) => r.installs),
  putInstall: (id: string, change: { enabled?: boolean; settings?: object }) =>
    send<{ install: PluginInstall }>('PUT', `/installs/${enc(id)}`, storeSession, change),
  deleteInstall: (id: string) => send<{ ok: true }>('DELETE', `/installs/${enc(id)}`, storeSession),

  devRegister: (body: { email: string; name: string; password: string }) =>
    send<{ token: string; developer: Developer }>('POST', '/dev/register', undefined, body),
  devLogin: (body: { email: string; password: string }) =>
    send<{ token: string; developer: Developer }>('POST', '/dev/login', undefined, body),
  devLogout: () => send<{ ok: true }>('POST', '/dev/logout', devSession),
  devMe: () => get<{ developer: Developer }>('/dev/me', devSession).then((r) => r.developer),
  devPlugins: () =>
    get<{ plugins: DevPlugin[] }>('/dev/plugins', devSession).then((r) => r.plugins),
  createPlugin: (body: { id: string; name: string; summary: string }) =>
    send<{ plugin: { id: string; name: string; summary: string }; webhookSecret: string }>(
      'POST',
      '/dev/plugins',
      devSession,
      body,
    ),
  uploadLogo: (id: string, body: { type: PluginLogoType; data: string }) =>
    send<{ logoUrl: string }>('PUT', `/dev/plugins/${enc(id)}/logo`, devSession, body),
  deleteLogo: (id: string) => send<unknown>('DELETE', `/dev/plugins/${enc(id)}/logo`, devSession),
  submitVersion: (id: string, draft: VersionDraft) =>
    send<{ version: { id: string; version: string; state: 'pending' } }>(
      'POST',
      `/dev/plugins/${enc(id)}/versions`,
      devSession,
      draft,
    ),
  testPlugin: (id: string, draft: VersionDraft) =>
    send<Generated>('POST', `/dev/plugins/${enc(id)}/test`, devSession, draft),

  reviews: () => get<{ reviews: Review[] }>('/admin/reviews', devSession).then((r) => r.reviews),
  decide: (versionId: string, body: { decision: 'approved' | 'rejected'; note?: string }) =>
    send<{ ok: true }>('POST', `/admin/reviews/${enc(versionId)}`, devSession, body),
}

export type Api = typeof realApi
/** Swapped for the in-memory fake in `?mock=1` dev sessions (see main.tsx). */
export let api: Api = realApi
export const useMockApi = (mock: Api) => {
  api = mock
}
