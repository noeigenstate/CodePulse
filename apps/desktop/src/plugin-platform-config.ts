import { isIPv4 } from 'node:net'

export function pluginPlatformUrl(value = 'http://127.0.0.1:18080'): string {
  const url = new URL(value)
  const [first, second] = url.hostname.split('.').map(Number)
  // Self-hosted LAN platforms may lack TLS; their client token stays on the private network.
  const privateIpv4 =
    isIPv4(url.hostname) &&
    (first === 10 ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168))
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    (url.protocol === 'http:' &&
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
      !privateIpv4)
  )
    throw Error('插件平台地址无效')
  return url.origin
}
