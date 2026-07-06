(function () {
  const selectMap = new WeakMap();
  const glyph = '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" focusable="false" aria-hidden="true"><path d="m8 11 4-6H4l4 6Z" class="filled stroke-linejoin-round"></path></svg>';

  function closeSelect(wrapper) {
    if (!wrapper?.classList.contains('open')) return;
    wrapper.classList.remove('open');
    wrapper.classList.add('closing');
    wrapper.querySelector('.lr-select-trigger')?.setAttribute('aria-expanded', 'false');
    window.setTimeout(() => wrapper.classList.remove('closing'), 160);
  }

  function closeAll(except) {
    document.querySelectorAll('.lr-select.open').forEach((wrapper) => {
      if (wrapper !== except) closeSelect(wrapper);
    });
  }

  function optionLabel(option) {
    return option?.textContent?.trim() || option?.value || '';
  }

  function syncSelect(select) {
    const state = selectMap.get(select);
    if (!state) return;

    const selected = select.selectedOptions?.[0] || select.options[select.selectedIndex] || select.options[0];
    state.label.textContent = optionLabel(selected);
    state.trigger.disabled = select.disabled;
    state.wrapper.classList.toggle('disabled', select.disabled);

    state.menu.querySelectorAll('.lr-select-option').forEach((button) => {
      button.classList.toggle('active', button.dataset.value === select.value);
      button.setAttribute('aria-selected', button.dataset.value === select.value ? 'true' : 'false');
    });
  }

  function renderOptions(select) {
    const state = selectMap.get(select);
    if (!state) return;

    state.menu.innerHTML = '';
    Array.from(select.options).forEach((option) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'lr-select-option';
      button.dataset.value = option.value;
      button.disabled = option.disabled;
      button.setAttribute('role', 'option');
      button.textContent = optionLabel(option);
      button.addEventListener('click', () => {
        if (option.disabled) return;
        select.value = option.value;
        select.dispatchEvent(new Event('input', { bubbles: true }));
        select.dispatchEvent(new Event('change', { bubbles: true }));
        syncSelect(select);
        closeSelect(state.wrapper);
      });
      state.menu.appendChild(button);
    });

    syncSelect(select);
  }

  function shouldBeFullWidth(select) {
    const classes = select.className || '';
    return classes.includes('w-full') || classes.includes('flex-grow') || select.parentElement?.className?.includes('grid');
  }

  function enhanceSelect(select) {
    if (!(select instanceof HTMLSelectElement) || select.multiple || select.dataset.customControl === 'false') return;
    if (selectMap.has(select)) {
      syncSelect(select);
      return;
    }

    const wrapper = document.createElement('div');
    wrapper.className = `lr-select${shouldBeFullWidth(select) ? ' lr-select-full' : ''}`;

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'lr-select-trigger';
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');

    const label = document.createElement('span');
    label.className = 'lr-select-label';

    const icon = document.createElement('span');
    icon.className = 'lr-select-icon';
    icon.innerHTML = glyph;

    const menu = document.createElement('div');
    menu.className = 'lr-select-menu';
    menu.setAttribute('role', 'listbox');

    trigger.append(label, icon);
    wrapper.append(trigger, menu);
    select.classList.add('lr-native-select');
    select.insertAdjacentElement('afterend', wrapper);

    selectMap.set(select, { wrapper, trigger, label, menu });
    renderOptions(select);

    trigger.addEventListener('click', () => {
      if (select.disabled) return;
      const willOpen = !wrapper.classList.contains('open');
      closeAll(wrapper);
      wrapper.classList.toggle('open', willOpen);
      trigger.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    });

    select.addEventListener('change', () => syncSelect(select));

    const observer = new MutationObserver(() => renderOptions(select));
    observer.observe(select, {
      attributes: true,
      attributeFilter: ['disabled'],
      childList: true,
      subtree: true,
    });
  }

  function enhanceControls(root = document) {
    root.querySelectorAll?.('select').forEach(enhanceSelect);
  }

  document.addEventListener('click', (event) => {
    if (!event.target.closest?.('.lr-select')) closeAll();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeAll();
  });

  const valueDescriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  if (valueDescriptor?.set && !HTMLSelectElement.prototype.__logriderValuePatched) {
    Object.defineProperty(HTMLSelectElement.prototype, 'value', {
      get: valueDescriptor.get,
      set(value) {
        valueDescriptor.set.call(this, value);
        queueMicrotask(() => syncSelect(this));
      },
    });
    Object.defineProperty(HTMLSelectElement.prototype, '__logriderValuePatched', { value: true });
  }

  window.refreshCustomControls = function () {
    enhanceControls(document);
    document.querySelectorAll('select').forEach(syncSelect);
  };

  document.addEventListener('DOMContentLoaded', () => {
    enhanceControls(document);
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === Node.ELEMENT_NODE) enhanceControls(node);
        });
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
})();
