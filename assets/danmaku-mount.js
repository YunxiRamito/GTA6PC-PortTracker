(() => {
  'use strict';

  const t = (key, fallback, params) => window.SiteI18n?.t(key, fallback, params) ??
    (params ? fallback.replace(/\{(\w+)\}/g, (token, name) => params[name] ?? token) : fallback);
  // Catalog strings are plain text, including when used as attributes.
  const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const html = (...args) => t(...args).replace(/[&<>"']/g, character => entities[character]);

  const mount = document.querySelector('[data-danmaku-mount]');
  // The page owns the dock position; the widget has exactly one instance.
  if (!mount || document.getElementById('danmakuWidget')) return;

  const template = document.createElement('template');
  template.innerHTML = `
  <section class="danmaku-widget" id="danmakuWidget" aria-label="${html('widgets.danmaku.label', '弹幕')}">
    <label class="danmaku-display-button" id="danmakuDisplayButton" inert><input class="sr-only" id="danmakuDisplay" type="checkbox" role="switch" aria-label="${html('widgets.danmaku.display', '显示弹幕')}" checked /><span class="danmaku-display-on" aria-hidden="true">${html('widgets.danmaku.displayOn', '开')}</span><span class="danmaku-display-off" aria-hidden="true">${html('widgets.danmaku.displayOff', '关')}</span></label>
    <button class="danmaku-toggle" id="danmakuToggle" type="button" aria-expanded="false" aria-controls="danmakuComposer" aria-label="${html('widgets.danmaku.composerOpen', '打开弹幕输入栏')}">
      <span id="danmakuToggleText">${html('widgets.danmaku.chat', '弹')}</span>
    </button>
    <button class="danmaku-history-toggle" id="danmakuHistoryToggle" type="button" aria-label="${html('widgets.danmaku.history', '历史弹幕')}" aria-expanded="false" aria-controls="danmakuHistory" title="${html('widgets.danmaku.historyToggle', '展开或收起历史弹幕')}" inert>
      <svg class="ui-icon" aria-hidden="true" focusable="false"><use href="/assets/ui/fluent.svg#chevron-down" /></svg>
    </button>
    <div class="danmaku-composer" id="danmakuComposer" hidden inert data-lenis-prevent>
      <form class="danmaku-form" id="danmakuForm" aria-label="${html('widgets.danmaku.sendForm', '发送弹幕')}" novalidate>
        <label class="sr-only" for="danmakuInput">${html('widgets.danmaku.inputLabel', '输入弹幕内容，最多 60 个字')}</label>
        <div class="danmaku-input-shell">
          <input id="danmakuInput" name="text" type="text" autocomplete="off" enterkeyhint="send" placeholder="${html('widgets.danmaku.placeholder', '说点什么…')}" aria-describedby="danmakuHint danmakuCount" required />
          <a class="danmaku-input-login" id="danmakuInputLogin" target="_blank" rel="noopener noreferrer" hidden>${html('widgets.danmaku.loginUnlimited', '登录后无发言限制')}</a>
          <span class="danmaku-input-login-fallback" id="danmakuInputLoginFallback" hidden>${html('widgets.danmaku.loginUnlimited', '登录后无发言限制')}</span>
          <span class="danmaku-input-admin" id="danmakuInputAdmin" role="img" aria-label="${html('widgets.danmaku.admin', '管理员')}" hidden>${html('widgets.danmaku.adminShort', '管')}</span>
        </div>
        <button class="danmaku-send" id="danmakuSend" type="submit">
          <svg class="ui-icon" aria-hidden="true" focusable="false"><use href="/assets/ui/fluent.svg#checkmark" /></svg>
          <span class="danmaku-send-label sr-only" id="danmakuSendLabel">${html('widgets.danmaku.send', '发送')}</span>
        </button>
        <span class="sr-only" id="danmakuCount">0 / 60</span>
        <p class="sr-only" id="danmakuHint">${html('widgets.danmaku.enterToSend', '按 Enter 发送')}</p>
      </form>
      <p class="danmaku-status" id="danmakuStatus" role="status" aria-live="polite"></p>
    </div>
    <section class="danmaku-options" id="danmakuOptions" aria-labelledby="danmakuOptionsTitle" data-open="false" hidden inert data-lenis-prevent>
      <header class="danmaku-options-head">
        <h2 id="danmakuOptionsTitle">${html('widgets.danmaku.settings', '弹幕设置')}</h2>
        <div class="danmaku-options-actions">
          <a class="danmaku-account-link" id="danmakuAccountLink" target="_blank" rel="noopener noreferrer" hidden>${html('widgets.danmaku.signIn', '登录')}</a>
          <button class="danmaku-close danmaku-options-close" id="danmakuOptionsClose" type="button" aria-label="${html('widgets.danmaku.settingsClose', '关闭弹幕设置')}"><svg class="ui-icon" aria-hidden="true" focusable="false"><use href="/assets/ui/fluent.svg#dismiss" /></svg></button>
        </div>
      </header>
      <div class="danmaku-preferences">
        <span class="danmaku-feed-state" id="danmakuFeedState">${html('widgets.danmaku.connecting', '正在连接…')}</span>
      </div>
      <form class="danmaku-appearance" id="danmakuAppearance" aria-label="${html('widgets.danmaku.settings', '弹幕设置')}" novalidate>
        <div class="danmaku-appearance-field" id="danmakuGuestNickname">
          <div class="danmaku-appearance-label-row">
            <label for="danmakuNickname">${html('widgets.danmaku.nickname', '昵称')} <span class="danmaku-appearance-optional">${html('widgets.danmaku.optional', '可选')}</span></label>
            <output id="danmakuNicknameCount" for="danmakuNickname" aria-live="polite" aria-atomic="true">0 / 12</output>
          </div>
          <input id="danmakuNickname" name="nickname" type="text" autocomplete="nickname" placeholder="${html('widgets.danmaku.guestPlaceholder', '留空显示为游客')}" aria-describedby="danmakuNicknameHint danmakuNicknameCount" />
          <p class="danmaku-appearance-hint" id="danmakuNicknameHint">${html('widgets.danmaku.nicknameLength', '最多 6 个汉字或 12 个英文字母。')}</p>
        </div>
        <p class="danmaku-account-summary" id="danmakuAccountSummary" hidden>${html('widgets.danmaku.postingAs', '发言昵称')} <strong id="danmakuAccountNickname"></strong></p>
        <fieldset class="danmaku-color-field" id="danmakuMemberColors" hidden>
          <legend>${html('widgets.danmaku.color', '弹幕颜色')}</legend>
          <div class="danmaku-color-options">
            <label class="danmaku-color-option">
              <input type="radio" name="color" value="default" checked />
              <span class="danmaku-color-swatch danmaku-color-swatch-default" aria-hidden="true"></span>
              <span>${html('widgets.danmaku.colorDefault', '默认')}</span>
            </label>
            <label class="danmaku-color-option">
              <input type="radio" name="color" value="mint" />
              <span class="danmaku-color-swatch danmaku-color-swatch-mint" aria-hidden="true"></span>
              <span>${html('widgets.danmaku.colorMint', '薄荷')}</span>
            </label>
            <label class="danmaku-color-option">
              <input type="radio" name="color" value="sky" />
              <span class="danmaku-color-swatch danmaku-color-swatch-sky" aria-hidden="true"></span>
              <span>${html('widgets.danmaku.colorSky', '天空')}</span>
            </label>
            <label class="danmaku-color-option">
              <input type="radio" name="color" value="rose" />
              <span class="danmaku-color-swatch danmaku-color-swatch-rose" aria-hidden="true"></span>
              <span>${html('widgets.danmaku.colorRose', '玫瑰')}</span>
            </label>
            <label class="danmaku-color-option">
              <input type="radio" name="color" value="lemon" />
              <span class="danmaku-color-swatch danmaku-color-swatch-lemon" aria-hidden="true"></span>
              <span>${html('widgets.danmaku.colorLemon', '柠檬')}</span>
            </label>
            <label class="danmaku-color-option" data-staff-color hidden>
              <input type="radio" name="color" value="owner-red" disabled />
              <span class="danmaku-color-swatch danmaku-color-swatch-owner-red" aria-hidden="true"></span>
              <span>${html('widgets.danmaku.colorOwnerRed', '站长红')}</span>
            </label>
            <label class="danmaku-color-option" data-staff-color hidden>
              <input type="radio" name="color" value="admin-teal" disabled />
              <span class="danmaku-color-swatch danmaku-color-swatch-admin-teal" aria-hidden="true"></span>
              <span>${html('widgets.danmaku.colorAdminTeal', '管理青')}</span>
            </label>
            <label class="danmaku-color-option" data-staff-color hidden>
              <input type="radio" name="color" value="moderator-teal" disabled />
              <span class="danmaku-color-swatch danmaku-color-swatch-moderator-teal" aria-hidden="true"></span>
              <span>${html('widgets.danmaku.colorModeratorTeal', '纪委青')}</span>
            </label>
            <label class="danmaku-color-option" data-sponsor-color hidden>
              <input type="radio" name="color" value="gold" disabled />
              <span class="danmaku-color-swatch danmaku-color-swatch-gold" aria-hidden="true"></span>
              <span>${html('widgets.danmaku.colorSponsorGold', '赞助金')}</span>
            </label>
            <label class="danmaku-color-option" data-sponsor-color hidden>
              <input type="radio" name="color" value="hatsune-green" disabled />
              <span class="danmaku-color-swatch danmaku-color-swatch-hatsune-green" aria-hidden="true"></span>
              <span>${html('widgets.danmaku.colorHatsuneGreen', '初音绿')}</span>
            </label>
            <label class="danmaku-color-option" data-staff-color hidden>
              <input type="radio" name="color" value="orange" disabled />
              <span class="danmaku-color-swatch danmaku-color-swatch-orange" aria-hidden="true"></span>
              <span>${html('widgets.danmaku.colorOrange', '暖橙')}</span>
            </label>
          </div>
        </fieldset>
        <div class="danmaku-appearance-field" id="danmakuRankTagField" hidden>
          <div class="danmaku-appearance-label-row">
            <label for="danmakuRankTag">${html('widgets.danmaku.rankTag', '身份标签')}</label>
            <span class="danmaku-rank-preview" id="danmakuRankPreview" aria-hidden="true"></span>
          </div>
          <select id="danmakuRankTag" name="rankTag" aria-describedby="danmakuRankTagHint" disabled>
            <option value="">${html('widgets.danmaku.rankAuto', '自动')}</option>
            <option value="owner" hidden disabled>${html('widgets.danmaku.roleOwner', '站长')}</option>
            <option value="admin" hidden disabled>${html('widgets.danmaku.roleAdmin', '管理')}</option>
            <option value="moderator" hidden disabled>${html('widgets.danmaku.roleModerator', '纪委')}</option>
            <option value="sponsor" hidden disabled>${html('widgets.danmaku.roleContributor', '共创')}</option>
            <option value="none">${html('widgets.danmaku.rankNone', '不显示')}</option>
          </select>
          <p class="danmaku-appearance-hint" id="danmakuRankTagHint">${html('widgets.danmaku.rankHint', '只影响标签显示，不改变账号权限。')}</p>
        </div>
        <div class="danmaku-appearance-field">
          <div class="danmaku-appearance-label-row">
            <label for="danmakuGroupTag">${html('widgets.danmaku.groupTag', '群标签')}</label>
            <span class="danmaku-group-preview" aria-hidden="true"><span class="danmaku-group-tag" id="danmakuGroupPreview"></span></span>
          </div>
          <select id="danmakuGroupTag" name="groupTag" aria-describedby="danmakuGroupHint">
            <option value="">${html('widgets.danmaku.noGroup', '不显示')}</option>
            <option value="1">${html('widgets.danmaku.groupNumber', '{group}群', { group: 1 })}</option>
            <option value="2">${html('widgets.danmaku.groupNumber', '{group}群', { group: 2 })}</option>
            <option value="3">${html('widgets.danmaku.groupNumber', '{group}群', { group: 3 })}</option>
            <option value="4">${html('widgets.danmaku.groupNumber', '{group}群', { group: 4 })}</option>
            <option value="5">${html('widgets.danmaku.groupNumber', '{group}群', { group: 5 })}</option>
            <option value="6">${html('widgets.danmaku.groupNumber', '{group}群', { group: 6 })}</option>
            <option value="7">${html('widgets.danmaku.groupNumber', '{group}群', { group: 7 })}</option>
            <option value="8">${html('widgets.danmaku.groupNumber', '{group}群', { group: 8 })}</option>
          </select>
          <p class="danmaku-appearance-hint" id="danmakuGroupHint">${html('widgets.danmaku.groupHint', '自选标签，不代表群成员身份。')}</p>
        </div>
        <p class="danmaku-appearance-status" id="danmakuAppearanceStatus" role="status" aria-live="polite" aria-atomic="true"></p>
        <button class="danmaku-appearance-save" type="submit">${html('widgets.danmaku.save', '保存并关闭')}</button>
      </form>
      <button class="danmaku-guest" id="danmakuGuest" type="button" hidden>${html('widgets.danmaku.continueAsGuest', '以访客身份继续')}</button>
    </section>
    <section class="danmaku-history" id="danmakuHistory" aria-labelledby="danmakuHistoryTitle" data-open="false" hidden inert data-lenis-prevent>
      <header class="danmaku-history-head">
        <div class="danmaku-history-heading">
          <h2 id="danmakuHistoryTitle">${html('widgets.danmaku.history', '历史弹幕')}</h2>
          <p class="danmaku-history-moderation-hint"><span>${html('widgets.danmaku.rightClickMute', '右键禁言')}</span><span>${html('widgets.danmaku.longPressMute', '长按禁言')}</span></p>
        </div>
        <button class="danmaku-close danmaku-history-close" id="danmakuHistoryClose" type="button" aria-label="${html('widgets.danmaku.historyClose', '关闭历史弹幕')}"><svg class="ui-icon" aria-hidden="true" focusable="false"><use href="/assets/ui/fluent.svg#dismiss" /></svg></button>
      </header>
      <p class="danmaku-history-status" id="danmakuHistoryStatus" role="status" aria-live="polite" aria-atomic="true"></p>
      <ol class="danmaku-history-list" id="danmakuHistoryList" role="list" aria-label="${html('widgets.danmaku.recentList', '最近的弹幕')}" tabindex="0"></ol>
    </section>
  </section>
<div class="danmaku-layer" id="danmakuLayer" aria-hidden="true"></div>
<section class="danmaku-moderation" id="danmakuModeration" role="dialog" aria-labelledby="danmakuModerationTitle" hidden inert data-lenis-prevent>
  <header class="danmaku-composer-head">
    <h2 id="danmakuModerationTitle">${html('widgets.danmaku.banTitle', '封禁账号和设备')}</h2>
    <button class="danmaku-close" id="danmakuModerationClose" type="button" aria-label="${html('widgets.danmaku.moderationClose', '关闭弹幕管理')}"><svg class="ui-icon" aria-hidden="true"><use href="/assets/ui/fluent.svg#dismiss" /></svg></button>
  </header>
  <div class="danmaku-moderation-actions" id="danmakuModerationActions" hidden>
    <p class="danmaku-moderation-quote" id="danmakuModerationQuote"></p>
    <div class="danmaku-duration-options" role="group" aria-label="${html('widgets.danmaku.banDuration', '封禁时长')}">
      <button type="button" data-duration="10m" aria-pressed="false">${html('widgets.danmaku.durationMinutes', '{duration} 分钟', { duration: 10 })}</button>
      <button type="button" data-duration="30m" aria-pressed="false">${html('widgets.danmaku.durationMinutes', '{duration} 分钟', { duration: 30 })}</button>
      <button type="button" data-duration="24h" aria-pressed="false">${html('widgets.danmaku.durationHours', '{duration} 小时', { duration: 24 })}</button>
      <button type="button" data-duration="3d" aria-pressed="false">${html('widgets.danmaku.durationDays', '{duration} 天', { duration: 3 })}</button>
      <button type="button" data-duration="7d" aria-pressed="false">${html('widgets.danmaku.durationDays', '{duration} 天', { duration: 7 })}</button>
      <button type="button" data-duration="30d" aria-pressed="false">${html('widgets.danmaku.durationDays', '{duration} 天', { duration: 30 })}</button>
      <button type="button" data-duration="180d" aria-pressed="false">${html('widgets.danmaku.durationDays', '{duration} 天', { duration: 180 })}</button>
      <button type="button" data-duration="permanent" aria-pressed="false">${html('widgets.danmaku.permanentBan', '永久')}</button>
    </div>
    <div class="danmaku-duration-custom" role="group" aria-label="${html('widgets.danmaku.customDuration', '自定义时长')}">
      <label>${html('widgets.danmaku.customHours', '自定义小时')}
        <input type="number" inputmode="numeric" min="1" max="4320" step="1" placeholder="1–4320" data-duration-unit="h" aria-describedby="danmakuModerationStatus">
      </label>
      <label>${html('widgets.danmaku.customDays', '自定义天数')}
        <input type="number" inputmode="numeric" min="1" max="180" step="1" placeholder="1–180" data-duration-unit="d" aria-describedby="danmakuModerationStatus">
      </label>
    </div>
    <div class="danmaku-moderation-footer">
      <p class="danmaku-status" id="danmakuModerationStatus" role="status"></p>
      <button class="danmaku-confirm" id="danmakuModerationConfirm" type="button" disabled>${html('widgets.danmaku.confirm', '确认')}</button>
    </div>
  </div>
</section>
<p class="danmaku-notice" id="danmakuNotice" role="status" aria-live="polite" aria-atomic="true"></p>
<p class="sr-only danmaku-availability-notice" id="danmakuAvailabilityNotice" role="status"></p>
`;
  const widget = template.content.firstElementChild;
  mount.classList.add('floating-widget-dock');
  if (document.body.classList.contains('login-body')) mount.dataset.danmakuMount = 'manual';
  mount.prepend(widget);
  // Keep viewport overlays outside the dock's stacking context.
  document.body.append(template.content);
})();
