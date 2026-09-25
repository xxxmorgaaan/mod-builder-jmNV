// public/js/main.js
(function () {
  // ---------------------------------------------------------------- мобильное меню
  const navToggle = document.getElementById('navToggle');
  const siteNav = document.getElementById('siteNav');
  const navIcon = document.getElementById('navToggleIcon');
  const navText = document.getElementById('navToggleText');
  if (navToggle && siteNav) {
    const setOpen = (open) => {
      siteNav.classList.toggle('is-open', open);
      navToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (navIcon) navIcon.textContent = open ? '✕' : '☰';
      if (navText) navText.textContent = open ? 'Закрыть' : 'Меню';
      // Пока меню открыто — страница под ним не скроллится, иначе легко
      // «потерять» само меню, прокрутив фон.
      document.body.style.overflow = open ? 'hidden' : '';
    };
    navToggle.addEventListener('click', () => setOpen(!siteNav.classList.contains('is-open')));
    siteNav.querySelectorAll('a').forEach(a => a.addEventListener('click', () => setOpen(false)));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setOpen(false); });
  }

  // ---------------------------------------------------------------- скрытый вход в админку: 5 кликов по подвалу
  const footerTrigger = document.getElementById('footerAdminTrigger');
  if (footerTrigger) {
    let clicks = 0; let timer = null;
    footerTrigger.addEventListener('click', () => {
      clicks++;
      clearTimeout(timer);
      timer = setTimeout(() => { clicks = 0; }, 1500);
      if (clicks >= 5) { clicks = 0; window.location.href = '/admin.html'; }
    });
  }

  // ---------------------------------------------------------------- лайтбокс галереи
  const gallery = document.querySelector('.gallery');
  if (gallery) {
    const lightbox = document.createElement('div');
    lightbox.className = 'lightbox';
    lightbox.innerHTML = '<button type="button" class="lightbox-close" aria-label="Закрыть">✕</button><img alt="">';
    document.body.appendChild(lightbox);
    const lbImg = lightbox.querySelector('img');
    gallery.querySelectorAll('img').forEach(img => {
      img.addEventListener('click', () => { lbImg.src = img.dataset.full || img.src; lightbox.classList.add('is-open'); });
    });
    lightbox.addEventListener('click', (e) => { if (e.target === lightbox || e.target.closest('.lightbox-close')) lightbox.classList.remove('is-open'); });
  }

  // ---------------------------------------------------------------- лайк (мод/сборка)
  document.querySelectorAll('[data-like-url]').forEach(btn => {
    btn.addEventListener('click', async () => {
      try {
        const res = await fetch(btn.dataset.likeUrl, { method: 'POST' });
        const data = await res.json();
        btn.querySelector('.like-count').textContent = data.likes;
        btn.classList.toggle('is-liked', data.liked);
      } catch (e) { /* тихо игнорируем — сеть могла моргнуть */ }
    });
  });

  // ---------------------------------------------------------------- запоминаем код управления в браузере
  const codeBox = document.querySelector('[data-remember-code]');
  if (codeBox) {
    try {
      const list = JSON.parse(localStorage.getItem('mb_codes') || '[]');
      const entry = { code: codeBox.dataset.rememberCode, name: codeBox.dataset.rememberName || '', when: Date.now() };
      if (!list.some(x => x.code === entry.code)) {
        list.unshift(entry);
        localStorage.setItem('mb_codes', JSON.stringify(list.slice(0, 30)));
      }
    } catch (e) { /* localStorage недоступен — ничего страшного, код и так показан на странице */ }
  }

  // ---------------------------------------------------------------- список «мои моды/сборки» на странице управления
  const myList = document.getElementById('myCodesList');
  if (myList) {
    try {
      const list = JSON.parse(localStorage.getItem('mb_codes') || '[]');
      if (list.length) {
        myList.innerHTML = list.map(x =>
          `<li><code>${x.code}</code>${x.name ? ' — ' + x.name : ''} <button type="button" class="btn btn-ghost btn-sm" data-use-code="${x.code}">Использовать</button></li>`
        ).join('');
        myList.querySelectorAll('[data-use-code]').forEach(b => b.addEventListener('click', () => {
          document.getElementById('codeInput').value = b.dataset.useCode;
        }));
      } else {
        myList.innerHTML = '<li class="hint">Пока пусто — коды появятся здесь сами после публикации.</li>';
      }
    } catch (e) { myList.innerHTML = ''; }
  }

  // ---------------------------------------------------------------- чат по жалобе (опрос раз в 7 сек)
  const chatBox = document.querySelector('[data-complaint-token]');
  if (chatBox) {
    const token = chatBox.dataset.complaintToken;
    const messagesEl = chatBox.querySelector('.chat-messages');
    const form = chatBox.querySelector('.chat-form');
    const textarea = form ? form.querySelector('textarea') : null;

    function renderMessages(messages) {
      messagesEl.innerHTML = messages.map(m =>
        `<div class="chat-msg ${m.sender}">${escapeHtml(m.body)}</div>`
      ).join('');
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
    function escapeHtml(s) {
      return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }
    async function poll() {
      try {
        const res = await fetch(`/api/complaints/${token}/messages`);
        const data = await res.json();
        renderMessages(data.messages || []);
      } catch (e) { /* следующий опрос попробует снова */ }
    }
    if (form && textarea) {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const body = textarea.value.trim();
        if (!body) return;
        textarea.value = '';
        await fetch(`/api/complaints/${token}/messages`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body }),
        });
        poll();
      });
    }
    poll();
    setInterval(poll, 7000);
  }
})();
