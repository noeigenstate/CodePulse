import type { CalendarNextHoliday } from '@codepulse/shared'
import { CATEGORIES, SAMPLES, isYuanbao, localPluginItemLabel } from '../lib/localPlugins.js'
import { PluginInkPreview } from './PluginInkPreview.js'
import { LocalPluginSettings } from './LocalPluginSettings.js'
import type { LocalPluginModel } from './useLocalPlugins.js'

/** Tail of the calendar info line: the break going on, or how far away the next one is. */
function nextHolidayText(next: CalendarNextHoliday | undefined): string {
  if (!next) return ' · 暂无下一个假日数据'
  return next.ongoing ? ` · ${next.name}假期中` : ` · 距 ${next.name} 还有 ${next.inDays} 天`
}

export function LocalPluginDetail({ model }: { model: LocalPluginModel }): JSX.Element {
  const {
    category,
    dragging,
    setDragging,
    importFiles,
    fileInput,
    busy,
    savedFlash,
    refreshNote,
    saveFailed,
    items,
    sampleTopic,
    previewSample,
    selectedCard,
    showPreview,
    snapshot,
    holidayStatus,
    selectedCanOpen,
    selectedRemovable,
    action,
    removeSelected,
    note,
    setNote,
    addNote,
    preview,
    target,
    previewStatus,
    onScreen,
    targetError,
    retryTarget,
    online,
    tempReason,
    messageScope,
    message,
    setMessage,
  } = model
  return (
    <section
      className={'ambient-panel plugin-local-detail' + (dragging ? ' is-dragging' : '')}
      onDragOver={(e) => {
        if (category !== 'local' || !e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false)
      }}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        if (category === 'local') void importFiles(Array.from(e.dataTransfer.files))
      }}
    >
      <section
        className="plugin-details-section"
        aria-label={CATEGORIES.find((c) => c.id === category)!.label}
      >
        <input
          ref={fileInput}
          type="file"
          accept="image/png,image/jpeg"
          multiple
          hidden
          onChange={(e) => void importFiles(Array.from(e.target.files ?? []))}
        />
        {category === 'local' && (
          <button
            type="button"
            className="product-button"
            disabled={busy}
            onClick={() => fileInput.current?.click()}
          >
            选择图片
          </button>
        )}
        <div className="page-card-head">
          <div className="ambient-detail-title">
            <h3>设置</h3>
          </div>
          <span
            className={`page-saved ${savedFlash || refreshNote ? 'is-shown' : ''}`}
            role="status"
          >
            {refreshNote || (savedFlash ? '已保存' : '')}
          </span>
        </div>
        {saveFailed && (
          <p className="ambient-message" role="alert">
            保存未完成，请检查输入后重试。
          </p>
        )}
        <div className="ambient-items-col">
          <ul className="ambient-items" aria-label="条目">
            {items.length === 0 && !isYuanbao(category) && (
              <li className="ambient-empty">暂无内容</li>
            )}
            {items.length === 0 &&
              isYuanbao(category) &&
              SAMPLES[category].map(({ topic, label }) => (
                <li key={topic}>
                  <button
                    type="button"
                    className="ambient-item"
                    data-sample={topic}
                    aria-pressed={sampleTopic === topic}
                    onClick={() => void previewSample(topic)}
                  >
                    <span className="ambient-item-label">示例 · {label}</span>
                  </button>
                </li>
              ))}
            {items.map((card) => (
              <li key={card.id}>
                <button
                  type="button"
                  className="ambient-item"
                  aria-pressed={card.id === selectedCard?.id}
                  title={`${card.text}${['x', 'meme', 'news'].includes(card.kind) ? ` · ${card.score.toLocaleString()} 赞` : ''}`}
                  onClick={() => void showPreview(card)}
                >
                  <span className="ambient-item-label">{localPluginItemLabel(card)}</span>
                </button>
              </li>
            ))}
          </ul>
          {category === 'calendar' && selectedCard?.calendar && (
            <p
              className="ambient-calendar-info"
              role="status"
              title="月历需要固件 0.0.29 以上，旧固件只显示一行文字"
            >
              {selectedCard.text}
              {nextHolidayText(snapshot?.calendarNext)}
            </p>
          )}
          {(category === 'calendar' || category === 'holiday') && holidayStatus && (
            <p className="ambient-calendar-info" data-holiday-status role="status">
              {holidayStatus}
            </p>
          )}
          {(selectedCanOpen || selectedRemovable) && (
            <div className="ambient-actions">
              {selectedCanOpen && selectedCard && (
                <button
                  type="button"
                  className="product-button is-compact"
                  onClick={() =>
                    void window.codepulse
                      .openAmbient(selectedCard.id)
                      .catch(() => setMessage('原帖暂时无法打开'))
                  }
                >
                  {selectedCard.kind === 'concept' ? '延伸阅读 ↗' : '查看来源 ↗'}
                </button>
              )}
              {selectedRemovable && selectedCard && (
                <button
                  type="button"
                  className="product-button is-compact"
                  disabled={busy}
                  onClick={() => void removeSelected()}
                >
                  移除
                </button>
              )}
            </div>
          )}
          {category === 'local' && (
            <div className="ambient-note-editor">
              <label htmlFor="ambient-note">写一张便签</label>
              <textarea
                id="ambient-note"
                maxLength={120}
                rows={3}
                placeholder="今天只做一件最重要的事……"
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
              <button
                type="button"
                className="product-button"
                disabled={busy || !note.trim()}
                onClick={() => void addNote()}
              >
                保存并预览
              </button>
              <small>{note.length} / 120</small>
            </div>
          )}
          <LocalPluginSettings model={model} />
        </div>
      </section>
      <PluginInkPreview
        status={previewStatus ?? target?.status}
        loading={!preview && !target && !targetError}
        error={targetError}
        onRetry={retryTarget}
        disabled={busy || !selectedCard || !online}
        reason={tempReason}
        sample={Boolean(preview)}
        live={!preview}
        cornerTag={sampleTopic ? '示例' : onScreen ? '当前画面' : '预览'}
        message={messageScope === 'content' ? message : ''}
        onShow={() => {
          if (busy || !selectedCard || !online) return
          void action(
            () => window.codepulse.showAmbient(selectedCard.id),
            '已临时展示，10 分钟后自动回到节目单。',
          )
        }}
      />
    </section>
  )
}
