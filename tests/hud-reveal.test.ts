import assert from 'node:assert/strict'
import test from 'node:test'
import { hudWindowBoundsForReveal, type HudDisplay } from '../apps/desktop/src/main/hud-window.js'

const primary: HudDisplay = { id: 1, bounds: {x:0,y:0,width:1920,height:1080}, workArea: {x:0,y:0,width:1920,height:1040} }
const left: HudDisplay = { id: 2, bounds: {x:-1280,y:100,width:1280,height:1024}, workArea: {x:-1280,y:100,width:1280,height:984} }
const inside = (r: ReturnType<typeof hudWindowBoundsForReveal>, d: HudDisplay) => {
  assert.ok(r.x >= d.workArea.x && r.y >= d.workArea.y)
  assert.ok(r.x+r.width <= d.workArea.x+d.workArea.width)
  assert.ok(r.y+r.height <= d.workArea.y+d.workArea.height)
}
test('explicit reveal uses the supplied client display, including negative coordinates', () => {
  inside(hudWindowBoundsForReveal(primary), primary)
  const r = hudWindowBoundsForReveal(left)
  inside(r,left)
  assert.ok(r.x < 0)
})
test('reveal recovers stale coordinates from another/disconnected display', () => {
  for (const current of [{x:50000,y:50000,width:470,height:500},{x:-1200,y:200,width:470,height:500}]) {
    const r = hudWindowBoundsForReveal(primary,current)
    inside(r,primary)
    assert.equal(r.height,500)
  }
})
test('reveal preserves a manually positioned HUD that still fits', () => {
  const current={x:550,y:180,width:470,height:500}
  assert.deepEqual(hudWindowBoundsForReveal(primary,current),current)
})
test('partly off-screen and oversized HUDs remain within the work area', () => {
  inside(hudWindowBoundsForReveal(primary,{x:1800,y:950,width:470,height:500}),primary)
  inside(hudWindowBoundsForReveal(left,{x:-1000,y:150,width:3000,height:3000}),left)
})
