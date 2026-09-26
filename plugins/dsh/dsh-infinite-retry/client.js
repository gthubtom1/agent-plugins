/**
 * dsh-infinite-retry Browser UI Client
 * 
 * 在 DSH Desktop / Web 界面的「设置 → 通用设置」中注入「无尽重试」Switch 开关行。
 */
window.__ModuleLoader__.load({
  id: 'dsh-infinite-retry',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    var React = require('react');
    var h = React.createElement;
    var useState = React.useState;
    var useEffect = React.useEffect;
    var useCallback = React.useCallback;

    var API_URL = '/infinite-retry/api';

    var CSS = `
.dsh-ir-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 0;
  border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.08));
  gap: 16px;
}
.dsh-ir-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.dsh-ir-title {
  font-size: 14px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary, #ffffff);
  line-height: 22px;
}
.dsh-ir-desc {
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary, #999999);
  line-height: 18px;
}
.dsh-ir-switch {
  position: relative;
  width: 44px;
  height: 24px;
  border-radius: 12px;
  background: var(--dsw-alias-bg-module-platform, rgba(255, 255, 255, 0.15));
  cursor: pointer;
  border: none;
  padding: 2px;
  transition: background-color 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  outline: none;
  flex-shrink: 0;
  box-sizing: border-box;
}
.dsh-ir-switch[aria-checked="true"] {
  background: var(--dsw-alias-brand-primary, #10a37f);
}
.dsh-ir-thumb {
  display: block;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: #ffffff;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);
  transition: transform 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  transform: translateX(0);
}
.dsh-ir-switch[aria-checked="true"] .dsh-ir-thumb {
  transform: translateX(20px);
}
`;

    function InfiniteRetryRow() {
      var state = useState(true);
      var enabled = state[0];
      var setEnabled = state[1];

      var loadingState = useState(false);
      var loading = loadingState[0];
      var setLoading = loadingState[1];

      // 注入 CSS 样式
      useEffect(function () {
        if (typeof document === 'undefined') return;
        if (document.querySelector('style[data-dsh-infinite-retry="1"]')) return;
        var style = document.createElement('style');
        style.dataset.dshInfiniteRetry = '1';
        style.textContent = CSS;
        document.head.appendChild(style);
      }, []);

      // 获取初始状态
      useEffect(function () {
        var active = true;
        fetch(API_URL, { cache: 'no-store' })
          .then(function (res) { return res.json(); })
          .then(function (data) {
            if (active && data && typeof data.enabled === 'boolean') {
              setEnabled(data.enabled);
            }
          })
          .catch(function () {});
        return function () { active = false; };
      }, []);

      // 切换开关
      var onToggle = useCallback(function () {
        if (loading) return;
        var next = !enabled;
        setEnabled(next);
        setLoading(true);

        fetch(API_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled: next }),
          cache: 'no-store'
        })
          .then(function (res) { return res.json(); })
          .then(function (data) {
            if (data && typeof data.enabled === 'boolean') {
              setEnabled(data.enabled);
            }
          })
          .catch(function () {
            // 出错时回滚
            setEnabled(!next);
          })
          .finally(function () {
            setLoading(false);
          });
      }, [enabled, loading]);

      return h('div', { className: 'dsh-ir-row', 'data-dsh-infinite-retry': '1' },
        h('div', { className: 'dsh-ir-text' },
          h('div', { className: 'dsh-ir-title' }, '无尽重试（Retry until success）'),
          h('div', { className: 'dsh-ir-desc' }, '网络中断、超时或 429 限流时自动持续重试直到成功。关闭后恢复默认重试次数限制。')
        ),
        h('button', {
          type: 'button',
          className: 'dsh-ir-switch',
          role: 'switch',
          'aria-checked': enabled ? 'true' : 'false',
          'aria-label': '无尽重试开关',
          onClick: onToggle
        },
          h('span', { className: 'dsh-ir-thumb' })
        )
      );
    }

    function apply(ctx) {
      if (ctx.slots && typeof ctx.slots.inject === 'function') {
        ctx.slots.inject('settings.general.item', function () {
          return ctx.slots.register(
            {
              name: 'settings.general.item',
              id: 'infinite-retry',
              order: 20
            },
            InfiniteRetryRow
          );
        });
      }
    }

    module.exports = {
      name: 'dsh-infinite-retry',
      inject: ['slots'],
      apply: apply
    };

    return module.exports;
  }
});
