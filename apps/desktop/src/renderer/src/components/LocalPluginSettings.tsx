import { PluginNumberField, LocalPluginSwitch, RefreshPluginContent } from './LocalPluginFields.js'
import { petProfile, type AmbientConfig } from '@codepulse/shared'
import { parseStocks, parseTools } from '../lib/yuanbaoRows.js'
import { isYuanbao } from '../lib/localPlugins.js'
import { YuanbaoSettings } from './YuanbaoSettings.js'
import { NumberRule } from './NumberRule.js'
import { PetThumb } from './PetThumb.js'
import { SAVE_DELAY_MS, type LocalPluginModel } from './useLocalPlugins.js'

export function LocalPluginSettings({ model }: { model: LocalPluginModel }): JSX.Element {
  const {
    hasSettings,
    settingsOpen,
    setSettingsOpen,
    snapshot,
    category,
    cardsFor,
    draft,
    edit,
    yb,
    setSnapshot,
    ybConfig,
    editYuanbao,
    stocksText,
    stocksError,
    setStocksText,
    setStocksError,
    toolsText,
    setToolsText,
    key,
    setKey,
    busy,
    action,
    messageScope,
    message,
  } = model
  return (
    <>
      {isYuanbao(category) && (
        <YuanbaoSettings
          status={yb}
          limit={ybConfig.dailyRequestLimit}
          onLimit={(value) => editYuanbao({ dailyRequestLimit: value })}
          onSnapshot={setSnapshot}
          disabled={!snapshot}
          limitField={(value, onCommit) => (
            <NumberRule label="每日请求上限" value={value} min={1} max={200} onCommit={onCommit} />
          )}
        />
      )}
      {hasSettings && (
        <details
          className="ambient-details ambient-settings"
          open={settingsOpen}
          onToggle={(e) => setSettingsOpen(e.currentTarget.open)}
        >
          <summary>设置</summary>
          <fieldset className="ambient-fieldset" disabled={!snapshot}>
            {category === 'pet' && (
              <div className="ambient-pet-picker" role="radiogroup" aria-label="宠物形象">
                {cardsFor('pet').map((c) => {
                  const chosen = c.pet?.id === draft.petId
                  return (
                    <button
                      type="button"
                      role="radio"
                      aria-checked={chosen}
                      key={c.id}
                      className="ambient-pet-option"
                      title={c.pet ? petProfile(c.pet.id).trait : undefined}
                      onClick={() => c.pet && edit('petId', c.pet.id)}
                    >
                      <PetThumb card={c} />
                      <strong>{c.pet ? petProfile(c.pet.id).name : c.source}</strong>
                      <span>{c.pet ? petProfile(c.pet.id).trait : ''}</span>
                      {chosen && <em>已选</em>}
                    </button>
                  )
                })}
              </div>
            )}
            {category === 'news' && (
              <div className="ambient-actions">
                <RefreshPluginContent model={model} />
              </div>
            )}
            {category === 'life' && (
              <>
                <section className="ambient-group" aria-label="天气">
                  <h3>天气</h3>
                  <LocalPluginSwitch model={model} flag="weatherEnabled" label="显示天气" />
                  <label className="page-field">
                    城市
                    <input
                      value={ybConfig.city}
                      maxLength={20}
                      onChange={(e) => editYuanbao({ city: e.target.value }, SAVE_DELAY_MS)}
                    />
                  </label>
                </section>
                <section className="ambient-group" aria-label="金价">
                  <h3>金价</h3>
                  <LocalPluginSwitch model={model} flag="goldEnabled" label="显示金价" />
                  <label className="page-switch">
                    <input
                      type="checkbox"
                      checked={ybConfig.goldBrand}
                      onChange={(e) => editYuanbao({ goldBrand: e.target.checked })}
                    />
                    附品牌金价
                  </label>
                </section>
                <section className="ambient-group" aria-label="股票">
                  <h3>股票</h3>
                  <LocalPluginSwitch model={model} flag="stocksEnabled" label="显示股价" />
                  <label className="page-field">
                    代码（最多 3 个，逗号分隔）
                    <input
                      value={stocksText}
                      aria-invalid={Boolean(stocksError)}
                      placeholder="00700.hk"
                      onChange={(e) => {
                        setStocksText(e.target.value)
                        const parsed = parseStocks(e.target.value)
                        setStocksError(parsed.ok ? '' : parsed.error)
                        if (parsed.ok) editYuanbao({ stocks: parsed.stocks }, SAVE_DELAY_MS)
                      }}
                    />
                    {stocksError && (
                      <span className="ambient-field-error" role="alert">
                        {stocksError}
                      </span>
                    )}
                  </label>
                </section>
                <div className="ambient-actions">
                  <RefreshPluginContent model={model} />
                </div>
              </>
            )}
            {category === 'tools' && (
              <>
                <label className="page-field">
                  工具名称（最多 4 个，逗号分隔）
                  <input
                    value={toolsText}
                    onChange={(e) => {
                      setToolsText(e.target.value)
                      editYuanbao({ tools: parseTools(e.target.value) }, SAVE_DELAY_MS)
                    }}
                  />
                </label>
                <div className="ambient-actions">
                  <RefreshPluginContent model={model} />
                </div>
              </>
            )}
            {category === 'headlines' && (
              <>
                <label className="page-field">
                  话题
                  <input
                    value={ybConfig.newsTopic}
                    maxLength={20}
                    onChange={(e) => editYuanbao({ newsTopic: e.target.value }, SAVE_DELAY_MS)}
                  />
                </label>
                <div className="ambient-actions">
                  <RefreshPluginContent model={model} />
                </div>
              </>
            )}
            {category === 'social' && (
              <>
                <section className="ambient-group" aria-label="X 贴文">
                  <h3>X 贴文</h3>
                  <LocalPluginSwitch model={model} flag="xEnabled" label="订阅 X 贴文" />
                  <div className={`ambient-subfields${draft.xEnabled ? '' : ' is-dim'}`}>
                    <div className="ambient-fields">
                      <label className="page-field">
                        接入方式
                        <select
                          value={draft.provider}
                          disabled={!draft.xEnabled}
                          onChange={(e) =>
                            edit('provider', e.target.value as AmbientConfig['provider'])
                          }
                        >
                          <option value="twitterapi">TwitterAPI.io · 第三方按量付费</option>
                          <option value="x">X 官方 API · 按量付费</option>
                        </select>
                      </label>
                      <div className="ambient-key-row">
                        <label className="page-field">
                          API 密钥
                          <input
                            type="password"
                            autoComplete="off"
                            value={key}
                            disabled={!draft.xEnabled}
                            placeholder={
                              snapshot?.hasKey && snapshot.config.provider === draft.provider
                                ? '已保存，留空保留'
                                : '填入对应来源的 API 密钥'
                            }
                            onChange={(e) => setKey(e.target.value)}
                          />
                        </label>
                        <button
                          type="button"
                          className="product-button"
                          disabled={busy || !key.trim() || !draft.xEnabled}
                          onClick={() =>
                            void action(
                              async () => {
                                const state = await window.codepulse.setAmbientKey(
                                  draft.provider,
                                  key,
                                )
                                setKey('')
                                return state
                              },
                              '密钥已加密保存在本机。',
                              'settings',
                            )
                          }
                        >
                          保存密钥
                        </button>
                        <button
                          type="button"
                          className="product-button"
                          disabled={busy || !snapshot?.hasKey || !draft.xEnabled}
                          onClick={() =>
                            void action(
                              () => window.codepulse.setAmbientKey(draft.provider, ''),
                              '已清除该来源密钥',
                              'settings',
                            )
                          }
                        >
                          清除密钥
                        </button>
                      </div>
                    </div>
                    <label className="page-field">
                      账号（逗号分隔）
                      <input
                        value={draft.accounts.join(', ')}
                        disabled={!draft.xEnabled}
                        onChange={(e) =>
                          edit('accounts', e.target.value.split(/[,，\s]+/), SAVE_DELAY_MS)
                        }
                      />
                    </label>
                    <div className="ambient-fields">
                      <label className="page-field">
                        必须包含任一关键词（可留空）
                        <input
                          value={draft.keywords.join(', ')}
                          disabled={!draft.xEnabled}
                          onChange={(e) =>
                            edit(
                              'keywords',
                              e.target.value.split(/[,，]/).map((s) => s.trimStart()),
                              SAVE_DELAY_MS,
                            )
                          }
                        />
                      </label>
                      <label className="page-field">
                        排除关键词
                        <input
                          value={draft.exclude.join(', ')}
                          disabled={!draft.xEnabled}
                          onChange={(e) =>
                            edit(
                              'exclude',
                              e.target.value.split(/[,，]/).map((s) => s.trimStart()),
                              SAVE_DELAY_MS,
                            )
                          }
                        />
                      </label>
                      <PluginNumberField
                        model={model}
                        field="minLikes"
                        label="最低点赞数"
                        min={0}
                        max={1000000}
                        disabled={!draft.xEnabled}
                      />
                      <PluginNumberField
                        model={model}
                        field="dailyRequestLimit"
                        label="每天最多检查 X"
                        min={1}
                        max={96}
                        disabled={!draft.xEnabled}
                        hint={`含手动检查；今日已检查 ${snapshot?.xRequestsToday ?? 0} 次`}
                      />
                    </div>
                    <details className="ambient-details">
                      <summary>按账号调整最低赞数</summary>
                      <div className="ambient-fields">
                        {[
                          ...new Set(
                            draft.accounts
                              .map((a) => a.replace(/^@/, '').trim())
                              .filter((a) => /^[A-Za-z0-9_]{1,15}$/.test(a)),
                          ),
                        ].map((account) => (
                          <NumberRule
                            key={account}
                            label={`@${account}`}
                            value={draft.accountMinLikes[account.toLowerCase()] ?? draft.minLikes}
                            min={0}
                            max={1000000}
                            disabled={!draft.xEnabled}
                            onCommit={(value) =>
                              edit('accountMinLikes', {
                                ...draft.accountMinLikes,
                                [account.toLowerCase()]: value,
                              })
                            }
                          />
                        ))}
                      </div>
                    </details>
                  </div>
                </section>
                <section className="ambient-group" aria-label="Meme">
                  <h3>Meme</h3>
                  <LocalPluginSwitch model={model} flag="memeEnabled" label="启用 meme" />
                  <div className={`ambient-subfields${draft.memeEnabled ? '' : ' is-dim'}`}>
                    <div className="ambient-fields">
                      <label className="page-field">
                        来源
                        <select
                          value={draft.memeCommunity}
                          disabled={!draft.memeEnabled}
                          onChange={(e) =>
                            edit('memeCommunity', e.target.value as AmbientConfig['memeCommunity'])
                          }
                        >
                          <option value="memes">r/memes</option>
                          <option value="dankmemes">r/dankmemes</option>
                          <option value="ProgrammerHumor">r/ProgrammerHumor</option>
                        </select>
                      </label>
                      <PluginNumberField
                        model={model}
                        field="memeMinUps"
                        label="最低赞数"
                        min={0}
                        max={1000000}
                        disabled={!draft.memeEnabled}
                      />
                    </div>
                  </div>
                </section>
                <div className="ambient-actions">
                  <RefreshPluginContent model={model} />
                </div>
              </>
            )}
            <p className="ambient-message" data-feedback="settings" role="status">
              {messageScope === 'settings' ? message : ''}
            </p>
          </fieldset>
        </details>
      )}
    </>
  )
}
