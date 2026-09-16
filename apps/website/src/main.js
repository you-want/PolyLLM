const tabs = document.querySelectorAll('[data-tab-target]')

for (const tab of tabs) {
  tab.addEventListener('click', () => {
    const selected = tab.dataset.tabTarget
    for (const item of tabs) {
      item.setAttribute('aria-selected', String(item === tab))
    }
    for (const panel of document.querySelectorAll('[data-tab-panel]')) {
      panel.hidden = panel.dataset.tabPanel !== selected
    }
  })
}

for (const button of document.querySelectorAll('[data-copy]')) {
  button.addEventListener('click', async () => {
    const command = button.previousElementSibling?.textContent?.trim() ?? ''
    try {
      await navigator.clipboard.writeText(command)
      const originalText = button.textContent
      button.textContent = '已复制'
      setTimeout(() => {
        button.textContent = originalText
      }, 1600)
    } catch {
      button.textContent = '复制失败'
    }
  })
}
