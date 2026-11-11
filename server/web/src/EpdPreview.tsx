import type { PluginCard } from '@codepulse/shared'

/** An HTML illustration of the card layout; the real pixels come from the device renderer. */
function CardBody({ card }: { card: PluginCard }) {
  if (card.imageHex) return <p className="epd-note">位图卡片，预览需要设备渲染</p>
  if (card.life?.kind === 'hn') {
    return (
      <>
        <div className="hd">
          <span>Hacker News</span>
          <span>{card.life.updated}</span>
        </div>
        <ol>
          {card.life.stories.map((s, i) => (
            <li key={i}>
              {s.title}
              <small>{`${s.points} 分 · ${s.comments} 评论 · ${s.site}`}</small>
            </li>
          ))}
        </ol>
      </>
    )
  }
  return (
    <>
      <div className="hd">
        <span>{card.source}</span>
      </div>
      {card.items ? (
        <ol>
          {card.items.map((item, i) => (
            <li key={i} className={item.overdue ? 'late' : undefined}>
              {item.title}
              {item.meta && <small>{item.meta}</small>}
            </li>
          ))}
        </ol>
      ) : (
        <p>{card.text}</p>
      )}
    </>
  )
}

export function EpdPreview({
  cards,
  error,
  label,
}: {
  cards?: PluginCard[]
  error: string
  label: string
}) {
  const card = cards?.[0]
  return (
    <>
      <div className="epd-wrap">
        {card ? (
          <div className="epd" role="img" aria-label={`墨水屏示意：${label}`}>
            <CardBody card={card} />
          </div>
        ) : (
          <p className="meta">{error || (cards ? '这个插件暂时没有示例卡片' : '正在生成…')}</p>
        )}
      </div>
      <p className="meta caption">示意图，实际以设备渲染为准。</p>
    </>
  )
}
