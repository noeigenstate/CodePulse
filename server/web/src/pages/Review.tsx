import { useState, type FormEvent } from 'react'
import { api, type Invite, type Review } from '../api'
import { dateTime, kindName } from '../format'
import { useAction, useAsync } from '../hooks'
import { Button, ErrorLine, Icon, State, type StateTone } from '../ui'

const inviteState: Record<Invite['state'], [string, StateTone]> = {
  unused: ['未使用', 'wait'],
  used: ['已使用', 'ok'],
  expired: ['已过期', ''],
  revoked: ['已撤销', ''],
}

/** The code exists in plain text only in this response; the platform keeps its hash. */
function NewCode({ code, onDone }: { code: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false)
  const copy = () =>
    navigator.clipboard.writeText(code).then(
      () => setCopied(true),
      () => setCopied(false),
    )
  return (
    <div className="notice secret" role="status">
      <State tone="wait">只显示这一次</State>
      <div className="meta">把邀请码发给开发者；关闭后无法再查看，只能重新生成。</div>
      <code>{code}</code>
      <div className="actions">
        <Button compact onClick={copy}>
          {copied ? '已复制' : '复制'}
        </Button>
        <Button compact onClick={onDone}>
          完成
        </Button>
      </div>
    </div>
  )
}

function InviteRow({ invite, reload }: { invite: Invite; reload: () => void }) {
  const { busy, error, run } = useAction()
  const [label, tone] = inviteState[invite.state]
  return (
    <div className="list-row" role="row">
      <div className="c-who">
        <div>{invite.note || '（无备注）'}</div>
        <div className="meta">{`${invite.createdBy ?? '服务器命令'} · ${dateTime(invite.createdAt)}`}</div>
      </div>
      <div className="c-state">
        <State tone={tone}>{label}</State>
        {invite.usedBy && (
          <span className="meta">{`${invite.usedBy.name} · ${invite.usedBy.email}`}</span>
        )}
      </div>
      <span className="meta c-time">{dateTime(invite.expiresAt)}</span>
      <div className="actions c-act">
        {invite.state === 'unused' && (
          <Button
            compact
            busy={busy}
            onClick={() =>
              run(async () => {
                await api.revokeInvite(invite.id)
                reload()
              })
            }
          >
            撤销
          </Button>
        )}
      </div>
      {error && (
        <div className="c-note">
          <ErrorLine reason={error} />
        </div>
      )}
    </div>
  )
}

function Invites() {
  const invites = useAsync(api.invites, [])
  const [code, setCode] = useState('')
  const { busy, error, run } = useAction()
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const form = e.currentTarget
    const data = new FormData(form)
    run(async () => {
      const created = await api.createInvite({
        note: String(data.get('note') ?? '').trim() || undefined,
        days: Number(data.get('days')),
      })
      form.reset()
      setCode(created.code)
      invites.reload()
    })
  }
  return (
    <section className="panel invites">
      <div className="panel-head">
        <h2>开发者邀请码</h2>
      </div>
      <p className="hint">开发者账号采用邀请制。一个邀请码只能注册一个账号，到期或撤销后失效。</p>
      {code ? (
        <NewCode code={code} onDone={() => setCode('')} />
      ) : (
        <form className="invite-form" onSubmit={submit}>
          <input
            className="control"
            name="note"
            aria-label="备注"
            placeholder="备注，例如发给谁"
            maxLength={40}
          />
          <select className="control" name="days" aria-label="有效期" defaultValue="14">
            {[1, 7, 14, 30, 90].map((days) => (
              <option key={days} value={days}>{`${days} 天有效`}</option>
            ))}
          </select>
          <Button primary busy={busy} type="submit">
            生成邀请码
          </Button>
        </form>
      )}
      <ErrorLine reason={error || invites.error} />
      <div className="list review" role="table" aria-label="邀请码">
        <div className="list-head meta" role="row">
          <span className="c-who">备注</span>
          <span className="c-state">状态</span>
          <span className="c-time">有效期至</span>
          <span className="c-act" />
        </div>
        {invites.data?.length === 0 && (
          <div className="list-row">
            <span className="meta">还没有邀请码。</span>
          </div>
        )}
        {invites.data?.map((invite) => (
          <InviteRow key={invite.id} invite={invite} reload={invites.reload} />
        ))}
      </div>
    </section>
  )
}

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
      <Invites />
    </section>
  )
}
