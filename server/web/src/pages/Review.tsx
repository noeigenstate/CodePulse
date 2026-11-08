import { useState } from 'react'
import { api, type Review } from '../api'
import { dateTime, kindName } from '../format'
import { useAction } from '../hooks'
import { Button, ErrorLine, Icon } from '../ui'

function Row({ review, done }: { review: Review; done: (message: string) => void }) {
  const [rejecting, setRejecting] = useState(false)
  const [note, setNote] = useState('')
  const { busy, error, run } = useAction()
  const decide = (decision: 'approved' | 'rejected') =>
    run(async () => {
      await api.decide(review.versionId, { decision, note: note.trim() || undefined })
      done(decision === 'approved' ? '已通过' : '已退回')
    })
  const detail = review.endpoint ?? `${review.cardCount ?? 0} 张卡片`

  return (
    <div className="list-row" role="row">
      <div className="who c-who">
        <Icon name={review.pluginName} logoUrl={review.logoUrl} />
        <div>
          <div>{`${review.pluginName} ${review.version}`}</div>
          <div className="meta">{`${kindName[review.kind]} · ${detail}`}</div>
        </div>
      </div>
      <span className="meta c-state">{review.developer}</span>
      <span className="meta c-time">{dateTime(review.submittedAt)}</span>
      <div className="actions c-act">
        <Button compact disabled={busy} onClick={() => setRejecting(!rejecting)}>
          退回
        </Button>
        <Button compact busy={busy && !rejecting} onClick={() => decide('approved')}>
          通过
        </Button>
      </div>
      {rejecting && (
        <div className="c-note">
          <input
            className="control"
            aria-label="退回原因"
            placeholder="退回原因，开发者会看到"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <Button compact busy={busy} onClick={() => decide('rejected')}>
            确认退回
          </Button>
        </div>
      )}
      {error && (
        <div className="c-note">
          <ErrorLine reason={error} />
        </div>
      )}
    </div>
  )
}

export function ReviewPage({
  reviews,
  reload,
  notify,
}: {
  reviews: Review[]
  reload: () => void
  notify: (message: string) => void
}) {
  return (
    <section>
      <p className="hint">
        只有管理员能看到这里。通过后新版本对所有用户可见，已安装的用户自动更新。
      </p>
      <div className="list review" role="table" aria-label="待审核版本">
        <div className="list-head meta" role="row">
          <span className="c-who">插件</span>
          <span className="c-state">开发者</span>
          <span className="c-time">提交时间</span>
          <span className="c-act" />
        </div>
        {reviews.length === 0 && (
          <div className="list-row">
            <span className="meta">没有待审核的版本。</span>
          </div>
        )}
        {reviews.map((r) => (
          <Row
            key={r.versionId}
            review={r}
            done={(message) => {
              notify(message)
              reload()
            }}
          />
        ))}
      </div>
    </section>
  )
}
